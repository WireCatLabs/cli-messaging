import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@leemour/cli-core"
import { Command } from "commander"
import { type Lock, lockPath, readLock } from "../../background/lock.js"
import { alive, carries } from "../../background/processes.js"
import { type ServerSystem, thisMachine } from "../../background/system.js"
import { locationVariables, platformFor, tail, type Unit } from "../../background/units.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { listed } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

export type { Ran, ServerSystem } from "../../background/system.js"

/** How many looks, a pause apart, `start` gives `serve` to connect — about 30 seconds on a real machine. */
const LOOKS = 120

type By = "unit" | "server" | "hand"

/** A person reads paths under their home as `~/…`. */
const tilde = (path: string, env: NodeJS.ProcessEnv) =>
  env.HOME && path.startsWith(`${env.HOME}/`) ? `~${path.slice(env.HOME.length)}` : path

/** Local time, and the date too when it is not today. */
const clock = (iso: string) => {
  const when = new Date(iso)
  const time = when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  return when.toDateString() === new Date().toDateString() ? time : `${when.toLocaleDateString("sv-SE")} ${time}`
}

/**
 * `serve` in the background, the way max-cli's `server` is: `start`, `stop`, `restart`, `status`,
 * `logs`. Without a unit, `start` runs `serve` as a process of its own; with one — `install`, a
 * systemd user unit or a launchd agent — it goes through systemd or launchd. **Nothing starts until
 * `start` is typed** (NEED-9): `install` only writes the file.
 */
