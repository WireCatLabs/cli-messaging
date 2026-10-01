import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import { holdLock, lockPath } from "../../background/lock.js"
import type { Chat, Message } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { storeCommand } from "./archive-commands.js"
import { chatsCommand } from "./chats-command.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import { inboxCommand } from "./inbox.js"
import { messagesCommand } from "./messages-command.js"
import type { MessengerAdapter } from "./port.js"
import { reviewCommand } from "./review.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const club: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:02:00.000Z",
  participantsCount: 4,
}
const zoe: Chat = { ...club, id: "20", kind: "dialog", title: "Zoe", participantsCount: 2 }
const thread: Message[] = ["1", "2", "3"].map((id, index) => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: `2026-09-27T10:0${index}:00.000Z`,
  editedAt: null,
  text: "chapter three",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}))

const server = (sent: string[] = []): MessengerAdapter => ({
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [club, zoe], hasMore: false }),
  history: async () => ({ items: thread, hasMore: false }),
  resolve: async (reference) => (reference === "Zoe" ? zoe : club),
  contact: async () => {
    throw new Error("unused")
  },
  chat: async () => ({ ...club, members: [] }),
  around: async () => [],
  send: async (chatId, text, { sendId }) => {
    sent.push(`${chatId}:${text}`)
    return { message: { ...thread[0], text } as Message, sendId }
  },
  logout: async () => {},
  close: async () => {},
})

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "store-mode-"))
  return {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

const call = async (argv: string[], env: NodeJS.ProcessEnv, connect: Messenger["connect"], history?: "store") => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
    ...(history ? { history } : {}),
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [
        chatsCommand(messenger),
        messagesCommand(messenger),
        contactsCommand(messenger),
        storeCommand(messenger),
        inboxCommand(messenger),
        reviewCommand(messenger),
      ],
    },
    { streams, tty: false, env },
  )
  return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
}

/** A store filled the way `serve` fills it: a server-mode run saves what it read. */
const filled = async () => {
  const env = sandbox()
  for (const argv of [
    ["chats", "list", "--json"],
    ["messages", "list", "Book", "--json"],
  ]) {
    expect((await call(argv, env, async () => server())).code).toBe(0)
  }
  return env
}

const pushing = () => {
  const connects: number[] = []
  const sent: string[] = []
  const connect: Messenger["connect"] = async () => {
    connects.push(1)
    return server(sent)
  }
  return { connects, sent, connect }
}

describe("a messenger whose history is read from the store", () => {
  it("**answers chats, messages and contacts from the store and never connects**", async () => {
    const env = await filled()
    const { connects, connect } = pushing()

    const chats = await call(["chats", "list", "--json"], env, connect, "store")
    const messages = await call(["messages", "list", "Book", "--json"], env, connect, "store")
    const context = await call(
      ["messages", "context", "7", "2", "--before-n", "1", "--after-n", "0", "--json"],
      env,
      connect,
      "store",
    )
    const shown = await call(["chats", "show", "Book", "--json"], env, connect, "store")
    const contacts = await call(["contacts", "list", "--json"], env, connect, "store")

    expect(JSON.parse(chats.stdout).items.map((one: Chat) => one.id)).toEqual(["7", "20"])
    expect(JSON.parse(messages.stdout).items.map((one: Message) => one.id)).toEqual(["1", "2", "3"])
    expect(JSON.parse(context.stdout).items.map((one: Message) => one.id)).toEqual(["1", "2"])
    expect(JSON.parse(shown.stdout)).toMatchObject({ id: "7", title: "Book club" })
    expect(JSON.parse(contacts.stdout).items.map((one: { name: string }) => one.name)).toEqual(["Zoe"])
    expect(connects).toEqual([])
  })

  it("**says how to fill an empty store**: `serve` or `watch`, not --offline", async () => {
    const { connects, connect } = pushing()
    const { code, stderr } = await call(["messages", "list", "Book", "--json"], sandbox(), connect, "store")

    expect(code).not.toBe(0)
    expect(stderr).toContain("run `chat serve` or `chat watch` once to fill the local store")
    expect(stderr).not.toContain("--offline")
    expect(connects).toEqual([])
  })

  it("**answers not_found for a chat with nothing stored**, known or not", async () => {
    const env = await filled()
    const { connect } = pushing()

    for (const chat of ["Zoe", "999", "Nobody"]) {
      const { code, stdout, stderr } = await call(["messages", "list", chat, "--json"], env, connect, "store")
      expect(code).not.toBe(0)
      expect(stdout).toBe("")
      expect(stderr).toContain('"code":"not_found"')
      expect(stderr).toContain("nothing stored for this chat yet — keep `chat serve` running")
    }
    const shown = await call(["chats", "show", "Nobody", "--json"], env, connect, "store")
    expect(shown.stderr).toContain("nothing stored for this chat yet")
  })

  it("**still connects to write**, through the guard", async () => {
    const env = await filled()
    const { connects, sent, connect } = pushing()

    const { code } = await call(["messages", "send", "Book", "see you"], env, connect, "store")

    expect(code).toBe(0)
    expect(connects).toEqual([1])
    expect(sent).toEqual(["7:see you"])
  })

  it("**refuses what it cannot answer from the store** before connecting", async () => {
    const env = await filled()
    const { connects, connect } = pushing()

    for (const argv of [
      ["store", "fetch", "Book"],
      ["store", "fetch", "Book", "--estimate"],
      ["messages", "list", "Book", "--after-id", "1"],
      ["messages", "list", "Book", "--before-time", "2h"],
      ["inbox"],
      ["review"],
    ]) {
      const { code, stderr } = await call(argv, env, connect, "store")
      expect(code, argv.join(" ")).toBe(2)
      expect(stderr).toContain("this messenger")
    }
    expect(connects).toEqual([])
  })

  it("**warns on stderr when no `serve` keeps the store up to date**, with its newest message", async () => {
    const env = await filled()
    const { connect } = pushing()

    const alone = await call(["messages", "list", "Book", "--json"], env, connect, "store")
    holdLock(lockPath(app, "default", env), { pid: process.pid, startedAt: new Date().toISOString() })
    const served = await call(["messages", "list", "Book", "--json"], env, connect, "store")

    expect(alone.stderr).toContain(
      'no `chat serve` keeps profile "default" up to date — the newest stored message is from 2026-09-27T10:02:00.000Z',
    )
    expect(JSON.parse(alone.stdout).items).toHaveLength(3)
    expect(served.stderr).toBe("")
    expect(served.stdout).toBe(alone.stdout)
  })

  it("leaves a server-mode messenger's empty chat an empty answer offline", async () => {
    const env = await filled()
    const offline = await call(["messages", "list", "999", "--offline", "--json"], env, async () => server())

    expect(offline.code).toBe(0)
    expect(JSON.parse(offline.stdout).items).toEqual([])
  })
})
