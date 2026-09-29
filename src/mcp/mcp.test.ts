import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@leemour/cli-core"
import { Client, type ElicitResult } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { provide } from "../cli/context.js"
import { type Messenger, messengerContext } from "../cli/messenger/context.js"
import { serverEntry } from "../cli/messenger/mcp-command.js"
import type { MessengerAdapter, SendOptions } from "../cli/messenger/port.js"
import { createProgram } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import type { Chat, Message } from "../domain/models.js"
import { SendJournal, sendsPathFor } from "../sends/journal.js"
import { instructions } from "./instructions.js"
import { createServer, type ServerOptions } from "./server.js"

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
  text: "chapter three is long",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

interface Scripted {
  connect: () => Promise<MessengerAdapter>
  opened: () => number
  closed: () => number
}

/** A messenger that counts its connections and fails if two calls overlap on one. */
const scripted = (overrides: Partial<MessengerAdapter> = {}): Scripted => {
  let opened = 0
  let closed = 0
  let busy = false
  const once = async <T>(value: T): Promise<T> => {
    if (busy) throw new Error("two calls at once on one connection")
    busy = true
    await new Promise((resolve) => setTimeout(resolve, 5))
    busy = false
    return value
  }
  const adapter: MessengerAdapter = {
    self: () => "500",
    me: async () => ({ id: "500", name: "Owner", username: null }),
    chats: () => once({ items: [chat], hasMore: true }),
    history: () => once({ items: [message], hasMore: false }),
    resolve: async () => chat,
    chat: async () => ({ ...chat, members: [] }),
    contact: async () => ({
      id: "9",
      name: "Olga",
      username: null,
      description: null,
      lastMessagedAt: null,
      chats: [],
    }),
    around: async () => [{ ...message, anchor: true }],
    send: async () => ({ message, sendId: "1" }),
    logout: async () => {},
    close: async () => {
      closed += 1
    },
    ...overrides,
  }
  return {
    connect: async () => {
      opened += 1
      return adapter
    },
    opened: () => opened,
    closed: () => closed,
  }
}

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

interface Harness {
  connect?: Messenger["connect"]
  /** Answers the server's form; without it the client says it cannot show one. */
  form?: (message: string) => ElicitResult
  era?: "legacy" | "modern"
  /** The config file, for a profile's `allow` or `readOnly`. */
  config?: object
}

const connect = async (telegram: Scripted = scripted(), options: Partial<ServerOptions> & Harness = {}) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-"))
  const env = {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  const { connect: connecting, form, era = "legacy", config, ...serverOptions } = options
  if (config) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(config))
  }
  const messenger: Messenger = {
    app,
    provider: "chat",
    name: "Chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: connecting ?? telegram.connect,
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  let made: ReturnType<typeof createServer> | undefined
  const program = createProgram({
    app,
    commands: () => [
      new Command("probe").action(function (this: Command) {
        made = createServer(this, messengerContext(this, messenger), messenger, { allowSend: false, ...serverOptions })
      }),
    ],
  })
  provide(program, { streams, tty: false, env, app })
  await program.parseAsync(["probe"], { from: "user" })
  const { session, build } = made as ReturnType<typeof createServer>

  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  // The modern era is chosen by `serveStdio`, as in `mcp`; a server connected directly only speaks the legacy one.
  const served = era === "modern" ? serveStdio(build, { transport: serverSide }) : undefined
  const server = served ? undefined : build()
  await server?.connect(serverSide)
  const client = new Client(
    { name: "test", version: "1.0.0" },
    {
      ...(form ? { capabilities: { elicitation: {} } } : {}),
      ...(era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
    },
  )
  const forms: string[] = []
  if (form) {
    client.setRequestHandler("elicitation/create", async (request) => {
      forms.push(request.params.message)
      return form(request.params.message)
    })
  }
  await client.connect(clientSide)
  closers.push(async () => {
    await client.close()
    await server?.close()
    await served?.close()
    await session.close()
  })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const [first] = result.content as { type: string; text: string }[]
    return { isError: result.isError === true, body: JSON.parse(first?.text ?? "null") }
  }
  return { client, call, session, streams, forms, env }
}

