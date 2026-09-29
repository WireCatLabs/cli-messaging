import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import type { Id } from "../../domain/models.js"
import { type AccountKey, type MessageStore, openStore, type Range } from "../../store/store.js"
import { envName } from "../app.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { isCliFailure } from "../failures.js"
import { parseDuration } from "../settings.js"
import {
  type Job,
  jobsDir,
  listJobs,
  readJob,
  type SpawnJob,
  saveJob,
  spawnDetached,
  stateOf,
  updateJob,
} from "./backfill-jobs.js"
import { type Messenger, type MessengerContext, messengerContext } from "./context.js"
import type { MessengerAdapter } from "./port.js"

/** The most messages a provider hands out per history request — Telegram's cap. */
const PAGE = 100
/** Waits longer than this are not sat out: the run stops, and the next one resumes. */
const LONGEST_WAIT_MS = 5 * 60 * 1000

/**
 * A chat's history into the store, newest to oldest, **resumable**: after every page the stretch it
 * covered is recorded, so a stop — Ctrl-C, `--timeout`, `--max`, a long FloodWait — loses nothing,
 * and the next run jumps over what is already held. Needs numeric message ids, which order the chat.
 */
export const backfillCommand = (messenger: Messenger): Command => {
  const command = new Command("backfill")
    .description("fetch a chat's history into the local store, newest first; run it again to continue")
    .argument("<chat>", messenger.chatArgument)
    .option("--max <n>", "at most this many messages in this run", wholeNumber, 1000)
    .option("--pace <duration>", "pause between pages, to stay under the provider's limits", "1s")
    .option("--background", "run as a job that outlives this command; `backfill status` follows it")
    .action(async function (this: Command, chat: string) {
      const { max, pace, background } = this.opts<{ max: number; pace: string; background?: boolean }>()
      const pauseMs = parseDuration(pace, "--pace")
      const context = messengerContext(this, messenger)
      if (background) {
        startJob(this, context, messenger, { chat, max, pace })
        return
      }
      const jobs = jobsDir(messenger.app, context.env)
      const jobId = context.env[envName(messenger.app, "BACKFILL_JOB")]
      const stop = stopOnSignal(this)
      try {
        const result = await context.withMessenger(async (connection) => {
          const self = connection.self()
          if (self === null) throw new CliError("authentication_error", "not logged in — nothing to backfill for")
          const store = await openStore({ env: context.env })
          try {
            return await walk(connection, store, { provider: messenger.provider, account: self }, chat, {
              max,
              pauseMs,
              note: context.renderer.note,
              stop: stop.signal,
              onPage: (progress) => {
                if (jobId) updateJob(jobs, jobId, { progress })
              },
            })
          } finally {
            store.close()
          }
        })
        if (jobId) updateJob(jobs, jobId, { finishedAt: new Date().toISOString(), result })
        context.renderer.result(result)
      } catch (error) {
        if (jobId) {
          const code = isCliFailure(error) ? error.code : "generic_failure"
          const message = error instanceof Error ? error.message : String(error)
          updateJob(jobs, jobId, { finishedAt: new Date().toISOString(), error: { code, message } })
        }
        throw error
      } finally {
        stop.release()
      }
    })

  command
    .command("list")
    .description("background backfill jobs, newest first")
    .action(function (this: Command) {
      const context = messengerContext(this, messenger)
      const jobs = listJobs(jobsDir(messenger.app, context.env)).filter((job) => job.profile === context.profile)
      context.renderer.stream(jobs.map(brief))
      if (jobs.length === 0) context.renderer.note("no background backfill jobs for this profile")
    })

  command
    .command("status")
    .description("one background job — the newest when none is named — and what the store now holds of its chat")
    .argument("[job]", "the job id `backfill --background` printed")
    .action(async function (this: Command, id: string | undefined) {
      const context = messengerContext(this, messenger)
      const job = findJob(messenger, context, id)
      const chatId = job.progress?.chatId
      const held =
        chatId === undefined
          ? undefined
          : await context.withStore((store, account) => store.ranges(account, chatId)).catch(() => undefined)
      context.renderer.result({ ...brief(job), ...(held ? { held } : {}), log: job.log })
    })

  command
    .command("cancel")
    .description("stop a running background job after its current page; a later backfill resumes where it stopped")
    .argument("<job>", "the job id")
    .action(function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      const job = findJob(messenger, context, id)
      if (stateOf(job) !== "running") {
        throw new CliError("validation_error", `job ${job.id} is not running — it is ${stateOf(job)}`)
      }
      updateJob(jobsDir(messenger.app, context.env), job.id, { cancelRequestedAt: new Date().toISOString() })
      process.kill(job.pid, "SIGTERM")
      context.renderer.result({ job: job.id, cancelled: true })
    })

  return command
}

const brief = (job: Job) => ({
  job: job.id,
  chat: job.chat,
  state: stateOf(job),
  pid: job.pid,
  startedAt: job.startedAt,
  ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
  fetched: Number(job.result?.fetched ?? job.progress?.fetched ?? 0),
  max: job.max,
  ...(job.result ? { complete: job.result.complete === true } : {}),
  ...(job.error ? { error: job.error } : {}),
})

