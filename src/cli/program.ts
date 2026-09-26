import { exitCodeFor, GENERIC_FAILURE, processStreams, type Streams, visibleControls } from "@leemour/cli-core"
import { Command } from "commander"
import type { AppIdentity } from "./app.js"
import { type BaseEnvironment, provide } from "./context.js"
import { isCliFailure, isCommanderFailure } from "./failures.js"
import { commandWords, liftProfile } from "./profile.js"

export interface ProgramDefinition {
  app: AppIdentity
  /** One resource per command, one action per subcommand. Built fresh for every program. */
  commands: () => Command[]
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
export const createProgram = ({ app, commands }: ProgramDefinition, { out, err }: ProgramOptions = {}): Command => {
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
    .option("--record", "keep this run — ids and timings, never message content")
    .option("--no-record", "do not keep it, whatever the configuration says")
    .showHelpAfterError()

  for (const command of commands()) program.addCommand(command)

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
  provide(program, { ...options, streams })
  // Depth-first: a subcommand left with the default behaviour kills the process from inside a test.
  forEachCommand(program, (child) => child.exitOverride())

  // Before commander, not inside it: commander has no hook that runs before it decides which
  // subcommand it is looking at.
  const { profile, rest } = liftProfile(argv, commandWords(program))
  if (profile !== undefined) program.setOptionValue("profile", profile)

  // A bare word with nothing after it would make commander print help **on stdout**, which breaks
  // the one contract this program has and says nothing about why.
  if (profile !== undefined && rest.length === 0) {
    report(streams, options, {
      code: "validation_error",
      message:
        `"${profile}" is not a command, so it was read as a profile name — and no command followed it. ` +
        `Run \`${command} --help\` for the commands, or \`${command} ${profile} account show\` if "${profile}" is your profile.`,
    })
    return exitCodeFor("validation_error")
  }

  try {
    await program.parseAsync(rest, { from: "user" })
    return process.exitCode === undefined ? 0 : Number(process.exitCode)
  } catch (error) {
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
