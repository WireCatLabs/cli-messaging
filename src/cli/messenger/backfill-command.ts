import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { FETCHING } from "../../services/archive.js"
import { momentOf } from "../../services/moment.js"
import { envName } from "../app.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { isCliFailure } from "../failures.js"
import { renderList } from "../paging.js"
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
import { stopOnSignal } from "./patience.js"

/**
 * A chat's history into the store, newest to oldest, **resumable**: after every page the stretch it
 * covered is recorded, so a stop — Ctrl-C, `--timeout`, `--limit`, `--since-time`, `--last`, a long FloodWait — loses
 * nothing, and the next run jumps over what is already held. Needs numeric message ids, which order
 * the chat.
 */
export const fetchCommand = (messenger: Messenger): Command => {
  const fetching = messenger.fetching ?? FETCHING
  return new Command("fetch")
    .description("fetch a chat's history into the local store, newest first; run it again to continue")
    .argument("<chat>", messenger.chatArgument)
    .option(
      "--limit <n>",
      `at most this many messages in this run; ${fetching.maxPages * fetching.page} if not given`,
      wholeNumber,
    )
    .option("--page-size <n>", `how many messages one request asks for; ${fetching.page} if not given`, wholeNumber)
    .option(
      "--pause <duration>",
      fetching.jitter
        ? "the least pause between pages, to stay under the provider's limits; each is up to twice that"
        : "pause between pages, to stay under the provider's limits",
      fetching.pause,
    )
    .option("--since-time <time>", "stop once it reaches messages older than this: ISO 8601, or 2h / 1d ago")
    .option("--last <n>", "stop once the newest n messages are held", wholeNumber)
    .option("--background", "run as a job that outlives this command; `store jobs show` follows it")
    .option(
      "--estimate",
      "only estimate how many messages, requests and minutes a full fetch would still take — from the store, no request",
    )
    .action(async function (this: Command, chat: string) {
      const {
        pause,
        sinceTime: since,
        last,
        background,
        estimate,
        ...sizes
      } = this.opts<{
        limit?: number
        pageSize?: number
        pause: string
        sinceTime?: string
        last?: number
        background?: boolean
        estimate?: boolean
      }>()
      if (since !== undefined && last !== undefined) {
        throw new CliError("validation_error", "give --since-time or --last, not both: how far back the fetch goes")
      }
      const pageSize = sizes.pageSize ?? fetching.page
      const limit = sizes.limit ?? fetching.maxPages * fetching.page
      const pauseMs = parseDuration(pause, "--pause")
      const sinceMs = since === undefined ? undefined : momentOf(since, "--since-time")
      const context = messengerContext(this, messenger)
      if (estimate) {
        if (since !== undefined || last !== undefined) {
          throw new CliError(
            "validation_error",
            "--estimate prices a full fetch; --since-time and --last do not narrow it",
          )
        }
        const answer = await context.withServices((services) =>
          services.archive.estimate(chat, { limit, pageSize, pauseMs }),
        )
        context.renderer.result(answer)
        if (answer.missing === null) {
          context.renderer.note(
            `nothing held of this chat to measure by — \`${messenger.app.command} store fetch ${chat} --limit ${pageSize}\` gives the estimate something to go on`,
          )
        } else if (answer.missing > 0) context.renderer.note("an estimate: provider waits (FloodWait) come on top")
        return
      }
      if (background) {
        startJob(this, context, messenger, {
          chat,
          limit,
          pageSize,
          pause,
          ...(last === undefined ? {} : { last }),
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
            limit,
            pageSize,
            pauseMs,
            ...(sinceMs === undefined ? {} : { sinceMs }),
            ...(last === undefined ? {} : { last }),
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
}

/** `store jobs`: the background runs `store fetch --background` started. */
export const jobsCommand = (messenger: Messenger): Command => {
  const command = new Command("jobs").description("background fetch jobs")

  command
    .command("list")
    .description("background fetch jobs, newest first")
    .action(function (this: Command) {
      const context = messengerContext(this, messenger)
      const jobs = listJobs(jobsDir(messenger.app, context.env)).filter((job) => job.profile === context.profile)
      renderList(context.renderer, context.format, jobs.map(brief))
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
  ...(job.limit === undefined ? {} : { limit: job.limit }),
  ...(job.pageSize === undefined ? {} : { pageSize: job.pageSize }),
  ...(job.last === undefined ? {} : { last: job.last }),
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
  {
    chat,
    limit,
    pageSize,
    pause,
    since,
    last,
  }: { chat: string; limit: number; pageSize: number; pause: string; since?: string; last?: number },
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
    "--limit",
    String(limit),
    "--page-size",
    String(pageSize),
    "--pause",
    pause,
    ...(since === undefined ? [] : ["--since-time", since]),
    ...(last === undefined ? [] : ["--last", String(last)]),
    "--json",
    ...(timeout ? ["--timeout", timeout] : []),
  ]
  // A shell's --timeout default would cut a job short that was asked to outlive the shell.
  const { [envName(app, "TIMEOUT")]: _timeout, ...inherited } = context.env
  const env = { ...inherited, [envName(app, "PROFILE")]: context.profile, [envName(app, "BACKFILL_JOB")]: id }
  const job: Job = {
    id,
    chat,
    profile: context.profile,
    pid: 0,
    startedAt: now.toISOString(),
    limit,
    pageSize,
    ...(last === undefined ? {} : { last }),
    log,
  }
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