const findJob = (messenger: Messenger, context: MessengerContext, id: string | undefined): Job => {
  const dir = jobsDir(messenger.app, context.env)
  const job = id === undefined ? listJobs(dir).find((each) => each.profile === context.profile) : readJob(dir, id)
  if (!job || job.profile !== context.profile) {
    throw new CliError(
      "not_found",
      id === undefined ? "no background backfill jobs for this profile" : `no backfill job ${id} for this profile`,
    )
  }
  return job
}

const startJob = (
  command: Command,
  context: MessengerContext,
  messenger: Messenger,
  { chat, max, pace }: { chat: string; max: number; pace: string },
) => {
  const { app } = messenger
  const dir = jobsDir(app, context.env)
  const running = listJobs(dir).find(
    (job) => job.profile === context.profile && job.chat === chat && stateOf(job) === "running",
  )
  if (running) {
    throw new CliError(
      "validation_error",
      `job ${running.id} is already backfilling ${chat} (PID ${running.pid}) — \`${app.command} backfill status ${running.id}\``,
    )
  }
  const now = new Date()
  const id = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const log = join(dir, `${id}.log`)
  const { timeout } = command.optsWithGlobals<{ timeout?: string }>()
  const argv = [
    "backfill",
    chat,
    "--max",
    String(max),
    "--pace",
    pace,
    "--json",
    ...(timeout ? ["--timeout", timeout] : []),
  ]
  // A shell's --timeout default would cut a job short that was asked to outlive the shell.
  const { [envName(app, "TIMEOUT")]: _timeout, ...inherited } = context.env
  const env = { ...inherited, [envName(app, "PROFILE")]: context.profile, [envName(app, "BACKFILL_JOB")]: id }
  const job: Job = { id, chat, profile: context.profile, pid: 0, startedAt: now.toISOString(), max, log }
  saveJob(dir, job)
  const spawnJob = environmentOf<BaseEnvironment & { spawnJob?: SpawnJob }>(command).spawnJob ?? spawnDetached
  const pid = spawnJob(argv, env, log)
  saveJob(dir, { ...job, pid })
  context.renderer.result({ job: id, pid, chat, log })
  context.renderer.note(`started — \`${app.command} backfill status ${id}\` follows it`)
}

/** Ctrl-C and SIGTERM — which `backfill cancel` sends — end the run after the page in hand. */
const stopOnSignal = (command: Command) => {
  const stop = new AbortController()
  const given = environmentOf(command).signal
  const end = () => stop.abort()
  given?.addEventListener("abort", end, { once: true })
  const signals = given ? [] : (["SIGINT", "SIGTERM"] as const)
  for (const name of signals) process.once(name, end)
  return {
    signal: stop.signal,
    release: () => {
      for (const name of signals) process.off(name, end)
      given?.removeEventListener("abort", end)
    },
  }
}

interface Walk {
  max: number
  pauseMs: number
  note: (message: string) => void
  stop: AbortSignal
  onPage: (progress: { fetched: number; chatId: string; oldest: number }) => void
}

const walk = async (
  connection: MessengerAdapter,
  store: MessageStore,
  account: AccountKey,
  chat: string,
  { max, pauseMs, note, stop, onPage }: Walk,
) => {
  let before: string | undefined
  let chatId: Id | undefined
  let top: number | undefined
  let fetched = 0
  let reachedStart = false

  while (fetched < max && !stop.aborted) {
    const page = await patiently(
      () => connection.history(chat, { limit: PAGE, ...(before ? { before } : {}) }),
      note,
      stop,
    )
    const first = page.items[0]
    if (!first) {
      reachedStart = true
      break
    }
    chatId ??= first.chatId
    const keys = page.items.map((message) => Number(message.id))
    if (keys.some((key) => !Number.isSafeInteger(key))) {
      throw new CliError("validation_error", "this messenger's message ids do not order a chat, so it cannot backfill")
    }
    const low = Math.min(...keys)
    top ??= Math.max(...keys)
    fetched += page.items.length
    // This run's pages are contiguous, so everything from `low` to its first message is held.
    const held: Range = store.markRange(account, chatId, low, top)
    onPage({ fetched, chatId, oldest: held.from })
    if (!page.hasMore) {
      reachedStart = true
      break
    }
    before = String(held.from)
    note(`${fetched} messages so far, back to ${held.from}`)
    await sleep(pauseMs, undefined, { signal: stop }).catch(() => {})
  }

  const ranges = chatId === undefined ? [] : store.ranges(account, chatId)
  return {
    chat: chatId ?? null,
    fetched,
    complete: reachedStart && ranges.length === 1,
    ranges,
    ...(stop.aborted ? { stopped: true } : {}),
  }
}

/** Sits out a provider's "wait N seconds" when it is short, a few times; a long one ends the run. */
const patiently = async <T>(
  request: () => Promise<T>,
  note: (message: string) => void,
  stop: AbortSignal,
): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request()
    } catch (error) {
      const wait = isCliFailure(error) && error.code === "rate_limited" ? Number(error.details?.retryAfterMs) : NaN
      if (!Number.isFinite(wait) || wait > LONGEST_WAIT_MS || attempt >= 3) throw error
      note(`asked to wait ${Math.ceil(wait / 1000)} s — waiting, then going on`)
      await sleep(wait, undefined, { signal: stop }).catch(() => {})
      if (stop.aborted) throw error
    }
  }
}

const wholeNumber = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}
