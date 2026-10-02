import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, memoryKeyring } from "@leemour/cli-core"
import { Client, type ElicitResult } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import type { Command } from "commander"
import * as v from "valibot"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { botCommand } from "../../cli/bot/command.js"
import { commandLookup } from "../../cli/bot/mcp.js"
import type { BotAdapter, BotMessenger } from "../../cli/bot/port.js"
import { ChatRegistry } from "../../cli/bot/registry.js"
import { BotTokenStore } from "../../cli/bot/token.js"
import { createProgram, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import type { Message } from "../../domain/models.js"
import { ModerationRules, moderationPathFor } from "../../moderation/rules.js"
import { type BotServerOptions, createBotServer, type RunBotCommand } from "./server.js"
import type { BotTool } from "./tools.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app)

let root: string
let env: NodeJS.ProcessEnv
let keyring: ReturnType<typeof memoryKeyring>
let calls: string[]

const message = (chatId: string, id: string, text: string): Message => ({
  id,
  chatId,
  senderId: "42",
  senderName: "Sales",
  timestamp: "2026-10-01T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const adapter: BotAdapter = {
  me: async () => ({ id: "42", name: "Sales", username: "sales_bot" }),
  close: async () => {},
  send: async (chat, text) => {
    calls.push(`send ${chat} ${text}`)
    return message(chat, "100", text)
  },
  delete: async (chat, ids) => {
    calls.push(`delete ${chat} ${ids.join(",")}`)
  },
  historySince: async () => ({
    messages: [{ ...message("-100", "2", "join https://max.ru/join/other"), senderId: "42", outgoing: false }],
    more: false,
  }),
  admins: async () => [],
}

const ECHO: BotTool = {
  words: ["sends", "list"],
  title: "The CLI's own",
  description: "Replaces the shared one.",
  input: v.object({}),
}
const LEAVE: BotTool = {
  words: ["chats", "leave"],
  writes: "bot.chats.leave",
  title: "Leave, after a form of its own",
  description: "A tool that is more than one command.",
  input: v.object({ chat: v.string() }),
  handle: (args, kit, ctx) =>
    kit.confirmed({ name: "leave", title: "Leave" }, kit.resolveChat, args, ctx, async (resolved) => ({
      left: resolved.chat,
      seen: await kit.invoke(["chats", "list"], { options: ["--offline"] }),
    })),
}
const PROMOTE: BotTool = {
  words: ["chats", "admins", "add"],
  writes: "bot.chats.admins.add",
  title: "Says whether it must ask first",
  description: "A tool that is more than one command.",
  input: v.object({}),
  handle: async (_args, kit) => ({ confirmFirst: kit.confirmFirst }),
}
const ABSENT: BotTool = { words: ["comments", "list"], title: "None", description: "Not mounted.", input: v.object({}) }

const bot: BotMessenger = {
  app,
  provider: "chat-bot",
  name: "Chat",
  resolveSettings: config.resolveSettings,
  connect: async () => adapter,
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
  mcp: { program: async () => runBot, tools: [ECHO, LEAVE, PROMOTE, ABSENT] },
}

const definition = { app, commands: () => [botCommand(bot)] }
const runBot: RunBotCommand = (argv, environment) => run(argv, definition, environment)

const configure = (contents: object) => {
  mkdirSync(join(root, "config"), { recursive: true })
  writeFileSync(join(root, "config", "config.json"), JSON.stringify(contents))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bot-mcp-"))
  env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
  keyring = memoryKeyring()
  calls = []
  new BotTokenStore({ app, profile: "sales", env: {}, configDir: join(root, "config"), keyring }).write("token")
  new ChatRegistry(app, "sales", env).observe([{ id: "-100", title: "Team", kind: "group" }])
})

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const connect = async (
  options: Partial<BotServerOptions> = {},
  { form }: { form?: (message: string) => ElicitResult } = {},
) => {
  const group = createProgram(definition).commands.find((one) => one.name() === "bot") as Command
  const settings = config.resolveSettings({ profile: "sales" }, { env, kind: "bot" })
  const { build, offered } = createBotServer({
    bot,
    commandAt: commandLookup(group),
    settings,
    env,
    run: runBot,
    tools: bot.mcp?.tools ?? [],
    ...options,
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  const server = build()
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "0" }, form ? { capabilities: { elicitation: {} } } : {})
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
    await server.close()
  })
  return { client, offered, forms }
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args })
  const body = result.structuredContent as Record<string, unknown>
  return { isError: result.isError === true, body, error: body?.error as { code?: string } | undefined }
}

