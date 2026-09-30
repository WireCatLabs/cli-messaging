import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import { MIGRATIONS, migrate } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { storeCommand } from "./archive-commands.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const latest = MIGRATIONS.at(-1)?.version ?? 0
const DAY = 24 * 60 * 60 * 1000

const envFor = () => {
  const root = mkdtempSync(join(tmpdir(), "store-maintenance-"))
  return {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

/** A file at `version`, one chat whose list says a message came a day after the newest one held. */
const seeded = async (env: NodeJS.ProcessEnv, version = latest) => {
  const database = await openCache(String(env.MESSAGING_STORE))
  migrate(database, { migrations: MIGRATIONS.filter((migration) => migration.version <= version) })
  database.exec(`INSERT INTO accounts (pk, provider, native_id, created_at) VALUES (1, 'chat', '500', 0)`)
  database.exec(
    `INSERT INTO chats (pk, account_pk, native_id, kind, title, last_message_at, updated_at)
     VALUES (1, 1, '7', 'group', 'Book club', ${2 * DAY}, ${DAY}), (2, 1, '8', 'private', 'Ana', ${DAY}, ${DAY})`,
  )
  database.exec(
    `INSERT INTO messages (chat_pk, account_pk, native_id, sent_at, text, ingested_at, ingested_via)
     VALUES (1, 1, '1', ${DAY}, 'Hola, ¿qué tal?', 0, 'fetch'), (2, 1, '1', ${DAY}, 'Ёлка', 0, 'fetch')`,
  )
  return database
}

const call = async (argv: string[], env: NodeJS.ProcessEnv) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("the store's maintenance never connects")
    },
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [storeCommand(messenger)] }, { streams, tty: false, env })
  return { code, stdout: streams.stdout, stderr: streams.stderr, answer: JSON.parse(streams.stdout[0] ?? "null") }
}

describe("store info", () => {
  it("says there is no file rather than creating one", async () => {
    const env = envFor()
    const { answer } = await call(["store", "info", "--json"], env)
    expect(answer).toEqual({ path: env.MESSAGING_STORE, exists: false })
  })

  it("reads a file behind this build without migrating it", async () => {
    const env = envFor()
    ;(await seeded(env, 5)).close()

    const { answer } = await call(["store", "info", "--json"], env)
    expect(answer).toMatchObject({
      schema: { version: 5, speaks: latest, writable: true },
      rows: { accounts: 1, chats: 2, messages: 2 },
      pendingNormalization: null,
    })
    expect((await call(["store", "info", "--json"], env)).answer.schema.version).toBe(5)
  })
})

describe("store check", () => {
  it("**prints one JSON value on stdout and the advice on stderr**", async () => {
    const env = envFor()
    ;(await seeded(env)).close()

    const { code, stdout, stderr, answer } = await call(["store", "check", "--json"], env)
    expect(code).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(answer).toMatchObject({
      ok: true,
      integrity: ["ok"],
      foreignKeyViolations: 0,
      searchIndexes: { messages_fts: "ok", chats_fts: "ok", identities_fts: "ok" },
    })
    expect(stderr.join("\n")).toContain("chat store fetch <chat>")
  })

  it("names the chat whose held history stops before its newest message", async () => {
    const env = envFor()
    ;(await seeded(env)).close()

    const { answer } = await call(["store", "check", "--json"], env)
    expect(answer.chatsBehind).toEqual([
      {
        provider: "chat",
        account: "500",
        chat: "7",
        title: "Book club",
        newest: new Date(2 * DAY).toISOString(),
        held: new Date(DAY).toISOString(),
        refreshed: new Date(DAY).toISOString(),
      },
    ])
  })

  it("**reports a search index that no longer matches its table**, and repairs nothing", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec("DROP TRIGGER messages_fts_au")
    database.exec("UPDATE messages SET text = 'changed behind the index' WHERE pk = 1")
    database.close()

    const first = (await call(["store", "check", "--json"], env)).answer
    expect(first.ok).toBe(false)
    expect(first.checks.searchIndexes).toBe(false)
    expect(first.searchIndexes.messages_fts).not.toBe("ok")
    expect((await call(["store", "check", "--json"], env)).answer.searchIndexes).toEqual(first.searchIndexes)
  })
})

describe("a file that is empty or is not a database", () => {
  it("answers for the empty file a store makes before its first migration", async () => {
    const env = envFor()
    writeFileSync(String(env.MESSAGING_STORE), "")

    expect((await call(["store", "info", "--json"], env)).answer).toMatchObject({ schema: { version: 0 }, rows: {} })
    const { answer, stdout } = await call(["store", "check", "--json"], env)
    expect(stdout).toHaveLength(1)
    expect(answer).toMatchObject({ opens: true, ok: false, checks: { schema: false }, searchIndexes: {} })
  })

  it("**says a file that will not open does not open**, instead of failing", async () => {
    const env = envFor()
    writeFileSync(String(env.MESSAGING_STORE), "not a database, not even close".repeat(40))

    for (const command of ["info", "check"]) {
      const { code, stdout, answer } = await call(["store", command, "--json"], env)
      expect(code).toBe(0)
      expect(stdout).toHaveLength(1)
      expect(answer).toMatchObject({ exists: true, opens: false, error: expect.any(String) })
    }
  })
})

describe("store migrate", () => {
  it("brings a version 5 file up to this build and normalizes what it held, saying so on stderr", async () => {
    const env = envFor()
    ;(await seeded(env, 5)).close()

    const { answer, stderr } = await call(["store", "migrate", "--json"], env)
    expect(answer).toEqual({ path: env.MESSAGING_STORE, exists: true, from: 5, to: latest, normalized: 2 })
    expect(stderr.join("\n")).toContain("2 of 2")

    const database = await openCache(String(env.MESSAGING_STORE))
    expect(database.prepare("SELECT normalized_text FROM messages ORDER BY pk").all()).toEqual([
      { normalized_text: "hola, ¿que tal?" },
      { normalized_text: "елка" },
    ])
    database.close()
    expect((await call(["store", "migrate", "--json"], env)).answer).toMatchObject({ from: latest, normalized: 0 })
  })
})
