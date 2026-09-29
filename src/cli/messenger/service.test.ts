import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"
import { type Ran, type ServiceSystem, serviceCommand } from "./service-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => ({}) as MessengerAdapter,
  chatArgument: "a chat",
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "service-"))
  const env = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "m.db"),
    CHAT_API_HASH: "never-in-a-unit",
  }
  return { root, env }
}

const fakeSystem = (platform: NodeJS.Platform, answers: Record<string, Partial<Ran>> = {}) => {
  const ran: string[][] = []
  const system: ServiceSystem = {
    platform,
    uid: 501,
    entry: ["/opt/node", "/opt/chat/bin/chat.js"],
    run: async (argv) => {
      ran.push(argv)
      const answer = Object.entries(answers).find(([prefix]) => argv.join(" ").startsWith(prefix))?.[1] ?? {}
      return { code: 0, stdout: "", stderr: "", ...answer }
    },
  }
  return { system, ran }
}

const call = async (argv: string[], env: NodeJS.ProcessEnv, system: ServiceSystem) => {
  const streams = captureStreams()
  const code = await run(
    ["service", ...argv],
    { app, commands: () => [serviceCommand(messenger)] },
    { streams, tty: false, env, system },
  )
  return {
    code,
    answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined,
    stdout: streams.stdout,
    stderr: streams.stderr.join("\n"),
  }
}

const unitPath = (env: { XDG_CONFIG_HOME: string }, profile = "default") =>
  join(env.XDG_CONFIG_HOME, "systemd", "user", `chat-serve-${profile}.service`)

const showing = (active: string, pid = 0) => ({
  "systemctl --user show": { stdout: `LoadState=loaded\nActiveState=${active}\nSubState=running\nMainPID=${pid}\n` },
})

describe("service on systemd", () => {
  it("**install writes the unit and neither starts nor enables it**", async () => {
    const { env } = setup()
    const { system, ran } = fakeSystem("linux")

    const { code, answer } = await call(["install"], env, system)

    expect(code).toBe(0)
    expect(ran).toEqual([])
    expect(answer).toMatchObject({ unit: "chat-serve-default.service", path: unitPath(env), replaced: false })
    const unit = readFileSync(unitPath(env), "utf8")
    expect(unit).toContain('ExecStart="/opt/node" "/opt/chat/bin/chat.js" "serve"')
    expect(unit).toContain('Environment="CHAT_PROFILE=default"')
    expect(unit).toContain(`Environment="CHAT_STATE_DIR=${env.CHAT_STATE_DIR}"`)
    expect(unit).toContain(`Environment="MESSAGING_STORE=${env.MESSAGING_STORE}"`)
    expect(unit).not.toContain("never-in-a-unit")
  })

  it("one unit per profile, and a path's % and $ reach the program unexpanded", async () => {
    const { env } = setup()
    const system = { ...fakeSystem("linux").system, entry: ["/opt/node", "/opt/$HOME/100%/chat.js"] }
    await call(["install"], { ...env, CHAT_PROFILE: "work", CHAT_STATE_DIR: "/data/100%$HOME" }, system)

    const unit = readFileSync(unitPath(env, "work"), "utf8")
    expect(unit).toContain('Environment="CHAT_PROFILE=work"')
    // systemd.exec(5): in Environment= "the \"$\" character has no special meaning"; in ExecStart= it does.
    expect(unit).toContain('Environment="CHAT_STATE_DIR=/data/100%%$HOME"')
    expect(unit).toContain('"/opt/$$HOME/100%%/chat.js"')
  })

  it("start reloads and starts; stop stops; neither without an installed unit", async () => {
    const { env } = setup()
    const { system, ran } = fakeSystem("linux", showing("inactive"))

    const missing = await call(["start"], env, system)
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain("service install")

    await call(["install"], env, system)
    expect((await call(["start"], env, system)).answer).toMatchObject({ started: true })
    expect((await call(["stop"], env, system)).answer).toMatchObject({ stopped: true })
    expect(ran).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "start", "chat-serve-default.service"],
      ["systemctl", "--user", "stop", "chat-serve-default.service"],
    ])
  })

  it("start refuses while a serve started by hand holds the profile's lock", async () => {
    const { env } = setup()
    const { system, ran } = fakeSystem("linux", showing("inactive"))
    await call(["install"], env, system)
    mkdirSync(join(env.CHAT_STATE_DIR, "serve"), { recursive: true })
    writeFileSync(
      join(env.CHAT_STATE_DIR, "serve", "default.lock"),
      JSON.stringify({ pid: process.pid, startedAt: "x" }),
    )

    const { code, stderr } = await call(["start"], env, system)
    expect(code).not.toBe(0)
    expect(stderr).toContain(`PID ${process.pid}`)
    expect(ran.some((argv) => argv.includes("start"))).toBe(false)
  })

  it("a failing systemctl is reported with what it said", async () => {
    const { env } = setup()
    const { system } = fakeSystem("linux", { "systemctl --user start": { code: 1, stderr: "Unit not found." } })
    await call(["install"], env, system)

    const { code, stderr } = await call(["start"], env, system)
    expect(code).not.toBe(0)
    expect(stderr).toContain("Unit not found.")
  })

  it("status reads the unit and the lock, and says whether the service holds it", async () => {
    const { env } = setup()
    const { system } = fakeSystem("linux", showing("active", process.pid))
    expect((await call(["status"], env, system)).answer).toMatchObject({ installed: false, active: false })

    await call(["install"], env, system)
    mkdirSync(join(env.CHAT_STATE_DIR, "serve"), { recursive: true })
    writeFileSync(
      join(env.CHAT_STATE_DIR, "serve", "default.lock"),
      JSON.stringify({ pid: process.pid, startedAt: "2026-09-29T10:00:00.000Z" }),
    )

    expect((await call(["status"], env, system)).answer).toEqual({
      profile: "default",
      unit: "chat-serve-default.service",
      path: unitPath(env),
      installed: true,
      loaded: true,
      active: true,
      pid: process.pid,
      detail: "active (running)",
      serve: { running: true, pid: process.pid, since: "2026-09-29T10:00:00.000Z", byService: true },
    })
  })

  it("uninstall refuses while the unit runs, and removes it once stopped", async () => {
    const { env } = setup()
    await call(["install"], env, fakeSystem("linux").system)

    expect((await call(["uninstall"], env, fakeSystem("linux", showing("active", 42)).system)).code).not.toBe(0)
    expect(existsSync(unitPath(env))).toBe(true)

    expect((await call(["uninstall"], env, fakeSystem("linux", showing("inactive")).system)).answer).toMatchObject({
      removed: true,
    })
    expect(existsSync(unitPath(env))).toBe(false)
  })

  it("logs asks the journal for the unit's last lines", async () => {
    const { env } = setup()
    const { system, ran } = fakeSystem("linux", { journalctl: { stdout: "one\ntwo\n" } })
    await call(["install"], env, system)

    expect((await call(["logs", "-n", "2"], env, system)).answer).toMatchObject({ lines: ["one", "two"] })
    expect(ran.at(-1)).toEqual(["journalctl", "--user", "-u", "chat-serve-default.service", "-n", "2", "--no-pager"])
  })
})