const READS = [
  "chat_bot_chats_list",
  "chat_bot_chats_show",
  "chat_bot_messages_list",
  "chat_bot_messages_show",
  "chat_bot_chats_admins_list",
  "chat_bot_commands_list",
  "chat_bot_sends_list",
  "chat_bot_recipients_list",
]
const WRITES = [
  "chat_bot_messages_send",
  "chat_bot_messages_edit",
  "chat_bot_messages_pin",
  "chat_bot_messages_unpin",
  "chat_bot_chats_action",
  "chat_bot_callbacks_answer",
  "chat_bot_messages_delete",
  "chat_bot_chats_members_remove",
  "chat_bot_chats_moderate",
]

describe("bot mcp tools by permission level", () => {
  it("**offers every read and write the default levels allow**, and no tool whose command is not mounted", async () => {
    const { offered } = await connect()

    expect(offered.sort()).toEqual([...READS, ...WRITES, "chat_bot_chats_leave", "chat_bot_chats_admins_add"].sort())
  })

  it.each([
    ["bot: readonly hides the writes", { bot: "readonly" }, READS],
    ["bot: deny leaves what no level stops", { bot: "deny" }, ["chat_bot_sends_list", "chat_bot_recipients_list"]],
    [
      "a key opened under a read-only bot offers that write alone",
      { bot: "readonly", "bot.messages.send": "allow" },
      [...READS, "chat_bot_messages_send"],
    ],
    ["deny on one key hides that tool", { "bot.messages": "deny" }, null],
  ])("%s", async (_name, permissions, expected) => {
    configure({ bot: { profiles: { sales: { permissions } } } })
    const { offered } = await connect()

    if (expected) expect(offered.sort()).toEqual([...expected].sort())
    else expect(offered.some((name) => name.startsWith("chat_bot_messages_"))).toBe(false)
  })

  it("**the CLI's own tool replaces the shared one with the same words**", async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()

    expect(tools.find((one) => one.name === "chat_bot_sends_list")?.title).toBe("The CLI's own")
    expect(tools.map((one) => one.name)).toContain("chat_bot_status")
  })
})

