import { join } from "node:path"
import {
  CliError,
  exitCodeFor,
  GENERIC_FAILURE,
  processStreams,
  resolvePaths,
  type Streams,
  visibleControls,
} from "@leemour/cli-core"
import { skillHint } from "@leemour/cli-core/skill"
import { Command } from "commander"
import type { AppIdentity } from "./app.js"
import { type BaseEnvironment, provide } from "./context.js"
import { isCliFailure, isCommanderFailure } from "./failures.js"
import { commandWords, liftProfile } from "./profile.js"
import { recorded, wasSettled } from "./runs/recording.js"
import { type Configuration, settingsFor } from "./settings.js"

export interface ProgramDefinition {
  app: AppIdentity
  /** One resource per command, one action per subcommand. Built fresh for every program. */
  commands: () => Command[]
  /** The CLI's own settings, for keeping a failure that happened before its command could; plain ones without. */
  configuration?: Configuration
  configure?: (program: Command) => void
  prepare?: (program: Command, environment: RunOptions) => void | Promise<void>
  onFailure?: (error: unknown, program: Command) => void | Promise<void>
}

export interface ProgramOptions {
  /** Where `--version` and `--help` write. Injected so a test reads them instead of the terminal. */
  out?: (text: string) => void
  err?: (text: string) => void
}

/**
 * The command tree, built fresh on each call. Commander is global state by default —
 * `exitOverride` and the write hooks turn it into a value a test can drive.
 */
export const createProgram = (
  { app, commands, configure }: ProgramDefinition,
  { out, err }: ProgramOptions = {},
): Command => {
  const program = new Command()

  program
    .name(app.command)
    .usage("[profile] [options] <command>")
    .description(
      `${app.description}\n\n` +
        `The first word is the profile whenever it is not a command — \`${app.command} personal chats list\`.\n` +
        `\`${app.envPrefix}_PROFILE\` says the same thing for a whole shell session; without either it is \`default\`.`,
    )
    .version(app.version, "-V, --version")
    .option(
      "-v, --verbose",
      "more detail in what is shown: -v ids, -vv everything we know",
      (_, level: number) => level + 1,
      0,
    )
    .option("--json", "machine-readable output: one JSON value on stdout, nothing else")
    .option("--jsonl", "machine-readable output: one JSON object per line, for streaming and jq")
    .option("--quiet", "diagnostics off; a failure is still said")
    .option("--trace", "the connection's own log lines on stderr — never message content")
    .option("--timeout <duration>", "give up on the whole command after this — 30s, 2m, 500ms")
    .option("--offline", "answer from what was recorded and never connect; fails if nothing was")
    .option("--yes", "go ahead without the question an ask level puts before a write")
    .option("--record", "keep this run — ids and timings, never message content")
    .option("--no-record", "do not keep it, whatever the configuration says")
    .showHelpAfterError()

  for (const command of commands()) program.addCommand(command)
  configure?.(program)

  // Depth-first: Commander does not pass `configureOutput` down to a command added with
  // `addCommand`, so `tg messages --help` would write to the real terminal.
  if (out || err) {
    forEachCommand(program, (command) =>
      command.configureOutput({ writeOut: (text) => out?.(text), writeErr: (text) => err?.(text) }),
    )
  }
  return program
}

const forEachCommand = (command: Command, apply: (command: Command) => void): void => {
  apply(command)
  for (const child of command.commands) forEachCommand(child, apply)
}

export type RunOptions = BaseEnvironment & Record<string, unknown>

/**
 * Runs the program and **returns an exit code instead of throwing**. A stack trace is not an error
 * message: it tells a script nothing it can branch on, and exits 1 for every kind of failure alike.
 */
