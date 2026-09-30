import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
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
import { momentOf } from "./inbox.js"
import { stopOnSignal } from "./patience.js"

/**
 * A chat's history into the store, newest to oldest, **resumable**: after every page the stretch it
 * covered is recorded, so a stop — Ctrl-C, `--timeout`, `--max`, `--since`, a long FloodWait — loses
 * nothing, and the next run jumps over what is already held. Needs numeric message ids, which order
 * the chat.
 */
export const fetchCommand = (messenger: Messenger): Command =>
  new Command("fetch")
    .description("fetch a chat's history into the local store, newest first; run it again to continue")
    .argument("<chat>", messenger.chatArgument)
    .option("--max <n>", "at most this many messages in this run", wholeNumber, 1000)
    .option("--pause <duration>", "pause between pages, to stay under the provider's limits", "1s")
    .option("--since <time>", "stop once it reaches messages older than this: ISO 8601, or 2h / 1d ago")
    .option("--background", "run as a job that outlives this command; `store jobs show` follows it")
    .option(
      "--estimate",
      "only estimate how many messages, requests and minutes a full fetch would still take — from the store, no request",
    )
    .action(async function (this: Command, chat: string) {
      const { max, pause, since, background, estimate } = this.opts<{
        max: number
        pause: string
        since?: string
        background?: boolean
        estimate?: boolean
      }>()
      const pauseMs = parseDuration(pause, "--pause")
      const sinceMs = since === undefined ? undefined : momentOf(since)
      const context = messengerContext(this, messenger)
      if (estimate) {
        if (since !== undefined) {
          throw new CliError("validation_error", "--estimate prices a full fetch; --since does not narrow it")
        }
        const answer = await context.withServices((services) => services.archive.estimate(chat, { max, pauseMs }))
        context.renderer.result(answer)
        if (answer.missing === null) {
          context.renderer.note(
            `nothing held of this chat to measure by — \`${messenger.app.command} store fetch ${chat} --max 100\` gives the estimate something to go on`,
          )
        } else if (answer.missing > 0) context.renderer.note("an estimate: provider waits (FloodWait) come on top")
        return
      }
      if (background) {
        startJob(this, context, messenger, {
          chat,
          max,
          pause,
          ...(sinceMs === undefined ? {} : { since: new Date(sinceMs).toISOString() }),
        })
        return
      }
      const jobs = jobsDir(messenger.app, context.env)
      const jobId = context.env[envName(messenger.app, "BACKFILL_JOB")]
      const stop = stopOnSignal(this)
      try {
        const result = await context.withServices((services) =>
          services.archive.fetch(chat, {
            max,
            pauseMs,
            ...(sinceMs === undefined ? {} : { sinceMs }),
            note: context.renderer.note,
            stop: stop.signal,
            onPage: (progress) => {
              if (jobId) updateJob(jobs, jobId, { progress })
            },
          }),
        )
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

/** `store jobs`: the background runs `store fetch --background` started. */
export const jobsCommand = (messenger: Messenger): Command => {
  const command = new Command("jobs").description("background fetch jobs")

  command
    .command("list")
    .description("background fetch jobs, newest first")
    .action(function (this: Command) {
      const context = messengerContext(this, messenger)
      const jobs = listJobs(jobsDir(messenger.app, context.env)).filter((job) => job.profile === context.profile)
      context.renderer.stream(jobs.map(brief))
      if (jobs.length === 0) context.renderer.note("no background fetch jobs for this profile")
    })

  command
    .command("show")
    .description("one background job — the newest when none is named — and what the store now holds of its chat")
    .argument("[job]", "the job id `store fetch --background` printed")
    .action(async function (this: Command, id: string | undefined) {
      const context = messengerContext(this, messenger)
      const job = findJob(messenger, context, id)
      const chatId = job.progress?.chatId
      const held =
        chatId === undefined
          ? undefined
          : await context.withServices((services) => services.archive.held(chatId)).catch(() => undefined)
      context.renderer.result({ ...brief(job), ...(held ? { held } : {}), log: job.log })
    })

  command
    .command("cancel")
    .description("stop a running background job after its current page; a later fetch resumes where it stopped")
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
      id === undefined ? "no background fetch jobs for this profile" : `no fetch job ${id} for this profile`,
    )
  }
  return job
}

const startJob = (
  command: Command,
  context: MessengerContext,
  messenger: Messenger,
  { chat, max, pause, since }: { chat: string; max: number; pause: string; since?: string },
) => {
  const { app } = messenger
  const dir = jobsDir(app, context.env)
  const running = listJobs(dir).find(
    (job) => job.profile === context.profile && job.chat === chat && stateOf(job) === "running",
  )
  if (running) {
    throw new CliError(
      "validation_error",
      `job ${running.id} is already fetching ${chat} (PID ${running.pid}) — \`${app.command} store jobs show ${running.id}\``,
    )
  }
  const now = new Date()
  const id = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const log = join(dir, `${id}.log`)
  const { timeout } = command.optsWithGlobals<{ timeout?: string }>()
  const argv = [
    "store",
    "fetch",
    chat,
    "--max",
    String(max),
    "--pause",
    pause,
    ...(since === undefined ? [] : ["--since", since]),
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
  context.renderer.note(`started — \`${app.command} store jobs show ${id}\` follows it`)
}

const wholeNumber = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}
