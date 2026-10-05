import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { LoadEngine } from "../../attachments/extract.js"
import { importEngine } from "../../attachments/extract.js"
import type { Attachment, Chat, Message } from "../../domain/models.js"
import { openCache } from "../../store/open.js"
import { openStore } from "../../store/store.js"
import { docx, pdf } from "../../testing/files.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { storeCommand } from "./archive-commands.js"
import { attachmentsCommand } from "./attachments-command.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import type { MessengerAdapter } from "./port.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const OWNER = { provider: "chat", account: "500" }
const SECRET = "Quarterly invoice"

const chat: Chat = {
  id: "7",
  title: "Work fixture",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
}
const message = (id: string, attachments: Attachment[]): Message => ({
  id,
  chatId: "7",
  senderId: "10",
  senderName: "Alice Synthetic",
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, Number(id))).toISOString(),
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const adapter = (bytes: Uint8Array): MessengerAdapter => ({
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat], hasMore: false }),
  history: async () => ({ items: [], hasMore: false }),
  resolve: async () => chat,
  chat: async () => ({ ...chat, members: [] }),
  send: async () => {
    throw new Error("never sends")
  },
  logout: async () => {},
  close: async () => {},
  download: async () => ({
    files: [
      {
        kind: "file",
        name: "fetched.txt",
        bytes: async function* () {
          yield bytes
        },
      },
    ],
    skipped: [],
  }),
})

/**
 * Chat 7: message 1 with notes.txt, 2 with deal.docx, 3 with scan.pdf (a text layer), 4 with an empty PDF,
 * 5 with a photo, 6 with a voice note, 7 with a file nobody downloaded.
 */
const setup = async ({ config, load }: { config?: object; load?: LoadEngine } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "attachments-cli-"))
  const env = {
    ...process.env,
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  if (config) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(config))
  }
  rememberAccount(app, "default", "500", env)
  const files = join(root, "files")
  mkdirSync(files)
  const saved: [string, string, Uint8Array][] = [
    ["1", "notes.txt", new TextEncoder().encode(`${SECRET} for March`)],
    ["2", "deal.docx", docx(["Договор поставки"])],
    ["3", "scan.pdf", pdf("Delivery note 77")],
    ["4", "blank.pdf", pdf()],
    ["5", "5-1.jpg", new Uint8Array([0xff, 0xd8])],
    ["6", "6-1.ogg", new Uint8Array([0x4f, 0x67])],
  ]
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.saveChats(OWNER, [chat])
  await store.saveMessages(
    OWNER,
    "7",
    [
      ...saved.map(([id, name]) => message(id, [{ kind: id === "5" ? "photo" : id === "6" ? "voice" : "file", name }])),
      message("7", [{ kind: "file", name: "later.txt" }]),
    ],
    { via: "history" },
  )
  for (const [id, name, bytes] of saved) {
    writeFileSync(join(files, name), bytes)
    await store.keepDownloads(OWNER, "7", id, [
      { kind: id === "5" ? "photo" : id === "6" ? "voice" : "file", name, path: join(files, name) },
    ])
  }
  await store.close()
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => adapter(new TextEncoder().encode("fetched invoice text")),
    chatArgument: "a chat",
    ...(load
      ? {
          services: (base) => ({
            attachments: { ...base.attachments, extract: (options) => base.attachments.extract({ ...options, load }) },
          }),
        }
      : {}),
  }
  const runs =
    (tty: boolean, stdin?: string) =>
    async (...argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        argv,
        { app, commands: () => [attachmentsCommand(messenger), messagesCommand(messenger), storeCommand(messenger)] },
        {
          streams,
          tty,
          env: { ...env, NO_COLOR: "1" },
          ...(stdin === undefined ? {} : { stdin: Object.assign(Readable.from([stdin]), { isTTY: false }) }),
        },
      )
      return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
    }
  return { call: runs(false), pretty: runs(true), piped: (text: string) => runs(false, text), root, env, files }
}

const json = (result: { stdout: string }) => JSON.parse(result.stdout || "null")
const hits = async (call: (...argv: string[]) => Promise<{ stdout: string }>, query: string) =>
  json(await call("messages", "search", query, "--language", "lucene", "--json")).items.map(
    ({ id }: { id: string }) => id,
  )

