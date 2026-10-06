import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as rendering from "../../charts/render.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"
import { statsCommand } from "./stats-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }

const setup = async ({
  online = false,
  complete = false,
  config,
}: {
  online?: boolean
  complete?: boolean
  config?: object
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), "charts-cli-"))
  const env = {
    ...process.env,
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    NO_COLOR: "1",
  }
  if (config) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(config))
  }
  const account = { provider: "chat", account: "500" }
  rememberAccount(app, "default", account.account, env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.saveChats(account, [
    {
      id: "7",
      title: "Synthetic club",
      participantsCount: 2,
      kind: "group",
      unreadCount: 0,
      lastMessageAt: "2026-09-03T00:00:00.000Z",
    },
  ])
  await store.saveMessages(
    account,
    "7",
    ["01", "03"].map((day, index) => ({
      id: String(index + 1),
      chatId: "7",
      senderId: "11",
      timestamp: `2026-09-${day}T00:00:00.000Z`,
      text: "synthetic",
      senderName: "Synthetic author",
      editedAt: null,
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
      outgoing: false,
      attachments: [],
    })),
    { via: "test" },
  )
  if (complete) {
    await store.markRange(account, "7", 1, 2)
    await store.setSyncState(account, "history_start:7", "1")
  }
  await store.close()
  const connect = vi.fn(async () => {
    if (!online) throw new Error("offline chart connected")
    return {
      self: () => "500",
      close: async () => {},
      admins: async () => [],
      chatEvents: async () => ({
        chatId: "7",
        since: "2026-09-01T00:00:00Z",
        more: false,
        events: [
          { messageId: "8", timestamp: "2026-09-02T00:00:00Z", event: "join", actorId: "500", people: [{ id: "20" }] },
        ],
      }),
    } as unknown as MessengerAdapter
  })
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
  }
  const call = async (args: string[] = [], tty = false) => {
    const streams = captureStreams()
    const code = await run(
      ["stats", "charts", "7", "--since-time", "2026-09-01T00:00:00Z", ...(online ? [] : ["--offline"]), ...args],
      { app, commands: () => [statsCommand(messenger)] },
      { streams, tty, env },
    )
    return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
  }
  return { root, call, connect }
}

afterEach(() => vi.restoreAllMocks())

describe("stats charts", () => {
  it("returns neutral JSON without loading a renderer or connecting", async () => {
    const load = vi.spyOn(rendering, "chartRenderer")
    const { call, connect } = await setup()
    const result = await call(["--chart-kind", "active", "--by", "day", "--timezone", "Europe/Madrid", "--json"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      chart: {
        kind: "line",
        timezone: "Europe/Madrid",
        partial: true,
        x: { values: ["2026-09-01", "2026-09-02", "2026-09-03"] },
        series: [{ values: [1, null, 1] }],
      },
    })
    expect(result.stderr).toContain("partial data")
    expect(load).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it("writes a dark SVG privately and never replaces a file or symlink", async () => {
    const { call, root } = await setup({ complete: true })
    const path = join(root, "activity.svg")
    const result = await call(["--output", path])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      chart: { partial: false },
      chartFile: { path, format: "svg", width: 800, height: 400 },
    })
    const svg = readFileSync(path, "utf8")
    expect(svg).toContain('fill="#111827"')
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(result.stderr).toContain("chart written")
    expect((await call(["--output", path])).code).toBe(2)
    expect(readFileSync(path, "utf8")).toBe(svg)
    if (process.platform !== "win32") {
      const linked = join(root, "linked.svg")
      symlinkSync(path, linked)
      expect((await call(["--output", linked])).code).toBe(2)
      expect(readFileSync(path, "utf8")).toBe(svg)
    }
  })

  it("uses weekly buckets and leaves its online source's events unchanged", async () => {
    const { call, connect } = await setup({ online: true, complete: true })
    const result = await call(["--chart-kind", "membership", "--by", "week", "--timezone", "UTC"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      chart: { kind: "grouped-bar", x: { values: ["2026-08-31"] }, series: [{ values: [1] }, { values: [0] }] },
    })
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it("renders data in pretty mode and respects quiet", async () => {
    const { call, root } = await setup()
    expect((await call([], true)).stdout).toContain("Messages per day")
    const quiet = await call(["--quiet", "--output", join(root, "quiet.svg")])
    expect(quiet.code).toBe(0)
    expect(JSON.parse(quiet.stdout)).toHaveProperty("chartFile")
    expect(quiet.stderr).toBe("")
  })

  it("refuses invalid outputs and inputs without connecting", async () => {
    const { call, connect } = await setup()
    for (const args of [
      ["--jsonl"],
      ["--output", "-"],
      ["--output", "chart.png"],
      ["--chart-kind", "pie"],
      ["--by", "hour"],
      ["--timezone", "invalid/zone"],
    ]) {
      const result = await call(args)
      expect(result.code).toBe(2)
      expect(result.stdout).toBe("")
    }
    expect(connect).not.toHaveBeenCalled()
    const membership = await call(["--chart-kind", "membership"])
    expect(membership.code).toBe(2)
    expect(membership.stderr).toContain("unavailable")
  })

  it("reports file and renderer failures instead of a successful chart", async () => {
    const { call, root } = await setup()
    const path = join(root, "missing", "chart.svg")
    const badFile = await call(["--output", path])
    expect(badFile.code).not.toBe(0)
    expect(badFile.stdout).toBe("")
    vi.spyOn(rendering, "chartRenderer").mockRejectedValue(new Error("renderer failed"))
    const badRenderer = await call(["--output", join(root, "failed.svg")])
    expect(badRenderer.code).not.toBe(0)
    expect(badRenderer.stderr).toContain("renderer failed")
    expect(existsSync(join(root, "failed.svg"))).toBe(false)
  })

  it("honours denied message reads before a chart is built", async () => {
    const load = vi.spyOn(rendering, "chartRenderer")
    const { call, connect } = await setup({ config: { defaults: { permissions: { messages: "deny" } } } })
    const result = await call()
    expect(result.code).toBe(5)
    expect(result.stdout).toBe("")
    expect(connect).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  })
})