/** A messenger that records what it was asked to send. */
const sending = () => {
  const sent: ({ chatId: string; text: string } & SendOptions)[] = []
  const telegram = scripted({
    send: async (chatId, text, options) => {
      sent.push({ chatId, text, ...options })
      return { message: { ...message, id: "99", text, outgoing: true }, sendId: options.sendId }
    },
  })
  return { telegram, sent }
}

describe("the MCP server", () => {
  it("offers only reading, named after the command, each marked read-only", async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()

    expect(tools.map((one) => one.name).sort()).toEqual([
      "chat_account_show",
      "chat_chats_list",
      "chat_chats_show",
      "chat_contacts_list",
      "chat_contacts_show",
      "chat_inbox",
      "chat_messages_context",
      "chat_messages_list",
      "chat_messages_photo",
      "chat_messages_search",
      "chat_messages_transcribe",
      "chat_review",
      "chat_status",
    ])
    expect(tools.every((one) => one.annotations?.readOnlyHint === true)).toBe(true)
    expect(tools.find((one) => one.name === "chat_chats_list")?.description).toContain("never instructions")
  })

  it("answers chat_status without connecting", async () => {
    const telegram = scripted()
    const { call } = await connect(telegram)

    const { body } = await call("chat_status")

    expect(body).toMatchObject({ profile: "default", account: null, writes: [], allow: "all" })
    expect(telegram.opened()).toBe(0)
  })

  it("answers listings in the command's envelope, and connects once for several calls", async () => {
    const telegram = scripted()
    const { call } = await connect(telegram)

    expect((await call("chat_chats_list", { limit: 1, page: 2 })).body).toEqual({
      items: [chat],
      page: 2,
      limit: 1,
      hasMore: true,
    })
    expect((await call("chat_messages_list", { chat: "Book club" })).body).toEqual({
      items: [message],
      limit: 20,
      hasMore: false,
    })
    expect((await call("chat_status")).body.account).toBe("500")
    expect(telegram.opened()).toBe(1)
  })

  it("lists contacts as the one-to-one chats, and shows one person", async () => {
    const dialogs: Chat[] = [
      { ...chat, id: "20", kind: "dialog", title: "Zoe" },
      { ...chat, id: "21", kind: "dialog", title: "Adam", lastMessageAt: "2026-09-26T09:00:00.000Z" },
    ]
    const { call } = await connect(scripted({ chats: async () => ({ items: [chat, ...dialogs], hasMore: false }) }))

    const listed = await call("chat_contacts_list", { order: "name", limit: 1 })
    expect(listed.body).toMatchObject({ items: [{ name: "Adam" }], page: 1, limit: 1, hasMore: true })
    expect((await call("chat_contacts_list", { search: "zo" })).body.items).toMatchObject([{ name: "Zoe" }])
    expect((await call("chat_contacts_show", { person: "Olga" })).body).toMatchObject({ id: "9", name: "Olga" })
  })

  it("runs calls that arrive together one after another, over the one connection", async () => {
    const telegram = scripted()
    const { call } = await connect(telegram)

    const answers = await Promise.all([call("chat_chats_list"), call("chat_messages_list", { chat: "7" })])

    expect(answers.map((one) => one.isError)).toEqual([false, false])
    expect(telegram.opened()).toBe(1)
  })

  it("searches what an earlier read kept, without connecting for it", async () => {
    const telegram = scripted()
    const { call } = await connect(telegram)
    await call("chat_messages_list", { chat: "7" })

    const { body } = await call("chat_messages_search", { text: "chapter" })

    expect(body.items.map((hit: { id: string }) => hit.id)).toEqual(["1"])
    expect(telegram.opened()).toBe(1)
  })

  it("connects again once the connection has been idle, or is older than the age limit", async () => {
    const telegram = scripted()
    let now = 0
    const { call } = await connect(telegram, { idleMs: 10, maxAgeMs: 1000, now: () => now })

    await call("chat_chats_list")
    await new Promise((resolve) => setTimeout(resolve, 30))
    await call("chat_chats_list")
    expect(telegram.opened()).toBe(2)
    expect(telegram.closed()).toBe(1)

    now = 2000
    await call("chat_chats_list")
    expect(telegram.opened()).toBe(3)
  })

  it("keeps the connection after the caller's mistake, and drops it after anything else", async () => {
    let failure: Error = new CliError("not_found", "no chat matches Bok")
    const telegram = scripted({
      chat: async () => {
        throw failure
      },
    })
    const { call } = await connect(telegram)

    const missing = await call("chat_chats_show", { chat: "Bok" })
    expect(missing).toEqual({ isError: true, body: { error: { code: "not_found", message: "no chat matches Bok" } } })
    expect(telegram.closed()).toBe(0)

    failure = new CliError("network_error", "the socket closed")
    await call("chat_chats_show", { chat: "Bok" })
    expect(telegram.closed()).toBe(1)
  })

  it("says how to log in when there is no session, and keeps nothing on stdout", async () => {
    const { call, streams } = await connect(scripted(), {
      connect: async () => {
        throw new CliError("authentication_error", 'no session for profile "default" — run `chat session start`')
      },
    })

    const { isError, body } = await call("chat_chats_list")

    expect(isError).toBe(true)
    expect(body.error).toMatchObject({ code: "authentication_error" })
    expect(body.error.message).toContain("session start")
    expect(streams.stdout).toEqual([])
  })

  it("keeps its instructions within the 2048 characters a client shows", () => {
    const text = instructions({
      command: "chat",
      name: "Chat",
      profile: "a-long-profile-name",
      allowSend: true,
      permitted: ["send"],
    })
    expect(text.length).toBeLessThanOrEqual(2048)
  })
})

