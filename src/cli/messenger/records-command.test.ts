import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { CallRecord, Chat, Message } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountCommand } from "./account-command.js"
import { chatsCommand } from "./chats-command.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"
import { callsCommand } from "./records-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 3,
}
const message = (id: string): Message =>
  ({
    id,
    chatId: "7",
    senderId: "9",
    text: "",
    sentAt: "2026-10-08T00:00:00.000Z",
    attachments: [],
  }) as unknown as Message
const call: CallRecord = {
  id: "1",
  chatId: "7",
  callerId: "9",
  direction: "incoming",
  outcome: "missed",
  kind: "audio",
  at: "2026-10-08T00:00:00.000Z",
  durationSeconds: null,
}

const base: MessengerAdapter = {
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat], hasMore: false }),
  history: async () => ({ items: [], hasMore: false }),
  resolve: async () => chat,
  chat: async () => ({ ...chat, members: null }),
  contact: async () => ({ id: "9", name: "Olga", username: null, description: null, lastMessagedAt: null, chats: [] }),
  around: async () => [],
  send: async () => {
    throw new Error("never sends")
  },
  logout: async () => {},
  close: async () => {},
}

const invoke = async (argv: string[], adapter: MessengerAdapter, own: Partial<Messenger> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "records-"))
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => adapter,
    chatArgument: "a chat",
    ...own,
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [chatsCommand(messenger), accountCommand(messenger), callsCommand(messenger)] },
    {
      streams,
      tty: false,
      env: { CHAT_STATE_DIR: join(root, "s"), CHAT_CONFIG_DIR: join(root, "c"), MESSAGING_STORE: join(root, "m.db") },
    },
  )
  return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("") }
}

describe("reads only the server answers", () => {
  it("`chats media` asks for the kinds named, pages back by message id, and exists only where the messenger offers it", async () => {
    const asked: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      media: async (chatId, window) => {
        asked.push([chatId, window])
        return { items: [message("41"), message("42")], hasMore: true }
      },
    }
    const shown = await invoke(
      ["chats", "media", "Book club", "--type", "photo,link", "--limit", "2", "--before-id", "50", "--json"],
      adapter,
      { chatMedia: true },
    )
    const wrong = await invoke(["chats", "media", "Book club", "--type", "gif"], adapter, { chatMedia: true })
    const elsewhere = await invoke(["chats", "media", "Book club"], adapter)

    expect(JSON.parse(shown.stdout)).toMatchObject({ items: [{ id: "41" }, { id: "42" }], hasMore: true, limit: 2 })
    expect(asked).toEqual([["7", { kinds: ["photo", "link"], limit: 2, before: "50" }]])
    expect(wrong.code).toBe(2)
    expect(elsewhere.code).not.toBe(0)
  })

  it("`calls list` lists calls newest first, and says plainly when the messenger cannot", async () => {
    const listed = await invoke(["calls", "list", "--json"], {
      ...base,
      calls: async () => ({ items: [call], hasMore: false }),
    })
    const cannot = await invoke(["calls", "list"], base)

    expect(JSON.parse(listed.stdout)).toMatchObject({ items: [call], hasMore: false })
    expect(cannot.stderr).toContain("cannot list calls")
  })

  it("`account privacy show` prints what the messenger reports, only where it offers it", async () => {
    const adapter: MessengerAdapter = { ...base, privacy: async () => ({ findByPhone: "contacts", hideOnline: false }) }
    const shown = await invoke(["account", "privacy", "show", "--json"], adapter, { privacy: true })
    const elsewhere = await invoke(["account", "privacy", "show"], adapter)

    expect(JSON.parse(shown.stdout)).toEqual({ findByPhone: "contacts", hideOnline: false })
    expect(elsewhere.code).not.toBe(0)
  })
})
