import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it, onTestFinished } from "vitest"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"
import { servingProfiles } from "./serve-command.js"
import { type Ran, type ServerSystem, serverCommand } from "./server-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => ({}) as MessengerAdapter,
  chatArgument: "a chat",
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "server-"))
  const env = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home", ".config"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "m.db"),
    CHAT_API_HASH: "never-in-a-unit",
    CHAT_TIMEOUT: "30s",
  }
  return { root, env }
}

const lockFile = (env: { CHAT_STATE_DIR: string }, profile = "default") =>
  join(env.CHAT_STATE_DIR, "serve", `${profile}.lock`)
const hold = (env: { CHAT_STATE_DIR: string }, lock: object) => {
  mkdirSync(dirname(lockFile(env)), { recursive: true })
  writeFileSync(lockFile(env), JSON.stringify(lock))
}

/** A real sleeping process, with the environment it was given. */
const sleeper = (env?: NodeJS.ProcessEnv, script = "setTimeout(() => {}, 30000)") => {
  const child = spawn(process.execPath, ["-e", script], { ...(env ? { env } : {}) })
  onTestFinished(() => {
    child.kill()
  })
  return child
}

const machine = (
  platform: NodeJS.Platform,
  {
    answers = {},
    serve = "listens",
  }: { answers?: Record<string, Partial<Ran>>; serve?: "listens" | "dies" | "silent" } = {},
) => {
  const ran: string[][] = []
  const spawned: { argv: string[]; env: NodeJS.ProcessEnv; child: ChildProcess }[] = []
  const system: ServerSystem = {
    platform,
    uid: 501,
    entry: ["/opt/node", "/opt/chat/bin/chat.js"],
    run: async (argv) => {
      ran.push(argv)
      const answer = Object.entries(answers).find(([prefix]) => argv.join(" ").startsWith(prefix))?.[1] ?? {}
      return { code: 0, stdout: "", stderr: "", ...answer }
    },
    spawn: (argv, env, log) => {
      const child = sleeper(env, serve === "dies" ? "" : undefined)
      spawned.push({ argv, env, child })
      mkdirSync(dirname(log), { recursive: true })
      writeFileSync(log, "starting\nno app credentials for profile default\n")
      const startedAt = new Date().toISOString()
      if (serve !== "dies") {
        hold(
          { CHAT_STATE_DIR: env.CHAT_STATE_DIR ?? "" },
          {
            pid: child.pid,
            startedAt,
            ...(serve === "listens" ? { listeningAt: startedAt } : {}),
          },
        )
      }
      return child.pid ?? 0
    },
    pause: () => sleep(5),
  }
  return { system, ran, spawned }
}

const call = async (argv: string[], env: NodeJS.ProcessEnv, system: ServerSystem, tty = false) => {
  const streams = captureStreams()
  const code = await run(
    ["server", ...argv],
    { app, commands: () => [serverCommand(messenger)] },
    { streams, tty, env, system },
  )
  const first = streams.stdout[0]
  return {
    code,
    answer: !tty && first ? JSON.parse(first) : undefined,
    text: streams.stdout.join("\n"),
    stderr: streams.stderr.join("\n"),
  }
}

const unitPath = (env: { XDG_CONFIG_HOME: string }, profile = "default") =>
  join(env.XDG_CONFIG_HOME, "systemd", "user", `chat-serve-${profile}.service`)

const showing = (active: string, pid = 0) => ({
  "systemctl --user show": { stdout: `LoadState=loaded\nActiveState=${active}\nSubState=running\nMainPID=${pid}\n` },
})

