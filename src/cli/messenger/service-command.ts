import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@leemour/cli-core"
import { Command } from "commander"
import type { AppIdentity } from "../app.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { type Messenger, messengerContext } from "./context.js"
import { alive, lockPath, readLock } from "./serve-command.js"

export interface Ran {
  code: number
  stdout: string
  stderr: string
}

/** What the service commands ask of the machine. Tests hand one in; nothing else does. */
export interface ServiceSystem {
  platform: NodeJS.Platform
  run: (argv: string[], env: NodeJS.ProcessEnv) => Promise<Ran>
  /** The command line that starts this CLI: the node binary and the script, both absolute. */
  entry: string[]
  uid: number
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

const thisMachine = (): ServiceSystem => ({
  platform: process.platform,
  run: runProgram,
  entry: [process.execPath, realpathSync(process.argv[1] ?? "")],
  uid: process.getuid?.() ?? 0,
})

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

const systemd = (app: AppIdentity, system: ServiceSystem, env: NodeJS.ProcessEnv): Platform => {
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
  }
}

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const launchd = (app: AppIdentity, system: ServiceSystem, env: NodeJS.ProcessEnv): Platform => {
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
        "  <key>RunAtLoad</key><true/>",
        "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        "  <key>ThrottleInterval</key><integer>30</integer>",
        `  <key>StandardOutPath</key><string>${xml(unit.logPath ?? "")}</string>`,
        `  <key>StandardErrorPath</key><string>${xml(unit.logPath ?? "")}</string>`,
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    // RunAtLoad makes loading the agent the start, so `install` only writes the file.
    start: (unit) => [["launchctl", "bootstrap", domain, unit.path]],
    stop: (unit) => [["launchctl", "bootout", `${domain}/${unit.name}`]],
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
    logs: async (unit, lines) => {
      if (!unit.logPath || !existsSync(unit.logPath)) return ""
      return `${readFileSync(unit.logPath, "utf8").split("\n").filter(Boolean).slice(-lines).join("\n")}\n`
    },
  }
}

const platformFor = (app: AppIdentity, system: ServiceSystem, env: NodeJS.ProcessEnv): Platform => {
  if (system.platform === "linux") return systemd(app, system, env)
  if (system.platform === "darwin") return launchd(app, system, env)
  throw new CliError(
    "validation_error",
    `${app.command} service knows systemd (Linux) and launchd (macOS), not ${system.platform} — run \`${app.command} serve\` under your own supervisor`,
  )
}

/**
 * `serve` as a user service: a systemd user unit on Linux, a launchd agent on macOS, one per
 * profile. **`install` only writes the file** — nothing starts or enables it until asked (NEED-9).
 */
export const serviceCommand = (messenger: Messenger): Command => {
  const { app } = messenger
  const command = new Command("service").description(
    `run \`${app.command} serve\` as a user service — systemd on Linux, launchd on macOS`,
  )

  const prepare = (self: Command) => {
    const context = messengerContext(self, messenger)
    const system = environmentOf<BaseEnvironment & { system?: ServiceSystem }>(self).system ?? thisMachine()
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
    return { context, platform, unit, each }
  }

  const installed = (unit: Unit) => {
    if (!existsSync(unit.path)) {
      throw new CliError(
        "not_found",
        `no service for profile ${unit.profile} — \`${app.command} service install\` writes it`,
      )
    }
  }

  command
    .command("install")
    .description("write the unit for this profile; it does not start or enable it")
    .action(function (this: Command) {
      const { context, platform, unit } = prepare(this)
      const replaced = existsSync(unit.path)
      writeSecurely(unit.path, platform.text(unit, app), 0o644)
      platform.prepare?.(unit)
      context.renderer.result({
        profile: unit.profile,
        unit: unit.name,
        path: unit.path,
        command: unit.command,
        replaced,
      })
      context.renderer.note(`written, not started — \`${app.command} service start\` starts it`)
    })

  command
    .command("uninstall")
    .description("remove the unit for this profile; stop it first")
    .action(async function (this: Command) {
      const { context, platform, unit } = prepare(this)
      installed(unit)
      if ((await platform.state(unit)).active) {
        throw new CliError("validation_error", `the service is running — \`${app.command} service stop\` first`)
      }
      rmSync(unit.path, { force: true })
      context.renderer.result({ profile: unit.profile, unit: unit.name, path: unit.path, removed: true })
    })

  command
    .command("start")
    .description("start the service for this profile")
    .action(async function (this: Command) {
      const { context, platform, unit, each } = prepare(this)
      installed(unit)
      const held = readLock(lockPath(app, unit.profile, context.env))
      if (held && alive(held.pid) && !(await platform.state(unit)).active) {
        throw new CliError(
          "validation_error",
          `${app.command} serve is already running for profile ${unit.profile} outside the service (PID ${held.pid}) — stop it first`,
        )
      }
      await each(platform.start(unit))
      context.renderer.result({ profile: unit.profile, unit: unit.name, started: true })
    })

  command
    .command("stop")
    .description("stop the service for this profile")
    .action(async function (this: Command) {
      const { context, platform, unit, each } = prepare(this)
      installed(unit)
      await each(platform.stop(unit))
      context.renderer.result({ profile: unit.profile, unit: unit.name, stopped: true })
    })

  command
    .command("status")
    .description("whether the unit is installed and running, and who holds the serve lock")
    .action(async function (this: Command) {
      const { context, platform, unit } = prepare(this)
      const isInstalled = existsSync(unit.path)
      const state = isInstalled ? await platform.state(unit) : { loaded: false, active: false }
      const lock = readLock(lockPath(app, unit.profile, context.env))
      const serving = lock !== undefined && alive(lock.pid)
      context.renderer.result({
        profile: unit.profile,
        unit: unit.name,
        path: unit.path,
        installed: isInstalled,
        ...state,
        serve: {
          running: serving,
          ...(serving && lock
            ? { pid: lock.pid, since: lock.startedAt, byService: state.pid !== undefined && state.pid === lock.pid }
            : {}),
        },
      })
    })

  command
    .command("logs")
    .description("the service's latest log lines")
    .option("-n, --lines <n>", "how many lines", (value) => wholeNumber(value), 50)
    .action(async function (this: Command) {
      const { lines } = this.opts<{ lines: number }>()
      const { context, platform, unit } = prepare(this)
      installed(unit)
      const text = await platform.logs(unit, lines)
      if (context.format === "pretty") context.streams.data(text.replace(/\n$/, ""))
      else context.renderer.result({ profile: unit.profile, unit: unit.name, lines: text.split("\n").filter(Boolean) })
    })

  return command
}

const wholeNumber = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}
