import { processStreams, type RenderFormat, type Streams } from "@wirecat/cli-core"
import type { AppIdentity } from "../app.js"
import { isCliFailure } from "../failures.js"
import { type DiagnosticEvent, type EventSink, providerErrorKey, renderEvent } from "./events.js"
import { type Run, runsDirFor, startRun } from "./run.js"

export interface RecordingOptions {
  app: AppIdentity
  /** As typed, without the arguments: `chats list`. It names the run directory. */
  command: string
  profile: string
  record: boolean
  /** Keep the run if it fails, even though `record` is off. */
  keepFailed: boolean
  trace: boolean
  /** Diagnostics follow the data stream: text for a person, one JSON object per line otherwise. */
  format: RenderFormat
  streams?: Streams
  env?: NodeJS.ProcessEnv
  runsDir?: string
  keepDays?: number
  now?: () => Date
}

/**
 * Runs one command with the diagnostics turned on, and **finalizes on every path**.
 *
 * `--trace` shows each event as it happens and keeps nothing, `--record` keeps it and shows
 * nothing. It is a wrapper rather than three lines in each command because the failure it prevents
 * is the quiet one: a run directory left saying `running` because the command threw on the way out.
 */
export const recorded = async <T>(options: RecordingOptions, body: (events: EventSink) => Promise<T>): Promise<T> => {
  const recording = startRecording(options)
  try {
    const answer = await body(recording.events)
    await recording.succeed()
    return answer
  } catch (error) {
    await recording.fail(error)
    throw error
  }
}

export interface Recording {
  events: EventSink
  succeed: () => Promise<void>
  /** Marks the error as dealt with, so the program's last catch does not keep it a second time. */
  fail: (error: unknown) => Promise<void>
}

/** `recorded` in two halves, for a caller that starts a run before its command and ends it after (max-cli's `max bot`). */
export const startRecording = (options: RecordingOptions): Recording => {
  const streams = options.streams ?? processStreams
  const now = options.now ?? (() => new Date())

  const open = (extra: { startedAt?: Date } = {}): Run =>
    startRun({
      runsDir: options.runsDir ?? runsDirFor(options.app, options.env),
      command: options.command,
      profile: options.profile,
      cliVersion: options.app.version,
      // The operation has happened or is under way, and failing the command now invites a retry
      // that sends twice.
      onError: (error) => {
        const warning = `this run is not recorded past this point: ${error.message}`
        streams.diagnostic(options.format === "pretty" ? warning : JSON.stringify({ warning }))
      },
      ...(options.keepDays === undefined ? {} : { keepDays: options.keepDays }),
      now,
      ...extra,
    })

  const run = options.record ? open() : undefined
  // Unrecorded, the newest events are held until the outcome is known, so a failure can still be kept.
  const held: DiagnosticEvent[] | undefined = !run && options.keepFailed ? [] : undefined
  const startedAt = now()
  let requests = 0

  const events: EventSink = (event) => {
    if (event.event === "request") requests += 1
    if (options.trace) streams.diagnostic(options.format === "pretty" ? renderEvent(event) : JSON.stringify(event))
    run?.logger.info(event)
    if (held) {
      held.push(event)
      if (held.length > HELD_AT_MOST) held.shift()
    }
  }

  return {
    events,
    succeed: async () => {
      await run?.finish("success", { requests })
    },
    fail: async (error) => {
      const failed = run ?? (held ? keep(open({ startedAt }), held) : undefined)
      if (failed) {
        if (!isCliFailure(error)) failed.logger.info(crashOf(error))
        await failed.finish("failed", {
          requests,
          ...outcomeOf(error),
          ...(run ? {} : { keptBecauseFailed: true }),
        })
      }
      if (typeof error === "object" && error !== null) settled.add(error)
    },
  }
}

/** Failures a run already dealt with — kept, or not kept by the owner's choice. `run()`'s last catch skips them. */
const settled = new WeakSet<object>()

export const wasSettled = (error: unknown): boolean => typeof error === "object" && error !== null && settled.has(error)

const HELD_AT_MOST = 500

const keep = (run: Run, events: DiagnosticEvent[]): Run => {
  for (const event of events) run.logger.info(event)
  return run
}

const outcomeOf = (error: unknown): { errorCode: string; providerError?: string } => {
  if (!isCliFailure(error)) return { errorCode: "generic_failure" }
  const providerError = providerErrorKey(error.details?.providerError)
  return { errorCode: error.code, ...(providerError ? { providerError } : {}) }
}

/**
 * Where a crash happened, not what it said: the class and up to ten frames as `function file:line`,
 * paths cut to what follows `dist/` or `src/`. **Never `message`** — it can hold whatever the
 * failing line was handling.
 */
export const crashOf = (error: unknown): { event: "crash"; errorName: string; frames: string[] } => {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : ""
  const frames = stack
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, 10)
    .map((line) => {
      const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line)
      if (!match) return "?"
      const [, fn, path = "", lineNumber] = match
      const file = /(?:^|\/)(?:dist|src)\/(.+)$/.exec(path)?.[1] ?? path.split("/").at(-1)
      return `${fn ?? "<anonymous>"} ${file}:${lineNumber}`
    })
  return { event: "crash", errorName: error instanceof Error ? error.name : typeof error, frames }
}