describe("server without a unit", () => {
  it("**start runs serve in the background, answers once it listens, and stop ends it**", async () => {
    const { env } = setup()
    const { system, spawned } = machine("linux")

    const started = await call(["start", "--json"], env, system)
    expect(started.answer).toMatchObject({ started: true, by: "server", pid: spawned[0]?.child.pid })
    expect(spawned[0]?.argv).toEqual(["serve"])
    expect(spawned[0]?.env).toMatchObject({ CHAT_PROFILE: "default", CHAT_SERVER: "default" })
    expect(spawned[0]?.env.CHAT_TIMEOUT).toBeUndefined()

    expect((await call(["status", "--json"], env, system)).answer).toMatchObject({
      running: true,
      listening: true,
      by: "server",
      unit: { installed: false },
    })
    expect((await call(["start", "--json"], env, system)).answer).toMatchObject({ started: false, running: true })

    const exited = new Promise((resolve) => spawned[0]?.child.on("exit", (_code, signal) => resolve(signal)))
    expect((await call(["stop", "--json"], env, system)).answer).toMatchObject({ stopped: true, by: "server" })
    expect(await exited).toBe("SIGTERM")
    expect((await call(["status", "--json"], env, system)).answer).toMatchObject({ running: false })
    expect((await call(["stop", "--json"], env, system)).answer).toEqual({ profile: "default", stopped: false })
  })

  it("a serve that dies before it listens is reported with its last log lines", async () => {
    const { env } = setup()
    const { code, stderr } = await call(["start"], env, machine("linux", { serve: "dies" }).system)

    expect(code).not.toBe(0)
    expect(stderr).toContain("stopped before it was listening")
    expect(stderr).toContain("no app credentials")
  })

  it("one that never listens ends the wait with a timeout and is left running", async () => {
    const { env } = setup()
    const { code, stderr } = await call(["start"], env, machine("linux", { serve: "silent" }).system)

    expect(code).not.toBe(0)
    expect(stderr).toContain("not listening yet")
    expect((await call(["status", "--json"], env, machine("linux").system)).answer).toMatchObject({
      running: true,
      listening: false,
    })
  })

  it("**stop leaves alone a serve it did not start** — and a PID that now belongs to somebody else", async () => {
    const { env } = setup()
    const stranger = sleeper()
    hold(env, { pid: stranger.pid, startedAt: "2026-09-29T10:00:00.000Z", listeningAt: "2026-09-29T10:00:01.000Z" })

    const { code, stderr } = await call(["stop"], env, machine("linux").system)
    expect(code).not.toBe(0)
    expect(stderr).toContain(`PID ${stranger.pid}`)
    expect(stranger.exitCode).toBeNull()
    expect(stranger.signalCode).toBeNull()
    expect((await call(["status", "--json"], env, machine("linux").system)).answer).toMatchObject({ by: "hand" })
  })

  it("logs reads serve's log file", async () => {
    const { env } = setup()
    await call(["start"], env, machine("linux").system)
    expect((await call(["logs", "-n", "1", "--json"], env, machine("linux").system)).answer).toMatchObject({
      lines: ["no app credentials for profile default"],
    })
  })

  it("**says when the running serve is older than this CLI**, as max-cli's server status does", async () => {
    const { env } = setup()
    const stale = sleeper()
    hold(env, {
      pid: stale.pid,
      startedAt: "2026-09-29T10:00:00.000Z",
      listeningAt: "2026-09-29T10:00:01.000Z",
      version: "0.9.9",
    })

    const json = await call(["status", "--json"], env, machine("linux").system)
    expect(json.answer).toMatchObject({ running: true, version: "0.9.9" })
    expect(json.stderr).toContain("It runs chat 0.9.9, and chat is now 1.0.0 — `chat server restart`.")
    expect((await call(["status"], env, machine("linux").system, true)).text).toContain("chat is now 1.0.0")

    expect(servingProfiles(app, env)).toEqual(["default"])
    stale.kill()
    await new Promise((resolve) => stale.on("exit", resolve))
    expect(servingProfiles(app, env)).toEqual([])
    expect(servingProfiles(app, { ...env, CHAT_STATE_DIR: join(env.CHAT_STATE_DIR, "nowhere") })).toEqual([])
  })

  it("says it in sentences for a person", async () => {
    const { env } = setup()
    const { system } = machine("linux")

    expect((await call(["status"], env, system, true)).text).toBe(
      "Not serving profile default.\nNo unit installed — `chat server install` adds one, for starting under systemd or launchd.",
    )
    expect((await call(["start"], env, system, true)).text).toMatch(
      /^Started: serving profile default \(PID \d+\), listening since \d\d:\d\d, started by `chat server start`\.\nIts log: chat server logs$/,
    )
  })
})

