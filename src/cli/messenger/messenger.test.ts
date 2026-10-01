import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { CliError, captureStreams } from "@leemour/cli-core"
import type { CommandInfo } from "@leemour/cli-core/commands"
import { describe, expect, it } from "vitest"
import type { Chat, Member, Message, WindowedMessage } from "../../domain/models.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { commandsCommand } from "../commands-command.js"
import { type RunOptions, run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountCommand } from "./account-command.js"
import { accountFileFor } from "./accounts.js"
import { storeCommand } from "./archive-commands.js"
import { chatsCommand } from "./chats-command.js"
import { completeCommand } from "./complete-command.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import { safeName } from "./download-command.js"
import { recipientsCommand, sendsCommand } from "./guard-commands.js"
import { type McpEnvironment, mcpCommand } from "./mcp-command.js"
import { messagesCommand } from "./messages-command.js"
import { modelsCommand } from "./models-command.js"
import { pollsCommand } from "./polls-command.js"
import type { MessengerAdapter, SendOptions } from "./port.js"
import { reactionsCommand } from "./reactions-command.js"
import { topicsCommand } from "./topics-command.js"

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

const call = async (
  argv: string[],
  connect: Messenger["connect"],
  env: NodeJS.ProcessEnv,
  options: Partial<RunOptions & McpEnvironment> = {},
  own: Partial<Messenger> = {},
) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
    ...own,
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
        reactionsCommand(messenger),
        pollsCommand(messenger),
        contactsCommand(messenger),
        recipientsCommand(messenger),
        sendsCommand(messenger),
        commandsCommand(app),
        completeCommand(messenger, settingsFor(app)),
        storeCommand(messenger),
        mcpCommand(messenger),
        modelsCommand(messenger),
        topicsCommand(messenger),
      ],
    },
    { streams, tty: false, env, ...options },
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

  it("**send --reply-to answers the message named, with every send option, recorded without the text**", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = {
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const sent: { chatId: string; text: string; replyTo?: string; silent?: boolean }[] = []
    const replying: MessengerAdapter = {
      ...fake,
      send: async (chatId, text, { sendId, replyTo, silent }) => {
        sent.push({ chatId, text, ...(replyTo ? { replyTo } : {}), ...(silent ? { silent } : {}) })
        return { message: { ...message, text }, sendId }
      },
    }

    const answer = (argv: string[]) => call(["messages", "send", "Book", ...argv], async () => replying, env)
    expect((await answer(["see you there", "--reply-to", "2"])).code).toBe(0)
    expect((await answer(["and bring it", "--reply-to", "3", "--silent"])).code).toBe(0)
    expect((await answer(["hello"])).code).toBe(0)
    expect((await answer(["nothing", "--reply-to", " "])).code).not.toBe(0)
    expect((await call(["messages", "reply", "Book", "2", "hi"], async () => replying, env)).code).not.toBe(0)

    expect(sent).toEqual([
      { chatId: "7", text: "see you there", replyTo: "2" },
      { chatId: "7", text: "and bring it", replyTo: "3", silent: true },
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

  it("**send silently, without a preview, as Markdown** — and journal neither the text nor the marks", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const sent: SendOptions[] = []
    const texts: string[] = []
    const recording: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, options) => {
        texts.push(text)
        sent.push(options)
        return { message: { ...message, text }, sendId: options.sendId }
      },
    }

    const argv = ["messages", "send", "Book", "**secret** plan", "--silent", "--no-preview", "--md"]
    expect((await call(argv, async () => recording, env)).code).toBe(0)
    expect((await call(["messages", "send", "Book", "**as typed**"], async () => recording, env)).code).toBe(0)

    expect(texts).toEqual(["secret plan", "**as typed**"])
    expect(sent[0]).toMatchObject({ silent: true, noPreview: true, markup: [{ type: "bold", from: 0, length: 6 }] })
    expect(sent[1]).not.toHaveProperty("silent")
    expect(sent[1]).not.toHaveProperty("noPreview")
    expect(sent[1]).not.toHaveProperty("markup")
    const journal = JSON.stringify(new SendJournal(sendsPathFor(app, "default", env)).entries())
    expect(journal).not.toContain("secret")
    expect(journal).not.toContain("bold")
  })

  it("**schedule a send with --at**, answer scheduledFor, journal it for that hour, and never repeat one", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const sent: SendOptions[] = []
    const later: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, options) => {
        sent.push(options)
        return { message: { ...message, text, scheduledFor: options.at }, sendId: options.sendId }
      },
      scheduled: async () => [{ ...message, scheduledFor: "2030-01-01T09:00:00.000Z" }],
    }

    const scheduled = await call(["messages", "send", "Book", "later", "--at", "30m", "--json"], async () => later, env)
    const repeated = await call(
      ["messages", "send", "Book", "x", "--at", "1h", "--send-id", "5"],
      async () => later,
      env,
    )
    const listed = await call(["messages", "scheduled", "Book", "--json"], async () => later, env)

    expect(scheduled.code).toBe(0)
    const { scheduledFor } = JSON.parse(scheduled.stdout[0] ?? "")
    expect(sent.map((one) => one.at)).toEqual([scheduledFor])
    expect(Date.parse(scheduledFor) - Date.now()).toBeGreaterThan(28 * 60_000)
    expect(scheduled.stderr.join("\n")).toContain("scheduled for")
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([
      { outcome: "sent", scheduledFor },
    ])
    expect(repeated.code).toBe(2)
    expect(JSON.parse(listed.stdout[0] ?? "").items[0].scheduledFor).toBe("2030-01-01T09:00:00.000Z")
  })

  it("**send nothing when --at is not a time**, and point at the queue when a scheduled send is lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    let opened = false
    const lost: MessengerAdapter = {
      ...fake,
      send: async () => {
        throw new CliError("outcome_unknown", "no answer — repeat with --send-id 1", { sendId: "1" })
      },
    }

    const bad = await call(
      ["messages", "send", "Book", "x", "--at", "tomorrow"],
      async () => {
        opened = true
        return lost
      },
      env,
    )
    const unknown = await call(["messages", "send", "Book", "x", "--at", "1h"], async () => lost, env)

    expect(bad.code).toBe(2)
    expect(opened).toBe(false)
    const error = JSON.parse(unknown.stderr[0] ?? "").error
    expect(error.code).toBe("outcome_unknown")
    expect(error.message).toContain("messages scheduled")
    expect(error.sendId).toBeUndefined()
  })

  it("**send a photo with a caption**, journal its kind and size — never its name — and refuse a hidden file", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    writeFileSync(join(root, "holiday.png"), "12345")
    mkdirSync(join(root, ".secrets"))
    writeFileSync(join(root, ".secrets", "token"), "t")
    const sent: SendOptions[] = []
    const texts: string[] = []
    const withFiles: MessengerAdapter = {
      ...fake,
      send: async (_chatId, text, options) => {
        texts.push(text)
        sent.push(options)
        return { message: { ...message, text }, sendId: options.sendId }
      },
    }

    const photo = await call(
      ["messages", "send", "Book", "look", "--photo", join(root, "holiday.png")],
      async () => withFiles,
      env,
    )
    const hidden = await call(
      ["messages", "send", "Book", "--file", join(root, ".secrets", "token")],
      async () => withFiles,
      env,
    )

    expect(photo.code).toBe(0)
    expect(texts).toEqual(["look"])
    expect(sent[0]?.attachments).toMatchObject([{ kind: "photo", name: "holiday.png" }])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal).toMatchObject([{ outcome: "sent", attachments: [{ kind: "photo", bytes: 5 }] }])
    expect(JSON.stringify(journal)).not.toContain("holiday")
    expect(hidden.code).toBe(2)
    expect(sent).toHaveLength(1)
  })

  it("**edit the owner's message through the guard**, record it without the text, and answer the edited message", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const edits: string[][] = []
    const editing: MessengerAdapter = {
      ...fake,
      edit: async (chatId, messageId, text) => {
        edits.push([chatId, messageId, text])
        return { ...message, id: messageId, text, editedAt: "2026-09-29T10:00:00.000Z" }
      },
    }

    const done = await call(["messages", "edit", "Book", "3", "new plan", "--json"], async () => editing, env)
    const unable = await call(["messages", "edit", "Book", "3", "again"], async () => fake, env)

    expect(done.code).toBe(0)
    expect(JSON.parse(done.stdout[0] ?? "").message).toMatchObject({ id: "3", text: "new plan" })
    expect(edits).toEqual([["7", "3", "new plan"]])
    expect(unable.stderr.join("\n")).toContain("cannot edit a message")
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.filter((entry) => entry.outcome !== "reserved")).toMatchObject([
      { kind: "edit", outcome: "sent", chatId: "7", messageId: "3", length: 8 },
    ])
    expect(JSON.stringify(journal)).not.toContain("new plan")
  })

  it("**edit with --md takes the marks out and sends them as markup**, as a send does", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const edits: unknown[] = []
    const editing: MessengerAdapter = {
      ...fake,
      edit: async (_chatId, messageId, text, options) => {
        edits.push([text, options])
        return { ...message, id: messageId, text }
      },
    }

    const marked = await call(
      ["messages", "edit", "Book", "3", "**new** plan", "--md", "--json"],
      async () => editing,
      env,
    )
    const plain = await call(["messages", "edit", "Book", "3", "**new** plan", "--json"], async () => editing, env)

    expect(marked.code).toBe(0)
    expect(plain.code).toBe(0)
    expect(edits).toEqual([
      ["new plan", { markup: [{ type: "bold", from: 0, length: 3 }] }],
      ["**new** plan", {}],
    ])
  })

  it("**forward into the chat named by --to**, guarded against that chat, and answer the copy there", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const forwards: unknown[] = []
    const forwarding: MessengerAdapter = {
      ...fake,
      resolve: async (reference) => (reference === "Zoe" ? { ...chat, id: "20", title: "Zoe" } : chat),
      forward: async (from, id, to, options) => {
        forwards.push([from, id, to, options])
        return { ...message, id: "50", chatId: to }
      },
    }

    const done = await call(
      ["messages", "forward", "Book", "3", "--to", "Zoe", "--silent", "--json"],
      async () => forwarding,
      env,
    )

    expect(done.code).toBe(0)
    expect(JSON.parse(done.stdout[0] ?? "").message).toMatchObject({ id: "50", chatId: "20" })
    expect(forwards).toEqual([["7", "3", "20", { sendId: expect.any(String), silent: true }]])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.at(-1)).toMatchObject({ kind: "forward", outcome: "sent", chatId: "20", messageId: "50" })
  })

  it("**a forward repeated with its --send-id after an unknown outcome leaves one copy**", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const copies = new Map<string, Message>()
    let answered = false
    const deduplicating: MessengerAdapter = {
      ...fake,
      resolve: async (reference) => (reference === "Zoe" ? { ...chat, id: "20", title: "Zoe" } : chat),
      forward: async (_from, _id, to, { sendId }) => {
        const copy = copies.get(sendId) ?? { ...message, id: String(50 + copies.size), chatId: to }
        copies.set(sendId, copy)
        if (!answered) {
          answered = true
          throw new CliError("outcome_unknown", "no answer", { sendId })
        }
        return copy
      },
    }
    const forward = ["messages", "forward", "Book", "3", "--to", "Zoe", "--send-id", "9001", "--json"]

    expect((await call(forward, async () => deduplicating, env)).code).toBe(14)
    const repeated = await call(forward, async () => deduplicating, env)

    expect(repeated.code).toBe(0)
    expect(JSON.parse(repeated.stdout[0] ?? "")).toMatchObject({ sendId: "9001", message: { id: "50" } })
    expect(copies.size).toBe(1)
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.filter((entry) => entry.outcome !== "reserved")).toMatchObject([
      { kind: "forward", sendId: "9001", outcome: "outcome_unknown" },
      { kind: "forward", sendId: "9001", outcome: "sent", messageId: "50" },
    ])
  })

  it("**pin quietly without counting toward the hourly limit**; a pin that notifies counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { sendsPerHour: 1 } } }),
    )
    const pins: unknown[] = []
    const pinning: MessengerAdapter = {
      ...fake,
      pin: async (chatId, messageId, options) => {
        pins.push(["pin", chatId, messageId, options])
      },
      unpin: async (chatId, messageId) => {
        pins.push(["unpin", chatId, messageId])
      },
    }

    const quiet = await call(["messages", "pin", "Book", "3", "--json"], async () => pinning, env)
    const loud = await call(["messages", "pin", "Book", "4", "--notify"], async () => pinning, env)
    const over = await call(["messages", "pin", "Book", "5", "--notify"], async () => pinning, env)
    const off = await call(["messages", "unpin", "Book", "3", "--json"], async () => pinning, env)

    expect(JSON.parse(quiet.stdout[0] ?? "")).toEqual({
      operationId: expect.any(String),
      chatId: "7",
      messageId: "3",
      pinned: true,
    })
    expect([loud.code, over.code]).toEqual([0, 8])
    expect(JSON.parse(off.stdout[0] ?? "")).toEqual({
      operationId: expect.any(String),
      chatId: "7",
      messageId: "3",
      pinned: false,
    })
    expect(pins).toEqual([
      ["pin", "7", "3", { notify: false }],
      ["pin", "7", "4", { notify: true }],
      ["unpin", "7", "3"],
    ])
  })

  it("**react with one emoji and take it off**, journaled as reactions that do not count toward the limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { sendsPerHour: 1 } } }),
    )
    const reactions: unknown[] = []
    const reacting: MessengerAdapter = {
      ...fake,
      react: async (chatId, messageId, emoji) => {
        reactions.push([chatId, messageId, emoji])
      },
    }

    await call(["messages", "send", "Book", "spends the hour"], async () => reacting, env)
    const added = await call(["reactions", "add", "Book", "3", "👍", "--json"], async () => reacting, env)
    const removed = await call(["reactions", "remove", "Book", "3", "--json"], async () => reacting, env)

    expect(JSON.parse(added.stdout[0] ?? "")).toEqual({
      operationId: expect.any(String),
      chatId: "7",
      messageId: "3",
      reaction: "👍",
    })
    expect(JSON.parse(removed.stdout[0] ?? "")).toEqual({
      operationId: expect.any(String),
      chatId: "7",
      messageId: "3",
      reaction: null,
    })
    expect(reactions).toEqual([
      ["7", "3", "👍"],
      ["7", "3", null],
    ])
  })

  it("**mark a chat read, to its newest message or --until one**, journaled as a read", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const marks: unknown[] = []
    const reading: MessengerAdapter = {
      ...fake,
      markRead: async (chatId, until) => {
        marks.push([chatId, until])
      },
    }

    const all = await call(["chats", "mark-read", "Book", "--json"], async () => reading, env)
    const some = await call(["chats", "mark-read", "Book", "--until", "3", "--json"], async () => reading, env)

    expect(JSON.parse(all.stdout[0] ?? "")).toEqual({ operationId: expect.any(String), chatId: "7", until: null })
    expect(JSON.parse(some.stdout[0] ?? "")).toEqual({ operationId: expect.any(String), chatId: "7", until: "3" })
    expect(marks).toEqual([
      ["7", undefined],
      ["7", "3"],
    ])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.map((entry) => [entry.kind, entry.messageId])).toEqual([
      ["read", undefined],
      ["read", "3"],
    ])
    expect((await call(["chats", "read", "Book"], async () => reading, env)).code).not.toBe(0)
  })

  it("guards with the messenger's own guard when it has one", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const asked: unknown[] = []
    const refusing = {
      guard: () => ({
        check: (request: unknown) => {
          asked.push(request)
          throw new CliError("permission_error", "the messenger's own guard said no")
        },
        record: () => {},
      }),
    }

    const refused = await call(
      ["reactions", "add", "Book", "3", "👍"],
      async () => ({ ...fake, react: async () => {} }),
      env,
      {},
      refusing,
    )

    expect(refused.code).toBe(5)
    expect(refused.stderr.join("\n")).toContain("the messenger's own guard said no")
    expect(asked).toMatchObject([{ chatId: "7", kind: "reaction", messageId: "3" }])
  })

  it("hands the run's diagnostics to connect, so a messenger can report its own wire", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const traced = await call(
      ["reactions", "add", "Book", "3", "👍", "--json", "--trace"],
      async (_command, _context, options) => {
        options?.events?.({ event: "request", operation: "wire.frame", opcode: 178, seq: 1 })
        return { ...fake, react: async () => {} }
      },
      env,
    )

    expect(traced.stderr.join("\n")).toContain('"operation":"wire.frame","opcode":178')
  })

  it("**delete only with --allow-dangerous**, each message counted toward the hourly limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { sendsPerHour: 3 } } }),
    )
    const deletions: unknown[] = []
    const deleting: MessengerAdapter = {
      ...fake,
      delete: async (chatId, ids, options) => {
        deletions.push([chatId, ids, options])
      },
    }
    const eleven = Array.from({ length: 11 }, (_, index) => String(index + 1))

    const unasked = await call(["messages", "delete", "Book", "3"], async () => deleting, env)
    const tooMany = await call(
      ["messages", "delete", "Book", ...eleven, "--allow-dangerous"],
      async () => deleting,
      env,
    )
    const done = await call(
      ["messages", "delete", "Book", "3", "4", "--for-everyone", "--allow-dangerous", "--json", "--trace"],
      async () => deleting,
      env,
    )
    const over = await call(["messages", "delete", "Book", "5", "6", "--allow-dangerous"], async () => deleting, env)

    expect(unasked.stderr.join("\n")).toContain("--allow-dangerous")
    expect(tooMany.stderr.join("\n")).toContain("at most 10")
    const answer = JSON.parse(done.stdout[0] ?? "")
    expect(answer).toEqual({ operationId: expect.any(String), chatId: "7", deleted: ["3", "4"], forEveryone: true })
    expect(over.code).toBe(8)
    expect(deletions).toEqual([["7", ["3", "4"], { forEveryone: true }]])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.filter((entry) => entry.outcome === "sent")).toMatchObject([
      { kind: "delete", count: 2, forEveryone: true, operationId: answer.operationId },
    ])
    expect(done.stderr.join("\n")).toContain(`"ids":{"operation":"${answer.operationId}"}`)
  })

  it("**asks before a write whose level is ask**, refuses one that is readonly, and never asks at allow", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const config = (permissions: Record<string, string>) => {
      mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
      writeFileSync(
        join(env.CHAT_CONFIG_DIR, "config.json"),
        JSON.stringify({ profiles: { default: { permissions } } }),
      )
    }
    const deletions: unknown[] = []
    const reactions: unknown[] = []
    const adapter: MessengerAdapter = {
      ...fake,
      delete: async (chatId, ids) => {
        deletions.push([chatId, ids])
      },
      react: async (chatId, id, emoji) => {
        reactions.push([chatId, id, emoji])
      },
    }
    const questions: string[] = []
    const answering = (answer: string | null) => ({
      answer: (question: string) => {
        questions.push(question)
        return answer
      },
    })

    const declined = await call(["messages", "delete", "Book", "3"], async () => adapter, env, answering("n"))
    const agreed = await call(["messages", "delete", "Book", "4"], async () => adapter, env, answering("y"))
    const unattended = await call(["messages", "delete", "Book", "5"], async () => adapter, env, answering(null))
    config({ reactions: "ask", "messages.delete": "allow" })
    const reacted = await call(
      ["reactions", "add", "Book", "6", "👍", "--yes"],
      async () => adapter,
      env,
      answering(null),
    )
    const allowed = await call(["messages", "delete", "Book", "7"], async () => adapter, env, answering(null))
    config({ messages: "readonly" })
    const readonly = await call(["messages", "delete", "Book", "8", "--allow-dangerous"], async () => adapter, env)

    expect(declined.code).toBe(130)
    expect(unattended.code).toBe(7)
    expect(unattended.stderr.join("\n")).toContain("--allow-dangerous")
    expect(questions).toEqual([
      "messages.delete, 1 item, in chat 7 — go ahead? [y/N] ",
      "messages.delete, 1 item, in chat 7 — go ahead? [y/N] ",
      "messages.delete, 1 item, in chat 7 — go ahead? [y/N] ",
    ])
    expect([agreed.code, reacted.code, allowed.code]).toEqual([0, 0, 0])
    expect(deletions).toEqual([
      ["7", ["4"]],
      ["7", ["7"]],
    ])
    expect(reactions).toHaveLength(1)
    expect(readonly.code).toBe(5)
    expect(readonly.stderr.join("\n")).toContain("permissions.messages is readonly")
  })

  it("**refuses a denied read before connecting**, and leaves the rest readable", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({ profiles: { default: { permissions: { messages: "deny" } } } }),
    )
    let connected = 0
    const counting = async () => {
      connected += 1
      return fake
    }

    const listed = await call(["messages", "list", "Book"], counting, env)
    const exported = await call(["store", "export", "Book"], counting, env)
    const chats = await call(["chats", "list", "--json"], counting, env)

    expect([listed.code, exported.code]).toEqual([5, 5])
    expect(listed.stderr.join("\n")).toContain("permissions.messages is deny")
    expect(chats.code).toBe(0)
    expect(connected).toBe(1)
  })

  it("**show a poll with its answer ids, vote by id and take it back**, close it as an edit, create one as a message", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
    const poll = {
      chatId: "7",
      messageId: "3",
      question: "Friday?",
      answers: [
        { id: "MA", text: "yes", voters: null, chosen: false },
        { id: "MQ", text: "no", voters: null, chosen: false },
      ],
      closed: false,
      multiple: false,
      anonymous: false,
      voters: null,
    }
    const calls: unknown[] = []
    const polling: MessengerAdapter = {
      ...fake,
      poll: async () => poll,
      vote: async (chatId, messageId, ids) => {
        calls.push(["vote", chatId, messageId, ids])
        return poll
      },
      closePoll: async (chatId, messageId) => {
        calls.push(["close", chatId, messageId])
        return { ...poll, closed: true }
      },
      createPoll: async (chatId, created, { sendId }) => {
        calls.push(["create", chatId, created, sendId])
        return { message: { ...message, id: "9" }, sendId }
      },
    }

    const shown = await call(["polls", "show", "Book", "3", "--json"], async () => polling, env)
    const none = await call(["polls", "vote", "Book", "3"], async () => polling, env)
    await call(["polls", "vote", "Book", "3", "MQ"], async () => polling, env)
    await call(["polls", "vote", "Book", "3", "--retract"], async () => polling, env)
    const closed = await call(["polls", "close", "Book", "3", "--json"], async () => polling, env)
    const created = await call(
      ["polls", "create", "Book", "Where?", "here", "there", "--multiple", "--revote", "--send-id", "42", "--json"],
      async () => polling,
      env,
    )

    expect(JSON.parse(shown.stdout[0] ?? "").answers.map((one: { id: string }) => one.id)).toEqual(["MA", "MQ"])
    expect(none.stderr.join("\n")).toContain("polls show")
    expect(JSON.parse(closed.stdout[0] ?? "").poll.closed).toBe(true)
    expect(JSON.parse(created.stdout[0] ?? "")).toMatchObject({ sendId: "42", operationId: "42", message: { id: "9" } })
    expect(calls).toEqual([
      ["vote", "7", "3", ["MQ"]],
      ["vote", "7", "3", []],
      ["close", "7", "3"],
      [
        "create",
        "7",
        { question: "Where?", answers: ["here", "there"], multiple: true, anonymous: false, revote: true },
        "42",
      ],
    ])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries().filter((one) => one.outcome === "sent")
    expect(journal.map((one) => [one.kind, one.messageId])).toEqual([
      ["reaction", "3"],
      ["reaction", "3"],
      ["edit", "3"],
      ["message", "9"],
    ])
  })

  it("describe themselves for an agent, with the contract version and which ones write", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const { stdout } = await call(["commands", "--json"], async () => fake, { CHAT_STATE_DIR: root })
    const described = JSON.parse(stdout[0] ?? "")
    const flat = (list: CommandInfo[]): CommandInfo[] => list.flatMap((one) => [one, ...flat([...one.commands])])
    const find = (path: string[]) => flat(described.commands).find((one) => one.path.join(" ") === path.join(" "))

    expect(described).toMatchObject({ cli: "chat", contract: 0 })
    expect(find(["messages", "send"])?.mutates).toBe(true)
    expect(find(["messages", "edit"])?.mutates).toBe(true)
    expect(find(["messages", "forward"])?.mutates).toBe(true)
    expect(find(["messages", "pin"])?.mutates).toBe(true)
    expect(find(["messages", "unpin"])?.mutates).toBe(true)
    expect(find(["reactions", "add"])?.mutates).toBe(true)
    expect(find(["messages", "delete"])?.mutates).toBe(true)
    expect(find(["polls", "vote"])?.mutates).toBe(true)
    expect(find(["polls", "show"])?.mutates).toBeFalsy()
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
    const pattern = await call(["messages", "search", "--regex", "ch.pt", "--limit", "1", "--json"], never, env)
    expect(JSON.parse(pattern.stdout[0] ?? "")).toMatchObject({ items: [{ id: "3" }], hasMore: true })
    const broken = await call(["messages", "search", "--regex", "(", "--json"], never, env)
    expect(broken.code).toBe(2)
    expect(broken.stderr.join("\n")).toContain("not a regular expression")
  })

  it("**report and export what the store holds**, without connecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("the archive commands must never connect")
    }

    const status = await call(["store", "status", "--json"], never, env)
    expect(JSON.parse(status.stdout[0] ?? "")).toMatchObject([{ chatId: "7", title: null, messages: 3, held: [] }])
    const exported = await call(["store", "export", "7", "--jsonl"], never, env)
    expect(exported.stdout.map((line) => JSON.parse(line).id)).toEqual(["1", "2", "3"])
    const one = await call(["store", "export", "7", "--json"], never, env)
    expect(one.stdout).toHaveLength(1)
    const transcript = await call(["store", "export", "7", "--format", "markdown"], never, env)
    expect(transcript.stdout.join("\n")).toMatch(/^# 7\n\n## \d{4}-\d{2}-\d{2}\n\n\*\*\d{2}:\d{2} /)
    expect((await call(["store", "export", "7", "--format", "html"], never, env)).code).not.toBe(0)
    expect((await call(["export", "7"], never, env)).code).not.toBe(0)
    expect((await call(["sync", "status"], never, env)).code).not.toBe(0)
  })

  it("**export to a new file only the owner can read**, from --since on, and never over a file", async () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    await call(["messages", "context", "Book", "2", "--json"], async () => fake, env)
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("the archive commands must never connect")
    }
    const file = join(root, "book.jsonl")

    const written = await call(
      ["store", "export", "7", "--output", file, "--since", "2026-09-27T10:01:00Z", "--json"],
      never,
      env,
    )
    const again = await call(["store", "export", "7", "--output", file], never, env)

    expect(written.code).toBe(0)
    expect(JSON.parse(written.stdout[0] ?? "")).toEqual({ path: file, format: "jsonl", count: 2 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).id),
    ).toEqual(["2", "3"])
    expect(again.code).toBe(2)
    expect(again.stderr.join("\n")).toContain("never overwrites")
    expect((await call(["store", "export", "7", "--since", "4242"], never, env)).code).toBe(2)
  })

  it("keep the account file where tg-cli 0.x kept it", () => {
    const tg = { command: "tg", appName: "tg-cli", envPrefix: "TG", description: "", version: "0" }
    expect(accountFileFor(tg, "work", { TG_STATE_DIR: "/state" })).toBe("/state/accounts/work.json")
  })
})