describe("service on launchd", () => {
  it("install writes an agent that logs under the state folder; start loads it, stop unloads it", async () => {
    const { env } = setup()
    const { system, ran } = fakeSystem("darwin")
    const path = join(env.HOME, "Library", "LaunchAgents", "chat-cli.serve.default.plist")

    expect((await call(["install"], env, system)).answer).toMatchObject({ unit: "chat-cli.serve.default", path })
    expect(ran).toEqual([])
    const plist = readFileSync(path, "utf8")
    expect(plist).toContain("<string>/opt/chat/bin/chat.js</string>")
    expect(existsSync(join(env.CHAT_STATE_DIR, "serve"))).toBe(true)
    expect(plist).toContain(`<string>${join(env.CHAT_STATE_DIR, "serve", "default.log")}</string>`)

    await call(["start"], env, system)
    await call(["stop"], env, system)
    expect(ran.filter((argv) => argv[1] !== "print")).toEqual([
      ["launchctl", "bootstrap", "gui/501", path],
      ["launchctl", "bootout", "gui/501/chat-cli.serve.default"],
    ])
  })

  it("status reads launchctl print, and logs tails the log file", async () => {
    const { env } = setup()
    const { system } = fakeSystem("darwin", { "launchctl print": { stdout: "\tstate = running\n\tpid = 77\n" } })
    await call(["install"], env, system)
    mkdirSync(join(env.CHAT_STATE_DIR, "serve"), { recursive: true })
    writeFileSync(join(env.CHAT_STATE_DIR, "serve", "default.log"), "a\nb\nc\n")

    expect((await call(["status"], env, system)).answer).toMatchObject({ loaded: true, active: true, pid: 77 })
    expect((await call(["logs", "--lines", "2"], env, system)).answer).toMatchObject({ lines: ["b", "c"] })
  })

  it("an agent launchctl does not know is not loaded", async () => {
    const { env } = setup()
    const { system } = fakeSystem("darwin", { "launchctl print": { code: 113 } })
    await call(["install"], env, system)
    expect((await call(["status"], env, system)).answer).toMatchObject({
      installed: true,
      loaded: false,
      active: false,
    })
  })
})

it("another platform is refused with what to do instead", async () => {
  const { env } = setup()
  const { code, stderr } = await call(["install"], env, fakeSystem("win32").system)
  expect(code).not.toBe(0)
  expect(stderr).toContain("chat serve")
})