describe("server with a systemd unit", () => {
  it("**install writes the unit — under the name tg 0.5.0 gave it — and neither starts nor enables it**", async () => {
    const { env } = setup()
    const { system, ran } = machine("linux")

    const { answer } = await call(["install", "--json"], env, system)

    expect(ran).toEqual([])
    expect(answer).toMatchObject({ unit: "chat-serve-default.service", path: unitPath(env), replaced: false })
    const unit = readFileSync(unitPath(env), "utf8")
    expect(unit).toContain('ExecStart="/opt/node" "/opt/chat/bin/chat.js" "serve"')
    expect(unit).toContain('Environment="CHAT_PROFILE=default"')
    expect(unit).toContain(`Environment="CHAT_STATE_DIR=${env.CHAT_STATE_DIR}"`)
    expect(unit).not.toContain("never-in-a-unit")

    expect((await call(["install"], env, system, true)).text).toBe(
      [
        "Rewrote ~/.config/systemd/user/chat-serve-default.service — nothing started.",
        "It runs: /opt/node /opt/chat/bin/chat.js serve",
        "Start it now: chat server start · at every login too: systemctl --user enable chat-serve-default",
      ].join("\n"),
    )
  })

  it("one unit per profile, and a path's % and $ reach the program unexpanded", async () => {
    const { env } = setup()
    const system = { ...machine("linux").system, entry: ["/opt/node", "/opt/$HOME/100%/chat.js"] }
    await call(["install"], { ...env, CHAT_PROFILE: "work", CHAT_STATE_DIR: "/data/100%$HOME" }, system)

    const unit = readFileSync(unitPath(env, "work"), "utf8")
    expect(unit).toContain('Environment="CHAT_PROFILE=work"')
    // systemd.exec(5): in Environment= "the \"$\" character has no special meaning"; in ExecStart= it does.
    expect(unit).toContain('Environment="CHAT_STATE_DIR=/data/100%%$HOME"')
    expect(unit).toContain('"/opt/$$HOME/100%%/chat.js"')
  })

  it("start and stop go through systemctl, and status names the unit as the holder of the lock", async () => {
    const { env } = setup()
    const { system, ran } = machine("linux", {
      answers: {
        ...showing("active", process.pid),
        "systemctl --user start": { stdout: "" },
      },
    })
    await call(["install"], env, system)
    system.run = async (argv) => {
      ran.push(argv)
      if (argv.join(" ") === "systemctl --user start chat-serve-default.service") {
        hold(env, { pid: process.pid, startedAt: "2026-09-29T10:00:00.000Z", listeningAt: "2026-09-29T10:00:02.000Z" })
      }
      const shown = argv[2] === "show" ? showing("active", process.pid)["systemctl --user show"].stdout : ""
      return { code: 0, stdout: shown, stderr: "" }
    }

    expect((await call(["start", "--json"], env, system)).answer).toMatchObject({ started: true, by: "unit" })
    expect(ran).toContainEqual(["systemctl", "--user", "daemon-reload"])
    expect((await call(["status", "--json"], env, system)).answer).toMatchObject({
      running: true,
      by: "unit",
      unit: { installed: true, active: true, detail: "active (running)" },
    })
    expect((await call(["status"], env, system, true)).text).toContain("under systemd (chat-serve-default.service)")
    expect((await call(["stop", "--json"], env, system)).answer).toMatchObject({ stopped: true, by: "unit" })
    expect(ran.at(-1)).toEqual(["systemctl", "--user", "stop", "chat-serve-default.service"])
  })

  it("a failing systemctl is reported with what it said", async () => {
    const { env } = setup()
    const { system } = machine("linux", {
      answers: { "systemctl --user start": { code: 1, stderr: "Unit not found." } },
    })
    await call(["install"], env, system)

    const { code, stderr } = await call(["start"], env, system)
    expect(code).not.toBe(0)
    expect(stderr).toContain("Unit not found.")
  })

  it("uninstall refuses while the unit runs, and removes it once stopped", async () => {
    const { env } = setup()
    await call(["install"], env, machine("linux").system)

    expect((await call(["uninstall"], env, machine("linux", { answers: showing("active", 42) }).system)).code).not.toBe(
      0,
    )
    expect(existsSync(unitPath(env))).toBe(true)

    const removed = await call(["uninstall", "--json"], env, machine("linux", { answers: showing("inactive") }).system)
    expect(removed.answer).toMatchObject({ removed: true })
    expect(existsSync(unitPath(env))).toBe(false)
  })

  it("logs asks the journal for the unit's last lines", async () => {
    const { env } = setup()
    const { system, ran } = machine("linux", { answers: { journalctl: { stdout: "one\ntwo\n" } } })
    await call(["install"], env, system)

    expect((await call(["logs", "-n", "2", "--json"], env, system)).answer).toMatchObject({ lines: ["one", "two"] })
    expect(ran.at(-1)).toEqual(["journalctl", "--user", "-u", "chat-serve-default.service", "-n", "2", "--no-pager"])
  })
})

