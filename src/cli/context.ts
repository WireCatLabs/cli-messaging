import type { Renderer, RenderFormat, Streams } from "@leemour/cli-core"
import type { Command } from "commander"
import { resolveOutput } from "../output.js"
import { type Closeable, withDeadline } from "./deadline.js"
import { rootOf } from "./profile.js"
import type { GlobalFlags, ResolveOptions, Settings } from "./settings.js"

/** What every CLI's commands write to, when it is not the real terminal. A CLI adds its own fields. */
export interface BaseEnvironment {
  streams?: Streams
  /** Whether a person is looking. Defaults to whether stdout is a terminal. */
  tty?: boolean
  env?: NodeJS.ProcessEnv
}

const environments = new WeakMap<Command, BaseEnvironment>()

export const provide = (program: Command, environment: BaseEnvironment): void => {
  environments.set(program, environment)
}

export const environmentOf = <E extends BaseEnvironment = BaseEnvironment>(command: Command): E =>
  (environments.get(rootOf(command)) ?? {}) as E

/** For the commands that print but never need settings or a connection. */
export const outputFor = (command: Command) => {
  const { streams, tty } = environmentOf(command)
  return resolveOutput({
    ...command.optsWithGlobals(),
    ...(streams ? { streams } : {}),
    ...(tty === undefined ? {} : { tty }),
  })
}

export interface BaseContext {
  settings: Settings
  renderer: Renderer
  format: RenderFormat
  /** Whether the human view may use colour — for views that print their own text. */
  color: boolean
  streams: Streams
  env: NodeJS.ProcessEnv
  /**
   * Runs the body inside `--timeout`, closing whatever was tracked when it expires. Whatever holds
   * the process open — a connection — must be tracked **before** it can block, or a timed-out
   * command reports the timeout and then hangs.
   */
  run: <T>(body: () => Promise<T>) => Promise<T>
  track: (closeable: Closeable) => void
}

type Resolve = (flags: GlobalFlags, options?: ResolveOptions) => Settings

/** Everything a command needs that no messenger decides, resolved once. */
export const baseContext = (command: Command, resolveSettings: Resolve): BaseContext => {
  const environment = environmentOf(command)
  const env = environment.env ?? process.env
  const settings = resolveSettings(command.optsWithGlobals<GlobalFlags>(), { env })
  const { renderer, format, color, streams } = resolveOutput({
    ...settings,
    ...(environment.streams ? { streams: environment.streams } : {}),
    ...(environment.tty === undefined ? {} : { tty: environment.tty }),
  })
  const closeables: Closeable[] = []

  return {
    settings,
    renderer,
    format,
    color,
    streams,
    env,
    run: (body) => withDeadline(settings.commandTimeoutMs, closeables, body),
    track: (closeable) => {
      closeables.push(closeable)
    },
  }
}