describe("attachments extract", () => {
  it("**reads every saved file's text layer into the store, answering what it did and never the text**", async () => {
    const { call } = await setup()
    const done = await call("attachments", "extract", "--json")

    expect(done.code).toBe(0)
    expect(done.stdout).not.toContain("Quarterly")
    expect(done.stderr).not.toContain("Quarterly")
    const answer = json(done)
    expect(answer).toMatchObject({
      extracted: 3,
      needsAgent: 2,
      failed: 0,
      unsupported: 1,
      notDownloaded: 1,
      complete: true,
    })
    expect(answer.items).toEqual([
      { locator: "msg:chat/500/7/5", attachment: 1, kind: "photo", name: "5-1.jpg", status: "needs-agent" },
      expect.objectContaining({
        locator: "msg:chat/500/7/4",
        status: "needs-agent",
        extractor: expect.stringMatching(/^pdf:unpdf@/),
      }),
      expect.objectContaining({ locator: "msg:chat/500/7/3", status: "extracted", chars: expect.any(Number) }),
      expect.objectContaining({
        locator: "msg:chat/500/7/2",
        status: "extracted",
        extractor: expect.stringMatching(/^docx:mammoth@/),
      }),
      {
        locator: "msg:chat/500/7/1",
        attachment: 1,
        kind: "file",
        name: "notes.txt",
        status: "extracted",
        extractor: "plain",
        chars: 27,
      },
    ])

    expect(await hits(call, "content:invoice")).toEqual(["1"])
    expect(await hits(call, "content:договор")).toEqual(["2"])
    expect(await hits(call, 'content:"delivery note"')).toEqual(["3"])
    expect(await hits(call, "text:invoice")).toEqual([])
  })

  it("**a second run reads nothing unchanged; a file of another size is read again**", async () => {
    const { call, files } = await setup()
    await call("attachments", "extract", "--json")
    expect(json(await call("attachments", "extract", "--json"))).toMatchObject({
      extracted: 0,
      unchanged: 4,
      items: [expect.objectContaining({ status: "needs-agent" })],
    })

    writeFileSync(join(files, "notes.txt"), "Revised estimate")
    expect(json(await call("attachments", "extract", "--json"))).toMatchObject({ extracted: 1, unchanged: 3 })
    expect(await hits(call, "content:estimate")).toEqual(["1"])
    expect(await hits(call, "content:invoice")).toEqual([])
  })

  it("**--limit stops after that many files read, and the next run continues**", async () => {
    const { call } = await setup()
    expect(json(await call("attachments", "extract", "--limit", "2", "--json"))).toMatchObject({
      complete: false,
      items: [{}, {}],
    })
    expect(json(await call("attachments", "extract", "--json"))).toMatchObject({
      complete: true,
      extracted: 3,
      unchanged: 1,
    })
  })

  it("names a file that is gone, and reads only one chat's files with --chat", async () => {
    const { call, files } = await setup()
    writeFileSync(join(files, "notes.txt"), "")
    const { rmSync } = await import("node:fs")
    rmSync(join(files, "notes.txt"))
    const answer = json(await call("attachments", "extract", "--chat", "Work fixture", "--json"))
    expect(answer.items.find(({ locator }: { locator: string }) => locator === "msg:chat/500/7/1")).toMatchObject({
      status: "missing",
    })
    expect(json(await call("attachments", "extract", "--chat", "7", "--json")).extracted).toBe(0)
  })

  it("**says once which optional package to install, and reads those files on a later run**", async () => {
    const without: LoadEngine = async (name) => {
      if (name === "unpdf")
        throw Object.assign(new Error("Cannot find package 'unpdf'"), { code: "ERR_MODULE_NOT_FOUND" })
      return importEngine(name)
    }
    const { call } = await setup({ load: without })
    const done = await call("attachments", "extract", "--json")
    expect(json(done)).toMatchObject({ enginesMissing: ["unpdf"], extracted: 2 })
    expect(done.stderr.match(/npm install -g unpdf/g)).toHaveLength(1)
  })

  it("prints one line per file in a terminal, and the summary on stderr", async () => {
    const { pretty } = await setup()
    const done = await pretty("attachments", "extract")
    expect(done.stdout).toContain("extracted  msg:chat/500/7/1 #1  notes.txt")
    expect(done.stdout).not.toContain("Quarterly")
    expect(done.stderr).toContain("3 extracted")
  })

  it("**--download saves the files nobody saved, records where, and reads them**", async () => {
    const { call, root } = await setup()
    const into = join(root, "fetched")
    const answer = json(await call("attachments", "extract", "--download", "--output-dir", into, "--json"))
    expect(answer).toMatchObject({ notDownloaded: 0, extracted: 4 })
    expect(await hits(call, "content:fetched")).toEqual(["7"])
    const database = await openCache(join(root, "m.db"))
    const row = database.prepare("SELECT local_path FROM attachments WHERE name = 'later.txt'").get()
    database.close()
    expect(row?.local_path).toBe(join(into, "fetched.txt"))
  })

  it("refuses --download without a folder, a folder without --download, and a read-only profile", async () => {
    const { call } = await setup()
    expect((await call("attachments", "extract", "--download")).stderr).toContain("--output-dir")
    expect((await call("attachments", "extract", "--output-dir", "x")).stderr).toContain("add --download")
    const locked = await setup({ config: { profiles: { default: { permissions: { attachments: "readonly" } } } } })
    const refused = await locked.call("attachments", "extract")
    expect(refused.code).toBe(5)
    expect(refused.stderr).toContain("permissions.attachments.extract allow")
  })

  it("**store reindex rebuilds the files' word index**", async () => {
    const { call } = await setup()
    await call("attachments", "extract")
    expect(json(await call("store", "reindex", "--json"))).toMatchObject({ fileTexts: 3 })
    expect(await hits(call, "content:invoice")).toEqual(["1"])
  })
})