describe("bot mcp writes", () => {
  it("**sends through the command**, by the chat's title, with no form at level allow", async () => {
    const { client } = await connect()

    const sent = await call(client, "chat_bot_messages_send", { chat: "Team", text: "Hello" })

    expect(sent.isError).toBe(false)
    expect(sent.body).toMatchObject({ message: { id: "100", chatId: "-100" } })
    expect(calls).toEqual(["send -100 Hello"])
  })

  it("**a deletion at level ask waits for the owner's form**, and a no deletes nothing", async () => {
    const declined = await connect({}, { form: () => ({ action: "decline" }) })
    expect((await call(declined.client, "chat_bot_messages_delete", { chat: "-100", message: "7" })).error?.code).toBe(
      "confirmation_required",
    )
    expect(calls).toEqual([])

    const accepted = await connect({}, { form: () => ({ action: "accept", content: {} }) })
    const done = await call(accepted.client, "chat_bot_messages_delete", { chat: "-100", message: "7" })

    expect(done.isError).toBe(false)
    expect(accepted.forms[0]).toContain("Delete a message?")
    expect(calls).toEqual(["delete -100 7"])
  })

  it("**--allow-dangerous deletes with no form**; --confirm-send puts even a send at level allow through one", async () => {
    const dangerous = await connect({ allowDangerous: true })
    expect((await call(dangerous.client, "chat_bot_messages_delete", { chat: "-100", message: "7" })).isError).toBe(
      false,
    )
    expect(calls).toEqual(["delete -100 7"])

    const confirming = await connect({ confirmSend: true }, { form: () => ({ action: "accept", content: {} }) })
    await call(confirming.client, "chat_bot_messages_send", { chat: "-100", text: "Hi" })
    expect(confirming.forms).toHaveLength(1)
  })

  it("refuses a message id that would read as a flag, before running anything", async () => {
    const { client } = await connect()

    const refused = await call(client, "chat_bot_messages_send", { chat: "-100", text: "x", reply_to: "--silent" })

    expect(refused.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it("**a write at level ask answers the command's own question after the form**, with --yes", async () => {
    configure({ bot: { profiles: { sales: { permissions: { "bot.messages.send": "ask" } } } } })
    const { client, forms } = await connect({}, { form: () => ({ action: "accept", content: {} }) })

    const sent = await call(client, "chat_bot_messages_send", { chat: "-100", text: "Hi" })

    expect(sent.isError).toBe(false)
    expect(forms).toHaveLength(1)
    expect(calls).toEqual(["send -100 Hi"])
  })
})

describe("a tool of the CLI's own with its own form", () => {
  it("**hands the form request to the client, then answers with what it did**", async () => {
    const { client, forms } = await connect({}, { form: () => ({ action: "accept", content: {} }) })

    const done = await call(client, "chat_bot_chats_leave", { chat: "Team" })

    expect(forms[0]).toContain('chat: "Team" (-100)')
    expect(done.body).toMatchObject({ left: "-100", seen: { items: [{ id: "-100", title: "Team" }] } })
  })
})

describe("a tool of the CLI's own and the form", () => {
  it("**is told to ask first under --confirm-send or level ask**, and not otherwise", async () => {
    const asked = async (options: Partial<BotServerOptions>) =>
      (await call((await connect(options)).client, "chat_bot_chats_admins_add")).body.confirmFirst

    expect(await asked({})).toBe(false)
    expect(await asked({ confirmSend: true })).toBe(true)
    configure({ bot: { profiles: { sales: { permissions: { "bot.chats.admins": "ask" } } } } })
    expect(await asked({})).toBe(true)
    expect(await asked({ yes: true })).toBe(false)
  })
})

describe("chat_bot_chats_moderate", () => {
  const deleting = (consent: "ask" | "allow") => {
    const rules = new ModerationRules(moderationPathFor(app, "sales", env))
    rules.set("-100", null, "invites", "delete")
    rules.set("-100", null, "consent.delete", consent)
  }

  it("**shows the actions the rules put at ask in one form, and does exactly those**", async () => {
    deleting("ask")
    const { client, forms } = await connect({}, { form: () => ({ action: "accept", content: {} }) })

    const done = await call(client, "chat_bot_chats_moderate", { chat: "Team" })

    expect(forms).toHaveLength(1)
    expect(forms[0]).toContain("delete message 2")
    expect(done.body).toMatchObject({ chatId: "-100", rows: [{ action: "delete", outcome: "done" }] })
    expect(calls).toEqual(["delete -100 2"])
  })

  it("deletes nothing when the owner declines", async () => {
    deleting("ask")
    const { client } = await connect({}, { form: () => ({ action: "decline" }) })

    expect((await call(client, "chat_bot_chats_moderate", { chat: "-100" })).isError).toBe(true)
    expect(calls).toEqual([])
  })

  it("acts at level allow with no form — and with one under --confirm-send", async () => {
    deleting("allow")
    expect((await call((await connect()).client, "chat_bot_chats_moderate", { chat: "-100" })).body).toMatchObject({
      rows: [{ outcome: "done" }],
    })

    const confirming = await connect({ confirmSend: true }, { form: () => ({ action: "accept", content: {} }) })
    await call(confirming.client, "chat_bot_chats_moderate", { chat: "-100", since_time: "2026-01-01T00:00:00Z" })
    expect(confirming.forms).toHaveLength(1)
  })
})

describe("bot mcp config", () => {
  it("**prints the entry for `bot mcp`**, and says the old flags decide nothing", async () => {
    const streams = captureStreams()
    const code = await run(["sales", "bot", "mcp", "config", "--allow-send", "--confirm-send", "--json"], definition, {
      streams,
      tty: false,
      env,
      mcp: { execPath: "/usr/bin/node", scriptPath: "/opt/chat/cli.js" },
    })

    expect(code).toBe(0)
    expect(JSON.parse(streams.stdout[0] ?? "")).toEqual({
      mcpServers: {
        "chat-bot-sales": {
          type: "stdio",
          command: "/usr/bin/node",
          args: ["/opt/chat/cli.js", "sales", "bot", "mcp", "--confirm-send"],
          env: { CHAT_CONFIG_DIR: env.CHAT_CONFIG_DIR, CHAT_STATE_DIR: env.CHAT_STATE_DIR },
        },
      },
    })
    expect(streams.stderr.join("\n")).toContain(
      "--allow-send no longer decides anything: the bot profile's permissions do",
    )
  })

  it("is not mounted for a messenger that hands in no run", () => {
    const { mcp: _mcp, ...without } = bot
    expect(botCommand(without).commands.map((one) => one.name())).not.toContain("mcp")
  })
})