describe("messages download", () => {
  const bytes = (text: string) =>
    async function* () {
      yield new TextEncoder().encode(text)
    }
  const withFiles: MessengerAdapter = {
    ...fake,
    download: async () => ({
      files: [
        { kind: "file", name: "../../.bashrc", mime: "text/plain", bytes: bytes("notes") },
        { kind: "photo", bytes: bytes("jpeg") },
      ],
      skipped: ["poll"],
    }),
  }
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    return { root, env: { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") } }
  }

  it("**saves every file into the folder under a safe name**, and answers paths and sizes", async () => {
    const { root, env } = setup()
    const into = join(root, "out")
    const { code, stdout, stderr } = await call(
      ["messages", "download", "Book", "1", "--output", into, "--json"],
      async () => withFiles,
      env,
    )

    expect(code).toBe(0)
    expect(JSON.parse(stdout[0] ?? "").items).toEqual([
      { kind: "file", path: join(into, "bashrc"), bytes: 5 },
      { kind: "photo", path: join(into, "1-2.jpg"), bytes: 4 },
    ])
    expect(readFileSync(join(into, "bashrc"), "utf8")).toBe("notes")
    expect(readdirSync(into).sort()).toEqual(["1-2.jpg", "bashrc"])
    expect(stderr.join("")).toContain("poll")
  })

  it("**never overwrites a file already there**", async () => {
    const { root, env } = setup()
    writeFileSync(join(root, "bashrc"), "mine")
    const { code, stderr } = await call(
      ["messages", "download", "Book", "1", "--output", root],
      async () => withFiles,
      env,
    )

    expect(code).not.toBe(0)
    expect(stderr.join("")).toContain("already exists")
    expect(readFileSync(join(root, "bashrc"), "utf8")).toBe("mine")
    expect(readdirSync(root).filter((name) => name.endsWith(".part"))).toEqual([])
  })

  it("refuses a message with no file, and a messenger that cannot download", async () => {
    const { env } = setup()
    const empty = await call(
      ["messages", "download", "Book", "1"],
      async () => ({ ...fake, download: async () => ({ files: [], skipped: [] }) }),
      env,
    )
    const unable = await call(["messages", "download", "Book", "1"], async () => fake, env)

    expect(empty.stderr.join("")).toContain("no file to download")
    expect(unable.stderr.join("")).toContain("cannot download attachments")
  })

  describe("--all", () => {
    const withIds = (ids: number[], kinds: Record<number, string>) =>
      ids.map((id) => ({ ...message, id: String(id), attachments: kinds[id] ? [{ kind: kinds[id] }] : [] }))
    const chatOf = (
      ids: number[],
      kinds: Record<number, string>,
      asked: string[],
      failOn?: string,
    ): MessengerAdapter => ({
      ...fake,
      history: async (_chat, { before }) => {
        const older = withIds(ids, kinds).filter((one) => before === undefined || Number(one.id) < Number(before))
        return { items: older.slice(0, 2), hasMore: older.length > 2 }
      },
      download: async (_chat, id) => {
        if (id === failOn) throw new CliError("network_error", "the connection dropped")
        asked.push(id)
        return {
          files: [{ kind: "file", name: "notes.txt", mime: "text/plain", bytes: bytes(`notes ${id}`) }],
          skipped: [],
        }
      },
    })

    it("**saves every file of the chat, page by page, asking only for messages that carry one**", async () => {
      const { root, env } = setup()
      const into = join(root, "out")
      const asked: string[] = []
      const { code, stdout } = await call(
        ["messages", "download", "Book", "--all", "--pause", "1ms", "--output", into, "--json"],
        async () => chatOf([5, 4, 3, 2, 1], { 5: "file", 4: "webpage", 2: "file" }, asked),
        env,
      )

      expect(code).toBe(0)
      expect(asked).toEqual(["5", "2"])
      expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
        items: [{ path: join(into, "notes.txt") }, { path: join(into, "2-1-notes.txt") }],
        saved: 2,
        complete: true,
      })
      expect(readFileSync(join(into, "2-1-notes.txt"), "utf8")).toBe("notes 2")
    })

    it("**continues where a cut-short run stopped**, and asks for no file twice", async () => {
      const { root, env } = setup()
      const into = join(root, "out")
      const kinds = { 6: "file", 5: "file", 3: "file", 1: "file" }
      const first: string[] = []
      const cut = await call(
        ["messages", "download", "Book", "--all", "--pause", "1ms", "--output", into],
        async () => chatOf([5, 4, 3, 2, 1], kinds, first, "3"),
        env,
      )
      const second: string[] = []
      const again = await call(
        ["messages", "download", "Book", "--all", "--pause", "1ms", "--output", into, "--json"],
        async () => chatOf([6, 5, 4, 3, 2, 1], kinds, second),
        env,
      )

      expect(cut.code).not.toBe(0)
      expect(first).toEqual(["5"])
      expect(second).toEqual(["6", "3", "1"])
      expect(JSON.parse(again.stdout[0] ?? "")).toMatchObject({ saved: 3, existing: 0, complete: true })
      expect(readdirSync(into).filter((name) => !name.startsWith("."))).toHaveLength(4)
    })

    it("refuses a message id beside --all, and neither", async () => {
      const { env } = setup()
      const both = await call(["messages", "download", "Book", "1", "--all"], async () => withFiles, env)
      const neither = await call(["messages", "download", "Book"], async () => withFiles, env)

      expect(both.stderr.join("")).toContain("leave out the message id")
      expect(neither.stderr.join("")).toContain("name a message id")
    })
  })

  it("strips what could climb out of the folder, hide the file or disguise its extension", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd")
    expect(safeName("..\\evil.exe")).toBe("evil.exe")
    expect(safeName(".hidden")).toBe("hidden")
    expect(safeName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe")
    expect(safeName("..")).toBeUndefined()
  })
})