describe("an agent's text for a file", () => {
  it("**lists what needs reading, keeps what the agent read, and content: finds it**", async () => {
    const { call, piped, root } = await setup()
    await call("attachments", "extract")
    const needs = json(await call("attachments", "list", "--needs-text", "--json"))
    expect(needs).toMatchObject({ page: 1, hasMore: false })
    expect(needs.items.map(({ locator }: { locator: string }) => locator)).toEqual([
      "msg:chat/500/7/5",
      "msg:chat/500/7/4",
    ])
    expect(needs.items[1]).toMatchObject({
      attachment: 1,
      name: "blank.pdf",
      text: { origin: "extracted", chars: 0, error: "no_text" },
    })

    const textFile = join(root, "read.txt")
    writeFileSync(textFile, "Акт сверки за март")
    const kept = json(await call("attachments", "text", "set", "Work fixture", "4", "--text-file", textFile, "--json"))
    expect(kept).toEqual({
      locator: "msg:chat/500/7/4",
      attachment: 1,
      origin: "agent",
      chars: 18,
      replaced: "extracted",
    })
    const fromStdin = await piped("Фото доски: план релиза")("attachments", "text", "set", "msg:chat/500/7/5", "--json")
    expect(json(fromStdin)).toMatchObject({ locator: "msg:chat/500/7/5", replaced: null })
    expect(fromStdin.stderr).not.toContain("релиза")

    expect(await hits(call, "content:сверки")).toEqual(["4"])
    expect(await hits(call, 'content:"план релиза"')).toEqual(["5"])
    expect(json(await call("attachments", "list", "--needs-text", "--json")).items).toEqual([])
    expect(json(await call("attachments", "list", "--chat", "7", "--limit", "2", "--json"))).toMatchObject({
      hasMore: true,
    })

    await call("attachments", "extract")
    expect(await hits(call, "content:сверки")).toEqual(["4"])
  })

  it("refuses empty text, a message the store lacks, an unknown file number, another account and read-only", async () => {
    const { piped, env } = await setup()
    expect((await piped("  ")("attachments", "text", "set", "7", "4")).stderr).toContain("empty")
    expect((await piped("x")("attachments", "text", "set", "7", "99")).code).toBe(6)
    expect((await piped("x")("attachments", "text", "set", "7", "4", "--attachment", "2")).stderr).toContain(
      "no file number 2",
    )
    expect((await piped("x")("attachments", "text", "set", "msg:chat/501/7/4")).stderr).toContain("another account")
    expect((await piped("x")("attachments", "text", "set", "7")).stderr).toContain("which message")
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.saveMessages(OWNER, "7", [message("8", [{ kind: "photo" }, { kind: "photo" }])], { via: "history" })
    await store.close()
    expect((await piped("x")("attachments", "text", "set", "7", "8")).stderr).toContain("has 2 files")
    expect(json(await piped("x")("attachments", "text", "set", "7", "8", "--attachment", "2", "--json"))).toMatchObject(
      {
        attachment: 2,
      },
    )
    const locked = await setup({
      config: { profiles: { default: { permissions: { "attachments.text.set": "readonly" } } } },
    })
    expect((await locked.piped("x")("attachments", "text", "set", "7", "4")).code).toBe(5)
  })
})
