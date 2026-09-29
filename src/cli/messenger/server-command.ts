import { execFile, spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { CliError, resolvePaths, writeSecurely } from "@leemour/cli-core"
import { Command } from "commander"
import type { AppIdentity } from "../app.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { type Messenger, messengerContext } from "./context.js"
import { alive, carries } from "./processes.js"
import { type Lock, lockPath, readLock } from "./serve-command.js"

export interface Ran {
  code: number
  stdout: string
  stderr: string
}

/** What `server` asks of the machine. Tests hand one in; nothing else does. */
export interface ServerSystem {
  platform: NodeJS.Platform
  run: (argv: string[], env: NodeJS.ProcessEnv) => Promise<Ran>
  /** The command line that starts this CLI: the node binary and the script, both absolute. */
  entry: string[]
  uid: number
  /** Starts `<cli> <argv>` apart from this process, writing to `log`, and answers its PID. */
  spawn: (argv: string[], env: NodeJS.ProcessEnv, log: string) => number
  /** The pause between two looks at whether `serve` is listening yet. */
  pause: () => Promise<void>
}

const runProgram = (argv: string[], env: NodeJS.ProcessEnv): Promise<Ran> =>
  new Promise((resolve, reject) => {
    const [file = "", ...args] = argv
    execFile(file, args, { env, encoding: "utf8" }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        reject(new CliError("configuration_error", `${file} was not found — this machine has no ${file} to run serve`))
        return
      }
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr })
    })
  })

const thisMachine = (): ServerSystem => {
  const entry = [process.execPath, realpathSync(process.argv[1] ?? "")]
  return {
    platform: process.platform,
    run: runProgram,
    entry,
    uid: process.getuid?.() ?? 0,
    spawn: (argv, env, log) => {
      mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
      const out = openSync(log, "a", 0o600)
      try {
        const [file = "", ...rest] = entry
        const child = spawn(file, [...rest, ...argv], { detached: true, stdio: ["ignore", out, out], env })
        child.unref()
        return child.pid ?? 0
      } finally {
        closeSync(out)
      }
    },
    pause: () => sleep(250),
  }
}

/** How many looks, a pause apart, `start` gives `serve` to connect — about 30 seconds on a real machine. */
const LOOKS = 120

interface Unit {
  profile: string
  /** What `systemctl` or `launchctl` call it. */
  name: string
  path: string
  logPath?: string
  /** What the unit runs, and the variables it runs with. */
  command: string[]
  environment: Record<string, string>
}

/**
 * Only the variables that say **where** the files are travel into the unit: a unit written from a
 * development checkout must open that checkout's session and store, never the owner's real ones.
 * Nothing that could hold a credential is copied.
 */
const locationVariables = (app: AppIdentity, env: NodeJS.ProcessEnv): Record<string, string> => {
  const names = [
    ...["CONFIG_DIR", "STATE_DIR", "CACHE_DIR"].map((name) => `${app.envPrefix}_${name}`),
    "MESSAGING_STORE",
    "MESSAGING_STATE_DIR",
  ]
  return Object.fromEntries(names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])))
}

interface Platform {
  unit: (base: Omit<Unit, "name" | "path">) => Unit
  text: (unit: Unit, app: AppIdentity) => string
  start: (unit: Unit) => string[][]
  stop: (unit: Unit) => string[][]
  state: (unit: Unit) => Promise<{ loaded: boolean; active: boolean; pid?: number; detail?: string }>
  logs: (unit: Unit, lines: number) => Promise<string>
  /** What must exist before the unit first runs. */
  prepare?: (unit: Unit) => void
  /** How to have it start at every login too. */
  atLogin: (unit: Unit) => string
}

const home = (env: NodeJS.ProcessEnv): string => {
  if (!env.HOME) throw new CliError("configuration_error", "HOME is not set, so there is nowhere to put the unit")
  return env.HOME
}

/** `%` is a specifier in both; `$` is a variable only in `ExecStart=` — in `Environment=` it is itself. */
const systemdQuote = (value: string, { command = false } = {}) => {
  const quoted = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")
  return `"${command ? quoted.replaceAll("$", "$$$$") : quoted}"`
}