describe("server with a launchd agent", () => {
  it("install writes an agent that is disabled until start enables it; stop disables it again", async () => {
    const { env } = setup()
    const { system, ran } = machine("darwin", { answers: { "launchctl print": { code: 113 } } })
    const path = join(env.HOME, "Library", "LaunchAgents", "chat-cli.serve.default.plist")

    expect((await call(["install", "--json"], env, system)).answer).toMatchObject({
      unit: "chat-cli.serve.default",
      path,
    })
    expect(ran).toEqual([])
    const plist = readFileSync(path, "utf8")
    expect(plist).toContain("<key>Disabled</key><true/>")
    expect(plist).toContain(`<string>${join(env.CHAT_STATE_DIR, "serve", "default.log")}</string>`)
    expect(existsSync(join(env.CHAT_STATE_DIR, "serve"))).toBe(true)

    await call(["start"], env, system)
    expect(ran.filter((argv) => argv[1] !== "print")).toEqual([
      ["launchctl", "enable", "gui/501/chat-cli.serve.default"],
      ["launchctl", "bootstrap", "gui/501", path],
    ])
  })

  it("status reads launchctl print, and stop unloads and disables", async () => {
    const { env } = setup()
    const { system, ran } = machine("darwin", {
      answers: { "launchctl print": { stdout: "\tstate = running\n\tpid = 77\n" } },
    })
    await call(["install"], env, system)

    expect((await call(["status", "--json"], env, system)).answer).toMatchObject({
      unit: { loaded: true, active: true, pid: 77 },
    })
    await call(["stop"], env, system)
    expect(ran.slice(-2)).toEqual([
      ["launchctl", "bootout", "gui/501/chat-cli.serve.default"],
      ["launchctl", "disable", "gui/501/chat-cli.serve.default"],
    ])
  })
})

it("where there is neither, install is refused and start still runs serve in the background", async () => {
  const { env } = setup()
  const refused = await call(["install"], env, machine("win32").system)
  expect(refused.code).not.toBe(0)
  expect(refused.stderr).toContain("chat server start")

  expect((await call(["start", "--json"], env, machine("win32").system)).answer).toMatchObject({ started: true })
})
