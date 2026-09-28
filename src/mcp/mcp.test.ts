import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@leemour/cli-core"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { provide } from "../cli/context.js"
import { type Messenger, messengerContext } from "../cli/messenger/context.js"
import { serverEntry } from "../cli/messenger/mcp-command.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import { createProgram } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import type { Chat, Message } from "../domain/models.js"
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

const connect = async (
  telegram: Scripted = scripted(),
  options: Partial<ServerOptions> & { connect?: Messenger["connect"] } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-"))
  const env = {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  const { connect: connecting, ...serverOptions } = options
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
  await build().connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  closers.push(async () => {
    await client.close()
    await session.close()
  })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const [first] = result.content as { type: string; text: string }[]
    return { isError: result.isError === true, body: JSON.parse(first?.text ?? "null") }
  }
  return { client, call, session, streams }
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
      "chat_messages_context",
      "chat_messages_list",
      "chat_messages_search",
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