describe("messages transcribe", () => {
  const env = () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    return {
      CHAT_STATE_DIR: join(root, "state"),
      MESSAGING_STORE: join(root, "m.db"),
      CLI_COMMON_CACHE_DIR: join(root, "cache"),
      CHAT_CACHE_DIR: join(root, "chat-cache"),
    }
  }

  it("prints the text, and says on stderr when it was not finished", async () => {
    const done = await call(
      ["messages", "transcribe", "Book", "5", "--json"],
      async () => ({ ...fake, transcribe: async () => ({ text: "hello", pending: false }) }),
      env(),
    )
    const pending = await call(
      ["messages", "transcribe", "Book", "5", "--json"],
      async () => ({ ...fake, transcribe: async () => ({ text: "", pending: true }) }),
      env(),
    )

    expect(JSON.parse(done.stdout[0] ?? "")).toEqual({ messageId: "5", text: "hello", pending: false, via: "chat" })
    expect(done.stderr).toEqual([])
    expect(pending.stderr.join("")).toContain("not finished")
  })

  it("**refuses --local before connecting** when the model is not downloaded, naming the command", async () => {
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("a missing model must not cost a connection")
    }
    const { code, stderr } = await call(["messages", "transcribe", "Book", "5", "--local"], never, env())

    expect(code).not.toBe(0)
    expect(stderr.join("")).toContain("chat models audio download parakeet-v3")
  })

  it("**lists a chat with its voice messages heard**, and shows them again later without asking", async () => {
    const root = env()
    const spoken = { ...message, attachments: [{ kind: "voice", mime: "audio/ogg" }] }
    let asked = 0
    const hearing = {
      ...fake,
      history: async () => ({ items: [spoken], hasMore: false }),
      transcribe: async () => {
        asked++
        return { text: "read me", pending: false }
      },
    }

    const first = await call(["messages", "list", "Book", "--transcribe", "--json"], async () => hearing, root)
    const again = await call(["messages", "list", "Book", "--json"], async () => hearing, root)
    const person = await call(["messages", "list", "Book"], async () => hearing, root, { tty: true })

    expect(JSON.parse(first.stdout[0] ?? "")).toMatchObject({ items: [{ transcript: "read me" }], unheard: [] })
    expect(JSON.parse(again.stdout[0] ?? "").items[0].transcript).toBe("read me")
    expect(person.stdout.join("")).toContain("🎤 read me")
    expect(asked).toBe(1)
  })

  it("lists the speech models Parakeet first, none downloaded, the first the default", async () => {
    const { stdout } = await call(["models", "audio", "list", "--json"], async () => fake, env())

    expect(
      JSON.parse(stdout[0] ?? "").items.map((one: { id: string; downloaded: boolean; default: boolean }) => [
        one.id,
        one.downloaded,
        one.default,
      ]),
    ).toEqual([
      ["parakeet-v3", false, true],
      ["gigaam-v3", false, false],
      ["gigaam-v3-ctc", false, false],
    ])
  })
})