export const serverCommand = (messenger: Messenger): Command => {
  const { app } = messenger
  const command = new Command("server").description(
    `\`${app.command} serve\` in the background: start, stop, restart, status, logs; install adds a systemd or launchd unit`,
  )
  const marker = (profile: string) => `${app.envPrefix}_SERVER=${profile}`

  const prepare = (self: Command) => {
    const context = messengerContext(self, messenger)
    const system = environmentOf<BaseEnvironment & { system?: ServerSystem }>(self).system ?? thisMachine()
    const platform = platformFor(app, system, context.env)
    const state = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env: context.env }).state
    const unit = platform.unit({
      profile: context.profile,
      command: [...system.entry, "serve"],
      environment: { [`${app.envPrefix}_PROFILE`]: context.profile, ...locationVariables(app, context.env) },
      logPath: join(state, "serve", `${context.profile}.log`),
    })
    const each = async (argvs: string[][]) => {
      for (const argv of argvs) {
        const ran = await system.run(argv, context.env)
        if (ran.code !== 0) throw new CliError("configuration_error", `${argv.join(" ")} failed: ${ran.stderr.trim()}`)
      }
    }
    const lock = () => {
      const held = readLock(lockPath(app, unit.profile, context.env))
      return held && alive(held.pid) ? held : undefined
    }
    const say = (value: object, lines: string[]) => {
      if (context.format === "pretty") context.streams.data(lines.join("\n"))
      else context.renderer.result(value)
    }
    return { context, system, platform, unit, each, lock, say }
  }
  type Prepared = ReturnType<typeof prepare>

  const installed = (unit: Unit) => {
    if (!existsSync(unit.path)) {
      throw new CliError(
        "not_found",
        `no unit for profile ${unit.profile} — \`${app.command} server install\` writes it`,
      )
    }
  }

  const byOf = async ({ platform, unit }: Prepared, held: Lock): Promise<By> => {
    if (existsSync(unit.path) && (await platform.state(unit)).pid === held.pid) return "unit"
    return carries(held.pid, marker(unit.profile)) ? "server" : "hand"
  }

  const how = (by: By, unit: Unit) =>
    by === "unit"
      ? `under ${unit.path.endsWith(".plist") ? "launchd" : "systemd"} (${unit.name})`
      : by === "server"
        ? `started by \`${app.command} server start\``
        : `started by hand — \`${app.command} server stop\` leaves it alone`

  const start = async (prepared: Prepared) => {
    const { context, system, platform, unit, each, lock, say } = prepared
    const held = lock()
    if (held) {
      say({ profile: unit.profile, started: false, running: true, pid: held.pid, startedAt: held.startedAt }, [
        `Already serving profile ${unit.profile} since ${clock(held.startedAt)} (PID ${held.pid}).`,
      ])
      return
    }
    let by: By
    let spawned: number | undefined
    if (existsSync(unit.path)) {
      await each(platform.start(unit))
      by = "unit"
    } else {
      // A shell's --timeout default would end a server meant to outlive the shell.
      const { [`${app.envPrefix}_TIMEOUT`]: _timeout, ...inherited } = context.env
      const [name = "", value = ""] = marker(unit.profile).split("=")
      spawned = system.spawn(
        ["serve"],
        { ...inherited, [`${app.envPrefix}_PROFILE`]: unit.profile, [name]: value },
        unit.logPath ?? "",
      )
      by = "server"
    }
    for (let look = 0; look < LOOKS; look++) {
      const now = lock()
      if (now?.listeningAt) {
        say({ profile: unit.profile, started: true, by, pid: now.pid, connectedAt: now.listeningAt }, [
          `Started: serving profile ${unit.profile} (PID ${now.pid}), listening since ${clock(now.listeningAt)}, ${how(by, unit)}.`,
          `Its log: ${app.command} server logs`,
        ])
        return
      }
      const gone = spawned !== undefined ? !alive(spawned) : look > 8 && !(await platform.state(unit)).active
      if (gone) {
        const last = (by === "unit" ? await platform.logs(unit, 5) : tail(unit.logPath, 5)).trim()
        throw new CliError("provider_unavailable", `serve stopped before it was listening${last ? `:\n${last}` : ""}`)
      }
      await system.pause()
    }
    throw new CliError(
      "timeout",
      `serve is running but not listening yet — \`${app.command} server status\`, \`${app.command} server logs\``,
    )
  }

  const stop = async (prepared: Prepared) => {
    const { platform, unit, each, lock, say, system } = prepared
    if (existsSync(unit.path) && (await platform.state(unit)).active) {
      await each(platform.stop(unit))
      say({ profile: unit.profile, stopped: true, by: "unit" }, [`Stopped ${unit.name}.`])
      return
    }
    const held = lock()
    if (!held) {
      say({ profile: unit.profile, stopped: false }, [`Nothing to stop: profile ${unit.profile} is not being served.`])
      return
    }
    if (!carries(held.pid, marker(unit.profile))) {
      throw new CliError(
        "validation_error",
        `serve for profile ${unit.profile} (PID ${held.pid}) was not started by \`${app.command} server start\` — stop it where it runs`,
      )
    }
    process.kill(held.pid, "SIGTERM")
    for (let look = 0; look < LOOKS && alive(held.pid); look++) await system.pause()
    say({ profile: unit.profile, stopped: true, by: "server", pid: held.pid }, [
      `Stopped serving profile ${unit.profile} (PID ${held.pid}).`,
    ])
  }

  command
    .command("start")
    .description("start serve in the background — through the unit if one is installed — and answer once it listens")
    .action(async function (this: Command) {
      await start(prepare(this))
    })

  command
    .command("stop")
    .description("stop the serve that `server start` or the unit started")
    .action(async function (this: Command) {
      await stop(prepare(this))
    })

  command
    .command("restart")
    .description("stop it and start it again")
    .action(async function (this: Command) {
      const prepared = prepare(this)
      await stop({ ...prepared, say: () => {} })
      await start(prepared)
    })

  command
    .command("status")
    .description("whether serve runs for this profile, since when, who started it, and the unit if there is one")
    .action(async function (this: Command) {
      const prepared = prepare(this)
      const { context, platform, unit, lock, say } = prepared
      const isInstalled = existsSync(unit.path)
      const state = isInstalled ? await platform.state(unit) : { loaded: false, active: false }
      const held = lock()
      const by = held ? await byOf(prepared, held) : null
      const left = held ? undefined : readLock(lockPath(app, unit.profile, context.env))
      // max-cli's server status says the same: an update leaves a running serve on the old code.
      const outdated =
        held?.version && held.version !== app.version
          ? `It runs ${app.command} ${held.version}, and ${app.command} is now ${app.version} — \`${app.command} server restart\`.`
          : undefined
      if (outdated && context.format !== "pretty") context.renderer.note(outdated)
      const unitLine = isInstalled
        ? `Unit: ${tilde(unit.path, context.env)} — ${state.detail ?? (state.active ? "active" : "inactive")}.`
        : `No unit installed — \`${app.command} server install\` adds one, for starting under systemd or launchd.`
      say(
        {
          profile: unit.profile,
          running: held !== undefined,
          ...(held
            ? {
                pid: held.pid,
                startedAt: held.startedAt,
                connected: held.listeningAt !== undefined,
                ...(held.listeningAt ? { connectedAt: held.listeningAt } : {}),
                by,
              }
            : {}),
          ...(held?.version ? { version: held.version } : {}),
          cliVersion: app.version,
          log: isInstalled && unit.path.endsWith(".service") ? `journalctl --user -u ${unit.name}` : unit.logPath,
          ...(left ? { stale: { pid: left.pid, startedAt: left.startedAt } } : {}),
          unit: { name: unit.name, path: unit.path, installed: isInstalled, ...state },
        },
        [
          held
            ? held.listeningAt
              ? `Serving profile ${unit.profile} since ${clock(held.startedAt)} (PID ${held.pid}), listening since ${clock(held.listeningAt)}, ${how(by ?? "hand", unit)}.`
              : `Starting profile ${unit.profile} since ${clock(held.startedAt)} (PID ${held.pid}) — not listening yet, ${how(by ?? "hand", unit)}.`
            : `Not serving profile ${unit.profile}.${isInstalled && state.detail?.startsWith("failed") ? ` The unit failed — \`${app.command} server logs\`.` : ""}`,
          ...(left
            ? [
                `A serve that started ${clock(left.startedAt)} (PID ${left.pid}) is gone and left its lock — the next start takes it over.`,
              ]
            : []),
          unitLine,
          ...(outdated ? [outdated] : []),
        ],
      )
    })

  command
    .command("logs")
    .description("serve's latest log lines — from the journal under systemd, else its log file")
    .option("-n, --lines <n>", "how many lines", (value) => wholeNumber(value), 50)
    .action(async function (this: Command) {
      const { lines } = this.opts<{ lines: number }>()
      const { context, platform, unit } = prepare(this)
      const text = existsSync(unit.path) ? await platform.logs(unit, lines) : tail(unit.logPath, lines)
      if (!text) context.renderer.note(`no log yet for profile ${unit.profile}`)
      if (context.format === "pretty") {
        if (text) context.streams.data(text.replace(/\n$/, ""))
      } else
        context.renderer.result({ ...listed(text.split("\n").filter(Boolean)), profile: unit.profile, unit: unit.name })
    })

  command
    .command("install")
    .description("write a systemd user unit or a launchd agent for this profile; starts nothing")
    .action(function (this: Command) {
      const { context, platform, unit, say } = prepare(this)
      const replaced = existsSync(unit.path)
      writeSecurely(unit.path, platform.text(unit, app), 0o644)
      platform.prepare?.(unit)
      say({ profile: unit.profile, unit: unit.name, path: unit.path, command: unit.command, replaced }, [
        `${replaced ? "Rewrote" : "Wrote"} ${tilde(unit.path, context.env)} — nothing started.`,
        `It runs: ${unit.command.map((word) => tilde(word, context.env)).join(" ")}`,
        `Start it now: ${app.command} server start · ${platform.atLogin(unit)}`,
      ])
    })

  command
    .command("uninstall")
    .description("remove this profile's unit; stop it first")
    .action(async function (this: Command) {
      const { context, platform, unit, say } = prepare(this)
      installed(unit)
      if ((await platform.state(unit)).active) {
        throw new CliError("validation_error", `the unit is running — \`${app.command} server stop\` first`)
      }
      rmSync(unit.path, { force: true })
      say({ profile: unit.profile, unit: unit.name, path: unit.path, removed: true }, [
        `Removed ${tilde(unit.path, context.env)}.`,
      ])
    })

  return command
}

const wholeNumber = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}
