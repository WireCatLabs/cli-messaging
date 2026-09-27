import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import type { CommandInfo } from "@leemour/cli-core/commands"
import { describe, expect, it } from "vitest"
import type { Chat, Message, WindowedMessage } from "../../domain/models.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { commandsCommand } from "../commands-command.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountFileFor } from "./accounts.js"
import { exportCommand, syncCommand } from "./archive-commands.js"
import { accountCommand, chatsCommand, contactsCommand, messagesCommand } from "./commands.js"
import { completeCommand } from "./complete-command.js"
import type { Messenger } from "./context.js"
import { recipientsCommand, sendsCommand } from "./guard-commands.js"
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

const people: Chat[] = [
  { ...chat, id: "20", kind: "dialog", title: "Zoe", lastMessageAt: "2026-09-27T09:00:00.000Z" },
  {
    ...chat,
    id: "21",
    kind: "dialog",
    title: "Adam",
    lastMessageAt: "2026-09-26T09:00:00.000Z",
    providerMetadata: { username: "adam_k" },
  },
]

const fake: MessengerAdapter = {
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat, ...people], hasMore: false }),
  history: async () => ({ items: [message], hasMore: false }),
  resolve: async () => chat,
  contact: async () => ({
    id: "21",
    name: "Adam",
    username: "adam_k",
    description: null,
    lastMessagedAt: null,
    chats: [{ id: "7", title: "Book club", kind: "group", lastMessageAt: null }],
  }),
  chat: async () => ({ ...chat, members: [{ id: "9", name: "Olga", username: null }] }),
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
    {
      app,
      commands: () => [
        accountCommand(messenger),
        chatsCommand(messenger),
        messagesCommand(messenger),
        contactsCommand(messenger),
        recipientsCommand(messenger),
        sendsCommand(messenger),
        commandsCommand(app),
        completeCommand(messenger, settingsFor(app)),
        syncCommand(messenger),
        exportCommand(messenger),
      ],
    },
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
      ["contacts", "list", "--json"],
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

  it("show a chat with who is in it, and say when the list is cut short", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const { code, stdout, stderr } = await call(["chats", "show", "Book", "--json"], async () => fake, env)

    expect(code).toBe(0)
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ id: "7", members: [{ id: "9" }] })
    expect(stderr.join("\n")).toContain("only 1 of 4 members")
    expect((await call(["chats", "show", "Book", "--offline"], async () => fake, env)).code).toBe(2)
  })

  it("list as contacts only the one-to-one chats, in the order and with the filter asked for", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const names = async (...argv: string[]) =>
      JSON.parse(
        (await call(["contacts", "list", "--json", ...argv], async () => fake, env)).stdout[0] ?? "",
      ).items.map((one: { name: string }) => one.name)

    expect(await names()).toEqual(["Zoe", "Adam"])
    expect(await names("--order", "name")).toEqual(["Adam", "Zoe"])
    expect(await names("--search", "ADAM_")).toEqual(["Adam"])
    const shown = await call(["contacts", "show", "adam", "--json"], async () => fake, env)
    expect(JSON.parse(shown.stdout[0] ?? "")).toMatchObject({ id: "21", chats: [{ id: "7" }] })
  })

  it("**reply to the message named, record it without the text**, by chat and id or by locator", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const sent: { chatId: string; text: string; replyTo?: string }[] = []
    const replying: MessengerAdapter = {
      ...fake,
      send: async (chatId, text, { sendId, replyTo }) => {
        sent.push({ chatId, text, ...(replyTo ? { replyTo } : {}) })
        return { message: { ...message, text }, sendId }
      },
    }

    expect((await call(["messages", "reply", "Book", "2", "see you there"], async () => replying, env)).code).toBe(0)
    expect(
      (await call(["messages", "reply", "msg:chat/500/7/3", "and bring it"], async () => replying, env)).code,
    ).toBe(0)
    expect((await call(["messages", "send", "Book", "hello"], async () => replying, env)).code).toBe(0)

    expect(sent).toEqual([
      { chatId: "7", text: "see you there", replyTo: "2" },
      { chatId: "7", text: "and bring it", replyTo: "3" },
      { chatId: "7", text: "hello" },
    ])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.map((entry) => [entry.outcome, entry.replyTo])).toEqual([
      ["sent", "2"],
      ["sent", "3"],
      ["sent", undefined],
    ])
    expect(JSON.stringify(journal)).not.toContain("see you there")
  })

  it("describe themselves for an agent, with the contract version and which ones write", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const { stdout } = await call(["commands", "--json"], async () => fake, { CHAT_STATE_DIR: root })
    const described = JSON.parse(stdout[0] ?? "")
    const flat = (list: CommandInfo[]): CommandInfo[] => list.flatMap((one) => [one, ...flat([...one.commands])])
    const find = (path: string[]) => flat(described.commands).find((one) => one.path.join(" ") === path.join(" "))

    expect(described).toMatchObject({ cli: "chat", contract: 0 })
    expect(find(["messages", "send"])?.mutates).toBe(true)
    expect(find(["recipients", "add"])?.mutates).toBe(true)
    expect(find(["messages", "list"])?.mutates).toBeFalsy()
  })

  it("**complete a chat from the store** — its id as the word, its title as the description", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["chats", "list"], async () => fake, env)

    const { stdout } = await call(["complete", "--", "chats", "show", ""], async () => fake, env)

    expect(stdout.join("\n")).toContain("7\tBook club")
  })

  it("never creates the store on a Tab", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }

    const { code } = await call(["complete", "--", "chats", "show", ""], async () => fake, env)

    expect(code).toBe(0)
    expect(existsSync(join(root, "m.db"))).toBe(false)
  })

  it("**search the store without connecting**, and name each hit by its locator", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("search must never connect")
    }

    const found = await call(["messages", "search", "chapt", "--json"], never, env)
    const hits = JSON.parse(found.stdout[0] ?? "").items
    expect(found.code).toBe(0)
    expect(hits.map((hit: { id: string }) => hit.id)).toEqual(["3", "2", "1"])
    expect(hits[0].locator).toBe("msg:chat/500/7/3")
    const elsewhere = await call(["messages", "search", "chapt", "--chat", "999", "--json"], never, env)
    expect(JSON.parse(elsewhere.stdout[0] ?? "").items).toEqual([])
  })

  it("**report and export what the store holds**, without connecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("the archive commands must never connect")
    }

    const status = await call(["sync", "status", "--json"], never, env)
    expect(JSON.parse(status.stdout[0] ?? "")).toMatchObject([{ chatId: "7", title: null, messages: 3, held: [] }])
    const exported = await call(["export", "7", "--jsonl"], never, env)
    expect(exported.stdout.map((line) => JSON.parse(line).id)).toEqual(["1", "2", "3"])
    const one = await call(["export", "7", "--json"], never, env)
    expect(one.stdout).toHaveLength(1)
  })

  it("keep the account file where tg-cli 0.x kept it", () => {
    const tg = { command: "tg", appName: "tg-cli", envPrefix: "TG", description: "", version: "0" }
    expect(accountFileFor(tg, "work", { TG_STATE_DIR: "/state" })).toBe("/state/accounts/work.json")
  })
})
