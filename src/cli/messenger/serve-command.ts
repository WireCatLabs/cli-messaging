import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { holdLock, lockPath, readLock, releaseLock } from "../../background/lock.js"
import { alive } from "../../background/processes.js"
import type { MessageEvent } from "../../domain/models.js"
import { type Messenger, messengerContext } from "./context.js"
import { listenUntilStopped } from "./watch-command.js"

export { type Lock, lockPath, readLock, servingProfiles } from "../../background/lock.js"

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
    const { version } = messenger.app
    holdLock(path, { pid: process.pid, startedAt, version })
    // `server start` answers on this, not on the lock alone: a lock is written before the connection opens.
    const onReady = () => {
      holdLock(path, { pid: process.pid, startedAt, version, listeningAt: new Date().toISOString() })
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
      releaseLock(path)
    }
    context.renderer.result({ profile: context.profile, startedAt, stoppedAt: new Date().toISOString(), kept: counts })
  })

  return command
}
