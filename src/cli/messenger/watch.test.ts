import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { MessageHit } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { messagesCommand, watchCommand } from "./commands.js"
import type { ConnectOptions, Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const hit = (id: string): MessageHit => ({
  id,
  chatId: "7",
  chatTitle: "Book club",
  senderId: "9",
  senderName: "Olga",
  timestamp: `2026-09-27T10:0${id}:00.000Z`,
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const listening =
  (arrive: MessageHit[], asked: ConnectOptions[]) => async (_: unknown, __: unknown, options?: ConnectOptions) => {
    asked.push(options ?? {})
    return {
      self: () => "500",
      close: async () => {},
      watch: async (onMessage: (message: MessageHit) => void, signal: AbortSignal) => {
        for (const message of arrive) onMessage(message)
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      },
    } as unknown as MessengerAdapter
  }

const call = async (argv: string[], connect: Messenger["connect"], signal?: AbortSignal) => {
  const root = mkdtempSync(join(tmpdir(), "watch-"))
  const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
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
    { app, commands: () => [watchCommand(messenger), messagesCommand(messenger)] },
    {
      streams,
      tty: false,
      env,
      ...(signal ? { signal } : {}),
    },
  )
  return { code, streams, env, messenger }
}

describe("watch", () => {
  it("**streams each new message as one JSON line, keeps it, and ends normally when stopped**", async () => {
    const asked: ConnectOptions[] = []
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)

    const { code, streams, env } = await call(["watch", "--jsonl"], listening([hit("1"), hit("2")], asked), stop.signal)

    expect(code).toBe(0)
    expect(asked).toEqual([{ listen: true }])
    expect(streams.stdout.map((line) => JSON.parse(line).id)).toEqual(["1", "2"])
    const offline = captureStreams()
    const messenger: Messenger = {
      app,
      provider: "chat",
      resolveSettings: settingsFor(app).resolveSettings,
      connect: listening([], []),
      chatArgument: "a chat",
    }
    await run(
      ["messages", "list", "7", "--json", "--offline"],
      { app, commands: () => [messagesCommand(messenger)] },
      { streams: offline, tty: false, env },
    )
    expect(JSON.parse(offline.stdout[0] ?? "").items.map((one: { id: string }) => one.id)).toEqual(["1", "2"])
  })

  it("ends normally at --timeout", async () => {
    const { code } = await call(["watch", "--jsonl", "--timeout", "30ms"], listening([], []))
    expect(code).toBe(0)
  })

  it("refuses --json, which promises one value, and a messenger that cannot listen", async () => {
    expect((await call(["watch", "--json"], listening([], []))).code).toBe(2)
    const deaf = async () => ({ self: () => "500", close: async () => {} }) as unknown as MessengerAdapter
    expect((await call(["watch", "--jsonl", "--timeout", "30ms"], deaf)).code).toBe(2)
  })
})