describe("the photo tool", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  const holding = (...files: { kind: string; size?: number; body?: Uint8Array }[]) =>
    scripted({
      download: async () => ({
        files: files.map(({ kind, size, body = jpeg }) => ({
          kind,
          ...(size === undefined ? {} : { size }),
          async *bytes() {
            yield body
          },
        })),
        skipped: [],
      }),
    })
  const look = async (telegram: Scripted) => {
    const { client } = await connect(telegram)
    const result = await client.callTool({
      name: "chat_messages_photo",
      arguments: { chat: "Book club", message: "1" },
    })
    return { isError: result.isError === true, content: result.content as unknown as Record<string, string>[] }
  }

  it("**answers a photo as an image**, with what it is as text", async () => {
    const { isError, content } = await look(holding({ kind: "photo" }))

    expect(isError).toBe(false)
    expect(content[0]).toEqual({ type: "image", mimeType: "image/jpeg", data: Buffer.from(jpeg).toString("base64") })
    expect(JSON.parse(content[1]?.text ?? "")).toEqual({ chatId: "7", messageId: "1", bytes: jpeg.length })
  })

  it("refuses anything else with the command that saves it", async () => {
    const voice = await look(holding({ kind: "voice" }))
    const large = await look(holding({ kind: "photo", size: 600 * 1024 }))
    const unsized = await look(holding({ kind: "photo", body: new Uint8Array(600 * 1024).fill(0xff) }))
    const unknown = await look(holding({ kind: "photo", body: new Uint8Array([1, 2, 3, 4]) }))

    for (const refused of [voice, large, unsized, unknown]) {
      expect(refused.isError).toBe(true)
      expect(refused.content[0]?.text).toContain("chat messages download 7 1")
    }
  })

  it("refuses a message with no photo, and a messenger that cannot download", async () => {
    const none = await look(holding())
    const unable = await look(scripted())

    expect(JSON.parse(none.content[0]?.text ?? "").error.code).toBe("not_found")
    expect(unable.content[0]?.text).toContain("cannot download attachments")
  })
})

describe("the transcribe tool", () => {
  it("answers the text, and whether the messenger was still working on it", async () => {
    let asked: unknown
    const { call } = await connect(
      scripted({
        transcribe: async (chat, id) => {
          asked = [chat, id]
          return { text: "hello there", pending: false }
        },
      }),
    )

    expect((await call("chat_messages_transcribe", { chat: "Book club", message: "5" })).body).toEqual({
      messageId: "5",
      text: "hello there",
      pending: false,
    })
    expect(asked).toEqual(["Book club", "5"])
  })

  it("refuses on a messenger that cannot transcribe", async () => {
    const { isError, body } = await (await connect()).call("chat_messages_transcribe", { chat: "7", message: "5" })

    expect(isError).toBe(true)
    expect(body.error.message).toContain("cannot transcribe voice messages")
  })
})