describe("the guard, account and mcp config commands", () => {
  const sandbox = () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-"))
    return {
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
  }
  const json = (stdout: string[]) => JSON.parse(stdout[0] ?? "")

  it("**turn the recipient list on with the first add** and off again, and refuse removing a stranger", async () => {
    const env = sandbox()
    const online = async () => fake

    const off = await call(["recipients", "list", "--json"], online, env)
    expect(json(off.stdout)).toEqual({ items: [], page: 1, limit: 0, hasMore: false })
    expect(off.stderr.join("\n")).toContain("is off")

    expect(json((await call(["recipients", "add", "Book", "--json"], online, env)).stdout)).toEqual({
      id: "7",
      title: "Book club",
      added: true,
    })
    expect(json((await call(["recipients", "list", "--json"], online, env)).stdout)).toMatchObject({
      items: [{ id: "7" }],
    })

    const stranger = await call(["recipients", "remove", "99"], online, env)
    expect(stranger.code).not.toBe(0)
    expect(stranger.stderr.join("\n")).toContain("99 is not on the recipient list")

    expect(json((await call(["recipients", "remove", "7", "--json"], online, env)).stdout)).toMatchObject({
      removed: true,
    })
    const empty = await call(["recipients", "list", "--json"], online, env)
    expect(empty.stderr.join("\n")).toContain("on and empty")

    expect(json((await call(["recipients", "clear", "--json"], online, env)).stdout)).toEqual({
      off: true,
      wasOn: true,
    })
    expect((await call(["recipients", "off"], online, env)).code).not.toBe(0)
  })

  it("list attempts to send newest first, and say when there were none", async () => {
    const env = sandbox()
    const none = await call(["sends", "list", "--json"], async () => fake, env)
    expect(none.stderr.join("\n")).toContain("has not tried to send anything")

    await call(["messages", "send", "Book", "one"], async () => fake, env)
    await call(["messages", "send", "Book", "two", "--reply-to", "1"], async () => fake, env)
    const listed = await call(["sends", "list", "--limit", "1", "--json"], async () => fake, env)
    const page = json(listed.stdout)
    expect(page.items.map((entry: { replyTo?: string }) => entry.replyTo)).toEqual(["1"])
    expect(page.hasMore).toBe(true)
  })

  it("show who the profile is logged in as", async () => {
    const { stdout } = await call(["account", "show", "--json"], async () => fake, sandbox())
    expect(json(stdout)).toEqual({ id: "500", name: "Owner", username: null })
  })

  it("**show the phone's last four digits, the whole number only with --show-phone**", async () => {
    const withPhone: MessengerAdapter = {
      ...fake,
      me: async () => ({ ...(await fake.me()), phone: "+00 000 000-1234" }),
    }

    const masked = await call(["account", "show", "--json"], async () => withPhone, sandbox())
    const whole = await call(["account", "show", "--show-phone", "--json"], async () => withPhone, sandbox())

    expect(json(masked.stdout).phone).toBe("***1234")
    expect(json(whole.stdout).phone).toBe("+00 000 000-1234")
  })

  it("**print the mcp entry by full path**, and warn when node belongs to a version manager", async () => {
    const env = sandbox()
    const mcp = { execPath: "/home/o/.nvm/versions/node/v24/bin/node", scriptPath: "/usr/lib/chat/bin/chat.js" }
    const { code, stdout, stderr } = await call(
      ["work", "mcp", "config", "--allow-send", "--allow-mark-read", "--allow-delete", "--json"],
      async () => fake,
      env,
      {
        mcp,
      },
    )

    expect(code).toBe(0)
    expect(json(stdout).mcpServers["chat-work"]).toMatchObject({
      command: mcp.execPath,
      args: [mcp.scriptPath, "work", "mcp", "--allow-send", "--allow-mark-read", "--allow-delete"],
      env: { MESSAGING_STORE: env.MESSAGING_STORE },
    })
    expect(stderr.join("\n")).toContain("belongs to one Node version")

    const pretty = await call(["mcp", "config"], async () => fake, env, { mcp, tty: true })
    expect(JSON.parse(pretty.stdout.join("\n")).mcpServers.chat.args).toEqual([mcp.scriptPath, "mcp"])
  })

  it("refuse --confirm-send without --allow-send, and a script in npx's cache", async () => {
    const env = sandbox()
    const mcp = { execPath: "/usr/bin/node", scriptPath: "/usr/lib/chat/bin/chat.js" }
    const confirmOnly = await call(["mcp", "config", "--confirm-send"], async () => fake, env, { mcp })
    expect(confirmOnly.code).toBe(2)
    expect(confirmOnly.stderr.join("\n")).toContain("without `--allow-send`")

    const npx = await call(["mcp", "config"], async () => fake, env, {
      mcp: { ...mcp, scriptPath: "/home/o/.npm/_npx/abc/node_modules/chat/bin/chat.js" },
    })
    expect(npx.code).toBe(2)
    expect(npx.stderr.join("\n")).toContain("npx's cache")
  })

  it("**page a listing the same way in every format**: the envelope, JSON lines, and a table with a note", async () => {
    const env = sandbox()
    const paged: MessengerAdapter = { ...fake, chats: async () => ({ items: [chat], hasMore: true }) }
    const online = async () => paged

    const envelope = await call(["chats", "list", "--limit", "1", "--page", "2", "--json"], online, env)
    expect(json(envelope.stdout)).toMatchObject({ page: 2, limit: 1, hasMore: true })

    const lines = await call(["chats", "list", "--limit", "1", "--jsonl"], online, env)
    expect(lines.stdout.map((line) => JSON.parse(line).id)).toEqual(["7"])
    expect(lines.stderr.join("\n")).toContain("--page 2")

    const all = await call(["chats", "list", "--all", "--json"], online, env)
    expect(json(all.stdout)).toMatchObject({ page: 1, limit: 1, hasMore: false })

    const table = await call(["chats", "list", "--limit", "1"], online, env, { tty: true })
    expect(table.code).toBe(0)
    expect(table.stderr.join("\n")).toContain("page 1 of more")
  })

  it("**filter chats list** by --search, --kind and --unread together, over the newest chats only", async () => {
    const env = sandbox()
    const asked: unknown[] = []
    const busy: MessengerAdapter = {
      ...fake,
      chats: async (window) => {
        asked.push(window)
        return {
          items: [chat, ...people, { ...people[0], id: "22", title: "Zoe's club", unreadCount: 3 } as Chat],
          hasMore: true,
        }
      },
    }
    const online = async () => busy

    const found = await call(
      ["chats", "list", "--search", "ZOE", "--kind", "dialog", "--unread", "--json"],
      online,
      env,
    )
    const people_ = await call(["chats", "list", "--kind", "dialog", "--limit", "1", "--json"], online, env)

    expect(json(found.stdout).items.map((one: Chat) => one.id)).toEqual(["22"])
    expect(found.stderr.join("\n")).toContain("newest chats were searched")
    expect(asked[0]).toEqual({ limit: 200, offset: 0 })
    expect(json(people_.stdout)).toMatchObject({ items: [{ id: "20" }], hasMore: true })
  })

  it("**read forward with messages list --after**, from a message id or a moment", async () => {
    const env = sandbox()
    const asked: unknown[] = []
    const forward: MessengerAdapter = {
      ...fake,
      historyAfter: async (_chat, window) => {
        asked.push(window.after)
        return { items: thread, hasMore: true }
      },
    }

    const byId = await call(["messages", "list", "7", "--after", "41", "--jsonl"], async () => forward, env)
    await call(["messages", "list", "7", "--after", "2026-09-27T10:00:00Z", "--json"], async () => forward, env)

    expect(asked).toEqual([{ id: "41" }, { time: Date.parse("2026-09-27T10:00:00Z") }])
    expect(byId.stderr.join("\n")).toContain("--after 3")
  })

  it("refuses --before with --after, --after offline, and a messenger that cannot read forward", async () => {
    const env = sandbox()
    const online = async () => fake

    expect((await call(["messages", "list", "7", "--before", "5", "--after", "2"], online, env)).code).toBe(2)
    expect((await call(["messages", "list", "7", "--after", "2", "--offline"], online, env)).code).toBe(2)
    const unable = await call(["messages", "list", "7", "--after", "2"], online, env)
    expect([unable.code, unable.stderr.join("\n")]).toEqual([2, expect.stringContaining("read forward")])
  })

  it("**chats events** asks from 7 days back, keeps the --event names, and says when it was cut short", async () => {
    const env = sandbox()
    const asked: number[] = []
    const events: MessengerAdapter = {
      ...fake,
      chatEvents: async (_chat, { since }) => {
        asked.push(since)
        return {
          chatId: "7",
          since: new Date(since).toISOString(),
          more: true,
          events: [
            { messageId: "1", timestamp: message.timestamp, event: "join", by: { id: "9", name: "Olga" }, people: [] },
            { messageId: "2", timestamp: message.timestamp, event: "pin", by: { id: "9", name: "Olga" }, people: [] },
          ],
        }
      },
    }
    const online = async () => events

    const all = await call(["chats", "events", "7", "--json"], online, env)
    const joins = await call(["chats", "events", "7", "--event", "join, add", "--since", "1d", "--jsonl"], online, env)

    expect(Date.now() - (asked[0] ?? 0)).toBeGreaterThanOrEqual(7 * 86_400_000 - 5000)
    expect(json(all.stdout).events).toHaveLength(2)
    expect(joins.stdout.map((line) => JSON.parse(line).event)).toEqual(["join"])
    expect(joins.stderr.join("\n")).toContain("more history")
    expect((await call(["chats", "events", "7"], async () => fake, env)).code).toBe(2)
  })

  it("**chats members list** pages a group's members like every listing, and refuses a messenger without it", async () => {
    const env = sandbox()
    const windows: unknown[] = []
    const group: MessengerAdapter = {
      ...fake,
      members: async (_chat, window) => {
        windows.push(window)
        return { chatId: "7", items: [{ id: "9", name: "Olga", username: null, role: "admin" }], hasMore: true }
      },
    }
    const online = async () => group

    const page = await call(["chats", "members", "list", "7", "--limit", "1", "--page", "2", "--json"], online, env)
    await call(["chats", "members", "list", "7", "--all", "--json"], online, env)

    expect(json(page.stdout)).toMatchObject({ items: [{ id: "9", role: "admin" }], page: 2, hasMore: true })
    expect(windows).toEqual([{ limit: 1, offset: 1 }, { offset: 0 }])
    expect((await call(["chats", "members", "list", "7"], async () => fake, env)).code).toBe(2)
  })

  it("**contacts lookup** reads the number from stdin, never argv, and refuses what is not a number", async () => {
    const env = sandbox()
    const phones: string[] = []
    const finder: MessengerAdapter = {
      ...fake,
      lookup: async (phone) => {
        phones.push(phone)
        return { id: "21", name: "Adam", username: "adam_k" }
      },
    }
    const piped = (text: string) => ({ stdin: Object.assign(Readable.from([text]), { isTTY: false }) })

    const found = await call(["contacts", "lookup", "--json"], async () => finder, env, piped("+34 600-123 456\n"))
    const typo = await call(["contacts", "lookup"], async () => finder, env, piped("call me"))
    const inArgv = await call(["contacts", "lookup", "34600123456"], async () => finder, env, piped(""))

    expect(json(found.stdout)).toEqual({ id: "21", name: "Adam", username: "adam_k" })
    expect(phones).toEqual(["34600123456"])
    expect([typo.code, inArgv.code]).toEqual([2, 2])
    expect(inArgv.stderr.join("\n")).not.toContain("600123456")
  })

  it("**contacts sync** keeps the contact list in the store and counts what was new or changed", async () => {
    const env = sandbox()
    let people: Member[] = [{ id: "21", name: "Adam", username: "adam_k" }]
    const book: MessengerAdapter = { ...fake, addressBook: async () => people }

    const first = await call(["contacts", "sync", "--json"], async () => book, env)
    people = [
      { id: "21", name: "Adam K.", username: "adam_k" },
      { id: "22", name: "Bea", username: null },
    ]
    const second = await call(["contacts", "sync", "--json"], async () => book, env)

    expect(json(first.stdout)).toEqual({ added: 1, changed: 0, known: 1 })
    expect(json(second.stdout)).toEqual({ added: 1, changed: 1, known: 2 })
  })

  it("**account sessions list** shows where the account is logged in, and a messenger without it refuses", async () => {
    const env = sandbox()
    const devices: MessengerAdapter = {
      ...fake,
      sessions: async () => [
        { current: true, client: "tg 1.0", device: "Linux", location: "Valencia, ES", lastActiveAt: null },
        { current: false, client: "Telegram iOS 11.2", device: "iPhone", location: null, lastActiveAt: null },
      ],
    }

    const listed = await call(["account", "sessions", "list", "--json"], async () => devices, env)
    const lines = await call(["account", "sessions", "list", "--jsonl"], async () => devices, env)

    expect(json(listed.stdout).items.map((one: { current: boolean }) => one.current)).toEqual([true, false])
    expect(lines.stdout).toHaveLength(2)
    expect((await call(["account", "sessions", "list"], async () => fake, env)).code).toBe(2)
  })

  it("**chats inspect** answers what a link leads to, and refuses offline and without the method", async () => {
    const env = sandbox()
    const links: string[] = []
    const reader: MessengerAdapter = {
      ...fake,
      inspect: async (link) => {
        links.push(link)
        return {
          kind: "group",
          title: "Book club",
          id: null,
          username: null,
          participantsCount: 40,
          description: null,
          member: false,
          approvalNeeded: true,
        }
      },
    }

    const found = await call(["chats", "inspect", "https://t.me/+abc", "--json"], async () => reader, env)

    expect(json(found.stdout)).toMatchObject({ title: "Book club", member: false, approvalNeeded: true })
    expect(links).toEqual(["https://t.me/+abc"])
    expect((await call(["chats", "inspect", "x", "--offline"], async () => reader, env)).code).toBe(2)
    expect((await call(["chats", "inspect", "x"], async () => fake, env)).code).toBe(2)
  })

  it("**topics list and search** page a forum's topics, search passing its words on", async () => {
    const env = sandbox()
    const asked: unknown[] = []
    const forum: MessengerAdapter = {
      ...fake,
      topics: async (_chat, window) => {
        asked.push(window)
        const topic = {
          id: "4",
          title: "Pisos",
          closed: false,
          pinned: true,
          unreadCount: 2,
          lastMessageAt: null,
          createdAt: null,
        }
        return { items: [topic], hasMore: false }
      },
    }
    const online = async () => forum

    const listed = await call(["topics", "list", "7", "--limit", "5", "--json"], online, env)
    await call(["topics", "search", "7", "pisos", "--json"], online, env)

    expect(json(listed.stdout).items).toEqual([expect.objectContaining({ id: "4", pinned: true })])
    expect(asked).toEqual([
      { limit: 5, offset: 0 },
      { limit: 20, offset: 0, search: "pisos" },
    ])
    expect((await call(["topics", "list", "7"], async () => fake, env)).code).toBe(2)
  })

  it("refuses a --search under 3 characters and an unknown --kind, before connecting", async () => {
    const env = sandbox()
    const never = async (): Promise<MessengerAdapter> => {
      throw new Error("must not connect")
    }

    expect((await call(["chats", "list", "--search", "zo"], never, env)).code).toBe(2)
    expect((await call(["chats", "list", "--kind", "bot"], never, env)).code).toBe(2)
  })

  it("**print one message per line** from `messages list` and `messages search` with --jsonl", async () => {
    const env = sandbox()
    const online = async (): Promise<MessengerAdapter> => ({
      ...fake,
      history: async () => ({ items: thread, hasMore: true }),
    })

    const listed = await call(["messages", "list", "7", "--jsonl"], online, env)
    expect(listed.stdout.map((line) => JSON.parse(line).id)).toEqual(["1", "2", "3"])
    expect(listed.stderr.join("\n")).toContain("--before 1")

    const found = await call(["messages", "search", "chapt", "--jsonl"], online, env)
    expect(found.stdout.map((line) => JSON.parse(line).id)).toEqual(["3", "2", "1"])
  })
})
