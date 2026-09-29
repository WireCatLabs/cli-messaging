import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import type { CommandInfo } from "@leemour/cli-core/commands"
import { describe, expect, it } from "vitest"
import type { Chat, Message, WindowedMessage } from "../../domain/models.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { commandsCommand } from "../commands-command.js"
import { type RunOptions, run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountCommand } from "./account-command.js"
import { accountFileFor } from "./accounts.js"
import { exportCommand, syncCommand } from "./archive-commands.js"
import { chatsCommand } from "./chats-command.js"
import { completeCommand } from "./complete-command.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import { safeName } from "./download-command.js"
import { recipientsCommand, sendsCommand } from "./guard-commands.js"
import { type McpEnvironment, mcpCommand } from "./mcp-command.js"
import { messagesCommand } from "./messages-command.js"
import { modelsCommand } from "./models-command.js"
import type { MessengerAdapter, SendOptions } from "./port.js"

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
) => {
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
        mcpCommand(messenger),
        modelsCommand(messenger),
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
    expect(forwards).toEqual([["7", "3", "20", { silent: true }]])
    const journal = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(journal.at(-1)).toMatchObject({ kind: "forward", outcome: "sent", chatId: "20", messageId: "50" })
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

    const status = await call(["sync", "status", "--json"], never, env)
    expect(JSON.parse(status.stdout[0] ?? "")).toMatchObject([{ chatId: "7", title: null, messages: 3, held: [] }])
    const exported = await call(["export", "7", "--jsonl"], never, env)
    expect(exported.stdout.map((line) => JSON.parse(line).id)).toEqual(["1", "2", "3"])
    const one = await call(["export", "7", "--json"], never, env)
    expect(one.stdout).toHaveLength(1)
    const transcript = await call(["export", "7", "--format", "markdown"], never, env)
    expect(transcript.stdout.join("\n")).toMatch(/^# 7\n\n## \d{4}-\d{2}-\d{2}\n\n\*\*\d{2}:\d{2} /)
    expect((await call(["export", "7", "--format", "html"], never, env)).code).not.toBe(0)
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
      MESSAGING_CACHE_DIR: join(root, "cache"),
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
    expect(json(off.stdout)).toEqual([])
    expect(off.stderr.join("\n")).toContain("is off")

    expect(json((await call(["recipients", "add", "Book", "--json"], online, env)).stdout)).toEqual({
      id: "7",
      title: "Book club",
      added: true,
    })
    expect(json((await call(["recipients", "list", "--json"], online, env)).stdout)).toMatchObject([{ id: "7" }])

    const stranger = await call(["recipients", "remove", "99"], online, env)
    expect(stranger.code).not.toBe(0)
    expect(stranger.stderr.join("\n")).toContain("99 is not on the recipient list")

    expect(json((await call(["recipients", "remove", "7", "--json"], online, env)).stdout)).toMatchObject({
      removed: true,
    })
    const empty = await call(["recipients", "list", "--json"], online, env)
    expect(empty.stderr.join("\n")).toContain("on and empty")

    expect(json((await call(["recipients", "off", "--json"], online, env)).stdout)).toEqual({ off: true, wasOn: true })
  })

  it("list attempts to send newest first, and say when there were none", async () => {
    const env = sandbox()
    const none = await call(["sends", "list", "--json"], async () => fake, env)
    expect(none.stderr.join("\n")).toContain("has not tried to send anything")

    await call(["messages", "send", "Book", "one"], async () => fake, env)
    await call(["messages", "reply", "Book", "1", "two"], async () => fake, env)
    const listed = await call(["sends", "list", "--limit", "1", "--json"], async () => fake, env)
    expect(json(listed.stdout).map((entry: { replyTo?: string }) => entry.replyTo)).toEqual(["1"])
  })

  it("show who the profile is logged in as", async () => {
    const { stdout } = await call(["account", "show", "--json"], async () => fake, sandbox())
    expect(json(stdout)).toEqual({ id: "500", name: "Owner", username: null })
  })

  it("**print the mcp entry by full path**, and warn when node belongs to a version manager", async () => {
    const env = sandbox()
    const mcp = { execPath: "/home/o/.nvm/versions/node/v24/bin/node", scriptPath: "/usr/lib/chat/bin/chat.js" }
    const { code, stdout, stderr } = await call(
      ["work", "mcp", "config", "--allow-send", "--json"],
      async () => fake,
      env,
      {
        mcp,
      },
    )

    expect(code).toBe(0)
    expect(json(stdout).mcpServers["chat-work"]).toMatchObject({
      command: mcp.execPath,
      args: [mcp.scriptPath, "work", "mcp", "--allow-send"],
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
