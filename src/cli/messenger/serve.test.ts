import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { MessageEvent, MessageHit } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { ConnectOptions, Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"
import { serveCommand } from "./serve-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const hit: MessageHit = {
  id: "1",
  chatId: "7",
  chatTitle: "Book club",
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "hello",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "serve-"))
  return { root, env: { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") } }
}

const seen: { lock?: { pid: number; listeningAt?: string } } = {}

const call = async (argv: string[], env: NodeJS.ProcessEnv, asked: ConnectOptions[] = [], signal?: AbortSignal) => {
  const connect = async (_: unknown, __: unknown, options?: ConnectOptions) => {
    asked.push(options ?? {})
    return {
      self: () => "500",
      close: async () => {},
      watch: async (onEvent: (event: MessageEvent) => void, stop: AbortSignal, onReady?: () => void) => {
        onReady?.()
        seen.lock = JSON.parse(readFileSync(join(env.CHAT_STATE_DIR ?? "", "serve", "default.lock"), "utf8"))
        onEvent({ event: "message", message: hit })
        onEvent({ event: "delete", chatId: null, chatTitle: null, messageId: "1" })
        await new Promise((resolve) => stop.addEventListener("abort", resolve, { once: true }))
      },
    } as unknown as MessengerAdapter
  }
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [serveCommand(messenger)] },
    {
      streams,
      tty: false,
      env,
      ...(signal ? { signal } : {}),
    },
  )
  return { code, answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined, stderr: streams.stderr }
}

const lockOf = (root: string) => join(root, "state", "serve", "default.lock")
const holdLock = (root: string, pid: number) => {
  mkdirSync(join(root, "state", "serve"), { recursive: true })
  writeFileSync(lockOf(root), JSON.stringify({ pid, startedAt: "2026-09-27T09:00:00.000Z" }))
}

describe("serve", () => {
  it("**listens with catch-up, keeps what arrives, and leaves no lock behind**", async () => {
    const { root, env } = setup()
    const asked: ConnectOptions[] = []
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)

    const { code, answer } = await call(["serve", "--json"], env, asked, stop.signal)

    expect(code).toBe(0)
    expect(asked).toEqual([{ listen: true, catchUp: true }])
    expect(answer).toMatchObject({ profile: "default", kept: { message: 1, delete: 1 } })
    expect(seen.lock).toMatchObject({ pid: process.pid, listeningAt: expect.any(String) })
    expect(existsSync(lockOf(root))).toBe(false)
  })

  it("refuses while another serve of the profile is alive, and says which", async () => {
    const { root, env } = setup()
    holdLock(root, process.ppid)

    const { code, stderr } = await call(["serve"], env)
    expect(code).toBe(2)
    expect(stderr.join("\n")).toContain(`PID ${process.ppid}`)
  })

  it("takes over a lock whose process is gone", async () => {
    const { root, env } = setup()
    holdLock(root, 2 ** 22 + 12345)

    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)
    expect((await call(["serve", "--json"], env, [], stop.signal)).code).toBe(0)
  })
})