const systemd = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv): Platform => {
  const folder = join(env.XDG_CONFIG_HOME ?? join(home(env), ".config"), "systemd", "user")
  const checked = async (argv: string[]) => {
    const ran = await system.run(argv, env)
    if (ran.code !== 0) throw new CliError("configuration_error", `${argv.join(" ")} failed: ${ran.stderr.trim()}`)
    return ran.stdout
  }
  return {
    unit: (base) => {
      const name = `${app.command}-serve-${base.profile}.service`
      return { ...base, name, path: join(folder, name) }
    },
    text: (unit) =>
      [
        "[Unit]",
        `Description=${app.command} serve — keep the local message archive current (profile ${unit.profile})`,
        "",
        "[Service]",
        `ExecStart=${unit.command.map((word) => systemdQuote(word, { command: true })).join(" ")}`,
        ...Object.entries(unit.environment).map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`),
        "Restart=on-failure",
        "RestartSec=30",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    start: (unit) => [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "start", unit.name],
    ],
    stop: (unit) => [["systemctl", "--user", "stop", unit.name]],
    state: async (unit) => {
      const ran = await system.run(
        [
          "systemctl",
          "--user",
          "show",
          unit.name,
          "-p",
          "LoadState",
          "-p",
          "ActiveState",
          "-p",
          "SubState",
          "-p",
          "MainPID",
        ],
        env,
      )
      const fields = Object.fromEntries(
        ran.stdout
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )
      const pid = Number(fields.MainPID)
      return {
        loaded: fields.LoadState === "loaded",
        active: fields.ActiveState === "active",
        ...(pid > 0 ? { pid } : {}),
        ...(fields.ActiveState ? { detail: `${fields.ActiveState} (${fields.SubState})` } : {}),
      }
    },
    logs: (unit, lines) => checked(["journalctl", "--user", "-u", unit.name, "-n", String(lines), "--no-pager"]),
    atLogin: (unit) => `at every login too: systemctl --user enable ${unit.name.replace(/\.service$/, "")}`,
  }
}

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const launchd = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv): Platform => {
  const folder = join(home(env), "Library", "LaunchAgents")
  const domain = `gui/${system.uid}`
  return {
    unit: (base) => {
      const name = `${app.appName}.serve.${base.profile}`
      return { ...base, name, path: join(folder, `${name}.plist`) }
    },
    text: (unit) =>
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        `  <key>Label</key><string>${xml(unit.name)}</string>`,
        "  <key>ProgramArguments</key>",
        "  <array>",
        ...unit.command.map((word) => `    <string>${xml(word)}</string>`),
        "  </array>",
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        ...Object.entries(unit.environment).map(
          ([name, value]) => `    <key>${xml(name)}</key><string>${xml(value)}</string>`,
        ),
        "  </dict>",
        // launchd loads every agent here at login; disabled, it waits for `server start` to enable it.
        "  <key>Disabled</key><true/>",
        "  <key>RunAtLoad</key><true/>",
        "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        "  <key>ThrottleInterval</key><integer>30</integer>",
        `  <key>StandardOutPath</key><string>${xml(unit.logPath ?? "")}</string>`,
        `  <key>StandardErrorPath</key><string>${xml(unit.logPath ?? "")}</string>`,
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    // RunAtLoad makes loading the agent the start; `enable` overrides the file's Disabled until `disable`.
    start: (unit) => [
      ["launchctl", "enable", `${domain}/${unit.name}`],
      ["launchctl", "bootstrap", domain, unit.path],
    ],
    stop: (unit) => [
      ["launchctl", "bootout", `${domain}/${unit.name}`],
      ["launchctl", "disable", `${domain}/${unit.name}`],
    ],
    state: async (unit) => {
      const ran = await system.run(["launchctl", "print", `${domain}/${unit.name}`], env)
      if (ran.code !== 0) return { loaded: false, active: false }
      const state = /^\s*state = (.+)$/m.exec(ran.stdout)?.[1]?.trim()
      const pid = Number(/^\s*pid = (\d+)$/m.exec(ran.stdout)?.[1])
      return {
        loaded: true,
        active: state === "running",
        ...(pid > 0 ? { pid } : {}),
        ...(state ? { detail: state } : {}),
      }
    },
    // launchd opens the log itself and does not create its folder.
    prepare: (unit) => {
      if (unit.logPath) mkdirSync(dirname(unit.logPath), { recursive: true, mode: 0o700 })
    },
    logs: async (unit, lines) => tail(unit.logPath, lines),
    atLogin: () => "from then on it also starts at every login, until `server stop`",
  }
}

const tail = (path: string | undefined, lines: number): string =>
  path && existsSync(path) ? `${readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-lines).join("\n")}\n` : ""

/** Where there is neither: `start` still runs serve in the background; only `install` needs one of them. */
const noUnits = (app: AppIdentity, system: ServerSystem): Platform => {
  const refuse = (): never => {
    throw new CliError(
      "validation_error",
      `${app.command} server install knows systemd (Linux) and launchd (macOS), not ${system.platform} — \`${app.command} server start\` runs serve without a unit`,
    )
  }
  return {
    unit: (base) => ({ ...base, name: `${app.command}-serve-${base.profile}`, path: "" }),
    text: refuse,
    start: refuse,
    stop: refuse,
    state: async () => ({ loaded: false, active: false }),
    logs: async () => "",
    atLogin: () => "",
  }
}

const platformFor = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv): Platform => {
  if (system.platform === "linux") return systemd(app, system, env)
  if (system.platform === "darwin") return launchd(app, system, env)
  return noUnits(app, system)
}

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
      say({ profile: unit.profile, started: false, running: true, pid: held.pid, since: held.startedAt }, [
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
        say({ profile: unit.profile, started: true, by, pid: now.pid, listeningSince: now.listeningAt }, [
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
      // max-cli's server status says the same: an update leaves a running serve on the old code.
      const stale =
        held?.version && held.version !== app.version
          ? `It runs ${app.command} ${held.version}, and ${app.command} is now ${app.version} — \`${app.command} server restart\`.`
          : undefined
      if (stale && context.format !== "pretty") context.renderer.note(stale)
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
                since: held.startedAt,
                listening: held.listeningAt !== undefined,
                ...(held.listeningAt ? { listeningSince: held.listeningAt } : {}),
                by,
              }
            : {}),
          ...(held?.version ? { version: held.version } : {}),
          unit: { name: unit.name, path: unit.path, installed: isInstalled, ...state },
        },
        [
          held
            ? held.listeningAt
              ? `Serving profile ${unit.profile} since ${clock(held.startedAt)} (PID ${held.pid}), listening since ${clock(held.listeningAt)}, ${how(by ?? "hand", unit)}.`
              : `Starting profile ${unit.profile} since ${clock(held.startedAt)} (PID ${held.pid}) — not listening yet, ${how(by ?? "hand", unit)}.`
            : `Not serving profile ${unit.profile}.${isInstalled && state.detail?.startsWith("failed") ? ` The unit failed — \`${app.command} server logs\`.` : ""}`,
          unitLine,
          ...(stale ? [stale] : []),
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
        context.renderer.result({ profile: unit.profile, unit: unit.name, lines: text.split("\n").filter(Boolean) })
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
