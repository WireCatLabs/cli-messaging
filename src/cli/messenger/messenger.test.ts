import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Chat, Message, WindowedMessage } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountFileFor } from "./accounts.js"
import { accountCommand, chatsCommand, messagesCommand } from "./commands.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:00:00.000Z",
  participantsCount: 4,
}
const message: Message = {
  id: "1",
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "chapter three",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

const thread: Message[] = ["1", "2", "3"].map((id, index) => ({
  ...message,
  id,
  timestamp: `2026-09-27T10:0${index}:00.000Z`,
}))

const fake: MessengerAdapter = {
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat], hasMore: false }),
  history: async () => ({ items: [message], hasMore: false }),
  resolve: async () => chat,
  around: async (_chat, id, { before, after }) => {
    const index = thread.findIndex((one) => one.id === id)
    return thread
      .slice(Math.max(0, index - before), index + after + 1)
      .map((one) => (one.id === id ? { ...one, anchor: true as const } : one))
  },
  send: async () => ({ message, sendId: "1" }),
  logout: async () => {},
  close: async () => {},
}

const call = async (argv: string[], connect: Messenger["connect"], env: NodeJS.ProcessEnv) => {
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
    { app, commands: () => [accountCommand(messenger), chatsCommand(messenger), messagesCommand(messenger)] },
    { streams, tty: false, env },
  )
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

describe("the shared read commands", () => {
  it("**answer offline exactly what the messenger answered**, without connecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const online = async () => fake
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("--offline must never connect")
    }

    for (const argv of [
      ["chats", "list", "--json"],
      ["messages", "list", "Book", "--json"],
      ["messages", "context", "Book", "2", "--before", "1", "--after", "1", "--json"],
      ["messages", "show", "msg:chat/500/7/3", "--json"],
    ]) {
      const live = await call(argv, online, env)
      const offline = await call([...argv, "--offline"], never, env)
      expect(live.code).toBe(0)
      expect(offline).toEqual({ ...live, stderr: [] })
    }
  })

  it("mark the message asked for, and name one by its locator", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const context = await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const shown = await call(["messages", "show", "msg:chat/500/7/3", "--json"], async () => fake, env)
    const foreign = await call(["messages", "show", "msg:max/1/7/3"], async () => fake, env)

    expect(JSON.parse(context.stdout[0] ?? "").items.map((one: WindowedMessage) => [one.id, one.anchor])).toEqual([
      ["1", undefined],
      ["2", true],
      ["3", undefined],
    ])
    expect(JSON.parse(shown.stdout[0] ?? "")).toMatchObject({ id: "3", anchor: true })
    expect(foreign.code).toBe(2)
  })

  it("keep the account file where tg-cli 0.x kept it", () => {
    const tg = { command: "tg", appName: "tg-cli", envPrefix: "TG", description: "", version: "0" }
    expect(accountFileFor(tg, "work", { TG_STATE_DIR: "/state" })).toBe("/state/accounts/work.json")
  })
})