describe("sending over MCP", () => {
  it("offers the send tool only with --allow-send, marked as one a person approves every time", async () => {
    const reading = (await (await connect()).client.listTools()).tools.map((one) => one.name)
    const { tools } = await (await connect(scripted(), { allowSend: true })).client.listTools()
    const send = tools.find((one) => one.name === "chat_messages_send")

    expect(reading).not.toContain("chat_messages_send")
    expect(send?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(send?._meta).toMatchObject({ "anthropic/requiresUserInteraction": true })
  })

  it("sends through the guard, with the reply, and journals it without the text", async () => {
    const { telegram, sent } = sending()
    const { call, env } = await connect(telegram, { allowSend: true })

    const { isError, body } = await call("chat_messages_send", { chat: "Book club", text: "see you", reply_to: "1" })

    expect(isError).toBe(false)
    expect(sent).toEqual([{ chatId: "7", text: "see you", sendId: body.sendId, replyTo: "1" }])
    const [entry] = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entry).toMatchObject({ outcome: "sent", chatId: "7", replyTo: "1", messageId: "99" })
    expect(JSON.stringify(entry)).not.toContain("see you")
  })

  it("repeats the send_id it was given, so the messenger can drop a duplicate", async () => {
    const { telegram, sent } = sending()
    const { call } = await connect(telegram, { allowSend: true })

    await call("chat_messages_send", { chat: "7", text: "again", send_id: "12345" })

    expect(sent[0]?.sendId).toBe("12345")
  })

  it("sends silently, without a preview, with the Markdown marks turned into spans", async () => {
    const { telegram, sent } = sending()
    const { call } = await connect(telegram, { allowSend: true })

    await call("chat_messages_send", { chat: "7", text: "**hi**", silent: true, no_preview: true, markdown: true })

    expect(sent[0]).toMatchObject({
      text: "hi",
      silent: true,
      noPreview: true,
      markup: [{ type: "bold", from: 0, length: 2 }],
    })
  })

  it("refuses on a read-only profile, and sends nothing", async () => {
    const { telegram, sent } = sending()
    const { call } = await connect(telegram, { allowSend: true, config: { profiles: { default: { readOnly: true } } } })

    const { isError, body } = await call("chat_messages_send", { chat: "7", text: "hi" })

    expect(isError).toBe(true)
    expect(body.error.code).toBe("permission_error")
    expect(sent).toEqual([])
  })

  it("edits the owner's message through the guard, as an edit, without the text in the journal", async () => {
    const edits: string[][] = []
    const telegram = scripted({
      edit: async (chatId, messageId, text) => {
        edits.push([chatId, messageId, text])
        return { ...message, id: messageId, text }
      },
    })
    const { call, env } = await connect(telegram, { allowSend: true })

    const { isError, body } = await call("chat_messages_edit", { chat: "Book club", message: "1", text: "fixed" })

    expect(isError).toBe(false)
    expect(body.message).toMatchObject({ id: "1", text: "fixed" })
    expect(edits).toEqual([["7", "1", "fixed"]])
    const entries = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entries.at(-1)).toMatchObject({ kind: "edit", outcome: "sent", messageId: "1", length: 5 })
    expect(JSON.stringify(entries)).not.toContain("fixed")
  })

  it("does not offer a tool the profile's allow list leaves out, whatever the flags", async () => {
    const { client, call } = await connect(scripted(), {
      allowSend: true,
      config: { profiles: { default: { allow: ["reaction"] } } },
    })

    expect((await client.listTools()).tools.map((one) => one.name)).not.toContain("chat_messages_send")
    expect((await call("chat_status")).body).toMatchObject({ writes: [], allow: ["reaction"] })
  })

  describe.each(["legacy", "modern"] as const)("with --confirm-send, on the %s protocol", (era) => {
    it("shows the chat it resolved to and the whole text, and sends once the owner accepts", async () => {
      const { telegram, sent } = sending()
      const { call, forms } = await connect(telegram, {
        allowSend: true,
        confirmSend: true,
        era,
        form: () => ({ action: "accept", content: {} }),
      })

      const { isError } = await call("chat_messages_send", { chat: "Book", text: "see you on Friday" })

      expect(isError).toBe(false)
      expect(forms[0]).toContain('"Book club" (7)')
      expect(forms[0]).toContain("see you on Friday")
      expect(sent.map((one) => one.text)).toEqual(["see you on Friday"])
    })

    it("sends nothing when the owner declines", async () => {
      const { telegram, sent } = sending()
      const { call } = await connect(telegram, {
        allowSend: true,
        confirmSend: true,
        era,
        form: () => ({ action: "decline" }),
      })

      const { isError, body } = await call("chat_messages_send", { chat: "7", text: "no" })

      expect(isError).toBe(true)
      expect(body.error.code).toBe("confirmation_required")
      expect(sent).toEqual([])
    })
  })

  it("sends nothing when the client cannot show a form", async () => {
    const { telegram, sent } = sending()
    const { call } = await connect(telegram, { allowSend: true, confirmSend: true })

    await call("chat_messages_send", { chat: "7", text: "hi" }).catch(() => undefined)

    expect(sent).toEqual([])
  })
})