export const run = async (argv: string[], definition: ProgramDefinition, options: RunOptions = {}): Promise<number> => {
  const streams = options.streams ?? processStreams
  const { command } = definition.app
  const program = createProgram(definition, {
    out: (text) => streams.data(text.replace(/\n$/, "")),
    err: (text) => streams.diagnostic(text.replace(/\n$/, "")),
  })
  const environment = { ...options, streams, app: definition.app }
  provide(program, environment)
  // Depth-first: a subcommand left with the default behaviour kills the process from inside a test.
  forEachCommand(program, (child) => child.exitOverride())

  // Before commander, not inside it: commander has no hook that runs before it decides which
  // subcommand it is looking at.
  const { profile, rest } = liftProfile(argv, commandWords(program))
  if (profile !== undefined) program.setOptionValue("profile", profile)

  // A bare word with nothing after it would make commander print help **on stdout**, which breaks
  // the one contract this program has and says nothing about why.
  if (profile !== undefined && rest.length === 0) {
    const message =
      `"${profile}" is not a command, so it was read as a profile name — and no command followed it. ` +
      `Run \`${command} --help\` for the commands, or \`${command} ${profile} account show\` if "${profile}" is your profile.`
    report(streams, options, { code: "validation_error", message })
    const failure = new CliError("validation_error", message)
    await settleFailure(failure, { definition, program, rest, profile, options })
    return exitCodeFor("validation_error")
  }

  try {
    await definition.prepare?.(program, environment)
    await program.parseAsync(rest, { from: "user" })
    const code = process.exitCode === undefined ? 0 : Number(process.exitCode)
    const hint = code === 0 && !rest.includes("--quiet") ? hintFor(definition, rest, options) : undefined
    if (hint) streams.diagnostic(hint)
    return code
  } catch (error) {
    if (!isCommanderFailure(error) || error.exitCode !== 0) {
      const failure = isCommanderFailure(error) ? new CliError("validation_error", error.message) : error
      await settleFailure(failure, { definition, program, rest, profile, options })
    }
    if (isCommanderFailure(error)) {
      if (profile !== undefined && error.code === "commander.unknownCommand") {
        streams.diagnostic(
          `"${profile}" is not a command, so it was read as a profile name — which left "${rest[0]}" to be one.`,
        )
      }
      return error.exitCode
    }
    if (isCliFailure(error)) {
      report(streams, options, { code: error.code, message: error.message, ...error.details })
      return exitCodeFor(error.code)
    }
    report(streams, options, {
      code: "generic_failure",
      message: error instanceof Error ? error.message : String(error),
    })
    return GENERIC_FAILURE
  }
}

/** The update notice's state file, so both daily lines share one file per CLI. */
const hintFor = ({ app, configuration }: ProgramDefinition, argv: string[], options: RunOptions) => {
  const env = options.env ?? process.env
  let enabled: boolean
  try {
    enabled = (configuration ?? settingsFor(app)).resolveSettings({}, { env }).skillHint
  } catch {
    return undefined
  }
  const statePath = join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "update-check.json")
  return skillHint({ app, argv, env, statePath, enabled })
}

interface Failed {
  definition: ProgramDefinition
  program: Command
  rest: string[]
  profile: string | undefined
  options: RunOptions
}

const settleFailure = async (failure: unknown, state: Failed): Promise<void> => {
  try {
    await state.definition.onFailure?.(failure, state.program)
  } catch {
    const streams = state.options.streams ?? processStreams
    streams.diagnostic("could not finish the command's failure handler")
  }
  await keepFailure(failure, state)
}

/**
 * **Every failure is kept as a run** — a usage error, a configuration that will not load, a command
 * that never opens a run — unless recording was turned off. One its own run already kept is skipped.
 * Only the command's words are named, never its arguments: those can be a message.
 */
const keepFailure = async (
  failure: unknown,
  { definition, program, rest, profile, options }: Failed,
): Promise<void> => {
  if (wasSettled(failure)) return
  const env = options.env ?? process.env
  const { resolveSettings } = definition.configuration ?? settingsFor(definition.app)
  let settings: ReturnType<typeof resolveSettings> | undefined
  try {
    settings = resolveSettings({ ...program.opts(), ...(profile === undefined ? {} : { profile }) }, { env })
  } catch {
    // A configuration that will not load is a failure worth keeping too; the flags are all there is to go on.
  }
  await recorded(
    {
      app: definition.app,
      command: commandPath(program, rest) || definition.app.command,
      profile: settings?.profile ?? profile ?? "default",
      record: false,
      keepFailed: settings?.keepFailedRuns ?? !rest.includes("--no-record"),
      trace: false,
      format: "json",
      streams: options.streams ?? processStreams,
      env,
      ...(settings ? { keepDays: settings.keepRunsForDays } : {}),
    },
    async () => {
      throw failure
    },
  ).catch(() => {})
}

/** `messages list` from `messages list 111 --limit 5`: the words that name commands, up to the first that does not. */
const commandPath = (program: Command, rest: string[]): string => {
  const words: string[] = []
  let current = program
  for (const token of rest) {
    if (token.startsWith("-")) continue
    const next = current.commands.find((one) => one.name() === token || one.aliases().includes(token))
    if (!next) break
    words.push(token)
    current = next
  }
  return words.join(" ")
}

interface ReportedError {
  code: string
  message: string
  [detail: string]: unknown
}

/**
 * **A failure never reaches stdout.** It goes to stderr — as JSON when nobody is watching, because
 * an exit code says which kind of thing went wrong and nothing about which chat or how long to wait.
 */
const report = (streams: Streams, options: BaseEnvironment, error: ReportedError): void => {
  const interactive = options.tty ?? process.stdout.isTTY === true
  streams.diagnostic(interactive ? `✗ ${visibleControls(error.message)}` : JSON.stringify({ error }))
}
