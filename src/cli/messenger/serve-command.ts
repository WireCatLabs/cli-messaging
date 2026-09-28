import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@leemour/cli-core"
import { Command } from "commander"
import type { MessageEvent } from "../../domain/models.js"
import type { AppIdentity } from "../app.js"
import { type Messenger, messengerContext } from "./context.js"
import { listenUntilStopped } from "./watch-command.js"

interface Lock {
  pid: number
  startedAt: string
}

const lockPath = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv) =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "serve", `${profile}.lock`)

const readLock = (path: string): Lock | undefined => {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as Partial<Lock>
    return typeof lock.pid === "number" && typeof lock.startedAt === "string" ? (lock as Lock) : undefined
  } catch {
    return undefined
  }
}

/** Signal 0 checks that the process exists without touching it. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Keeps the store current: every new message, edit, deletion and reaction, and on start what arrived
 * while nothing listened. **One per profile**, held by a lock file; a lock whose process is gone is
 * taken over. Started by a person or a service unit — no command starts it (NEED-9).
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
    writeSecurely(path, `${JSON.stringify({ pid: process.pid, startedAt })}\n`, 0o600)

    const counts: Record<string, number> = {}
    const count = (event: MessageEvent) => {
      counts[event.event] = (counts[event.event] ?? 0) + 1
    }
    try {
      await listenUntilStopped(this, context, messenger, count, { stop: new AbortController(), catchUp: true })
    } finally {
      if (readLock(path)?.pid === process.pid) rmSync(path, { force: true })
    }
    context.renderer.result({ profile: context.profile, startedAt, stoppedAt: new Date().toISOString(), kept: counts })
  })

  command
    .command("status")
    .description("whether a serve is running for this profile, and since when")
    .action(function (this: Command) {
      const { profile, env, renderer } = messengerContext(this, messenger)
      const lock = readLock(lockPath(messenger.app, profile, env))
      const running = lock !== undefined && alive(lock.pid)
      renderer.result({ profile, running, ...(running && lock ? { pid: lock.pid, since: lock.startedAt } : {}) })
    })

  return command
}
