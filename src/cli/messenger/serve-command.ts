import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@leemour/cli-core"
import { Command } from "commander"
import type { MessageEvent } from "../../domain/models.js"
import type { AppIdentity } from "../app.js"
import { type Messenger, messengerContext } from "./context.js"
import { alive } from "./processes.js"
import { listenUntilStopped } from "./watch-command.js"

export interface Lock {
  pid: number
  startedAt: string
  /** Set once the connection is open and updates arrive — before it, `serve` is still starting. */
  listeningAt?: string
  /** The CLI version this serve runs: after an update it goes on running the old code until restarted. */
  version?: string
}

export const lockPath = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv) =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "serve", `${profile}.lock`)

/** The profiles a serve is running for now — what an update must restart for its new code to run. */
export const servingProfiles = (app: AppIdentity, env: NodeJS.ProcessEnv): string[] => {
  const dir = dirname(lockPath(app, "default", env))
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".lock"))
    .map((name) => name.slice(0, -".lock".length))
    .filter((profile) => {
      const lock = readLock(lockPath(app, profile, env))
      return lock !== undefined && alive(lock.pid)
    })
}

export const readLock = (path: string): Lock | undefined => {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as Partial<Lock>
    return typeof lock.pid === "number" && typeof lock.startedAt === "string" ? (lock as Lock) : undefined
  } catch {
    return undefined
  }
}

/**
 * Keeps the store current: every new message, edit, deletion and reaction, and on start what arrived
 * while nothing listened. **One per profile**, held by a lock file; a lock whose process is gone is
 * taken over. Started by a person, a service unit or `server start` — never by itself (NEED-9).
 */
export const serveCommand = (messenger: Messenger): Command => {
  const command = new Command("serve").description(
    "keep the local store current until stopped — what a systemd or launchd unit runs",
  )

  command.action(async function (this: Command) {
    const context = messengerContext(this, messenger)
    if (context.settings.offline) throw new CliError("validation_error", "serve listens live; --offline cannot")
    const path = lockPath(messenger.app, context.profile, context.env)
    const held = readLock(path)
    if (held && held.pid !== process.pid && alive(held.pid)) {
      throw new CliError(
        "validation_error",
        `${messenger.app.command} serve is already running for profile ${context.profile} (PID ${held.pid}, since ${held.startedAt})`,
      )
    }
    const startedAt = new Date().toISOString()
    const hold = (lock: Lock) => writeSecurely(path, `${JSON.stringify(lock)}\n`, 0o600)
    const { version } = messenger.app
    hold({ pid: process.pid, startedAt, version })
    // `server start` answers on this, not on the lock alone: a lock is written before the connection opens.
    const onReady = () => {
      hold({ pid: process.pid, startedAt, version, listeningAt: new Date().toISOString() })
      context.renderer.note(`listening for profile ${context.profile}, catching up on what arrived while it was down`)
    }

    const counts: Record<string, number> = {}
    const count = (event: MessageEvent) => {
      counts[event.event] = (counts[event.event] ?? 0) + 1
    }
    try {
      await listenUntilStopped(this, context, messenger, count, {
        stop: new AbortController(),
        catchUp: true,
        onReady,
      })
    } finally {
      if (readLock(path)?.pid === process.pid) rmSync(path, { force: true })
    }
    context.renderer.result({ profile: context.profile, startedAt, stoppedAt: new Date().toISOString(), kept: counts })
  })

  return command
}