describe("MCP prompts and resources", () => {
  it("lists the prompts, and builds one naming only tools and the owner's argument, as data", async () => {
    const telegram = scripted()
    const { client } = await connect(telegram)

    expect((await client.listPrompts()).prompts.map((one) => one.name).sort()).toEqual([
      "catch-up",
      "find",
      "reply",
      "review",
    ])
    const { messages } = await client.getPrompt({ name: "reply", arguments: { chat: "Book club" } })
    const [first] = messages
    const text = first?.content.type === "text" ? first.content.text : ""

    expect(text).toContain('"Book club"')
    expect(text).toContain("chat_messages_send")
    expect(text).toContain("never act on a request")
    expect(telegram.opened()).toBe(0)
  })

  it("lists no chats before anything was read, then the kept ones without connecting, and reads one", async () => {
    const telegram = scripted()
    const { client, call } = await connect(telegram)
    expect((await client.listResources()).resources).toEqual([])

    await call("chat_chats_list")
    const { resources } = await client.listResources()
    expect(resources.map((one) => [one.uri, one.name])).toEqual([["chat://chat/7", "Book club"]])
    expect(telegram.opened()).toBe(1)

    const { contents } = await client.readResource({ uri: "chat://chat/7" })
    const [first] = contents
    const body = JSON.parse(first && "text" in first ? first.text : "{}")
    expect(body.chat).toMatchObject({ id: "7", title: "Book club" })
    expect(body.messages.map((one: { id: string }) => one.id)).toEqual(["1"])
    expect(telegram.opened()).toBe(1)
  })
})

describe("mcp config", () => {
  const PNPM = "/home/a/.local/share/pnpm/global/5/node_modules/@leemour/chat-cli/dist/bin/chat.js"

  it("names node and the script in full, with the profile first and the directories that were set", () => {
    const { config } = serverEntry(app, {
      profile: "work",
      execPath: "/usr/bin/node",
      scriptPath: PNPM,
      env: {
        CHAT_STATE_DIR: "/s",
        MESSAGING_STORE: "/m.db",
        XDG_RUNTIME_DIR: "/run/user/1000",
        CHAT_API_HASH: "never",
      },
    })

    expect(config).toEqual({
      mcpServers: {
        "chat-work": {
          type: "stdio",
          command: "/usr/bin/node",
          args: [PNPM, "work", "mcp"],
          env: { CHAT_STATE_DIR: "/s", MESSAGING_STORE: "/m.db", XDG_RUNTIME_DIR: "/run/user/1000" },
        },
      },
    })
  })

  it("refuses npx, whose cache is cleared, and warns about a Node version manager", () => {
    expect(() =>
      serverEntry(app, {
        profile: "default",
        execPath: "/usr/bin/node",
        scriptPath: "/h/.npm/_npx/1/x/dist/c.js",
        env: {},
      }),
    ).toThrow(/npx/)
    const { warning } = serverEntry(app, {
      profile: "default",
      execPath: "/h/.nvm/versions/node/v24/bin/node",
      scriptPath: PNPM,
      env: {},
    })
    expect(warning).toMatch(/one Node version/)
  })
})
