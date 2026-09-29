import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Chat } from "../../domain/models.js"
import { MIGRATIONS, migrate } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { chatsCommand } from "./chats-command.js"
import type { Messenger } from "./context.js"
import { doctorCommand } from "./doctor-command.js"
import type { MessengerAdapter } from "./port.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 2,
}
const connection = {
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat], hasMore: false }),
  close: async () => {},
} as unknown as MessengerAdapter

const refused = async (): Promise<MessengerAdapter> => {
  throw new CliError("authentication_error", "no session")
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-"))
  return {
    root,
    env: {
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    },
  }
}

const call = async (argv: string[], env: NodeJS.ProcessEnv, connect: Messenger["connect"]) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
    diagnose: async () => ({ session: { exists: true } }),
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [doctorCommand(messenger), chatsCommand(messenger)] },
    {
      streams,
      tty: false,
      env,
    },
  )
  return {
    code,
    answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined,
    stdout: streams.stdout,
    stderr: streams.stderr,
  }
}

describe("doctor", () => {
  it("**answers on a fresh install without connecting**", async () => {
    const { env } = setup()
    const { code, answer } = await call(["doctor", "--json"], env, refused)

    expect(code).toBe(0)
    expect(answer).toMatchObject({
      cli: { command: "chat", version: "1.0.0" },
      account: { remembered: null },
      store: { exists: false },
      chat: { session: { exists: true } },
    })
  })

  it("reads the store and the remembered account once something was read", async () => {
    const { env } = setup()
    await call(["chats", "list"], env, async () => connection)

    const { answer } = await call(["doctor", "--json"], env, refused)
    expect(answer).toMatchObject({
      account: { remembered: "500" },
      store: { exists: true, schema: MIGRATIONS.at(-1)?.version, chats: 1 },
    })
  })

  it("**answers when the configuration will not load**, and says why", async () => {
    const { root, env } = setup()
    mkdirSync(join(root, "config"), { recursive: true })
    writeFileSync(join(root, "config", "config.json"), "{ not json")

    const { code, answer } = await call(["doctor", "--json"], env, refused)
    expect(code).toBe(0)
    expect(answer.config.error).toBeTypeOf("string")
  })

  it("says a store from a newer version cannot be written, and leaves it as it was", async () => {
    const { env } = setup()
    const database = await openCache(env.MESSAGING_STORE)
    const latest = MIGRATIONS.at(-1)?.version ?? 0
    migrate(database, {
      migrations: [...MIGRATIONS, { version: latest + 1, minCompatible: latest + 1, statements: [] }],
    })
    database.close()

    const { answer } = await call(["doctor", "--json"], env, refused)
    expect(answer.store).toMatchObject({ schema: latest + 1, speaks: latest, writable: false })
  })

  it("with --online, connects once, and says a failure rather than failing", async () => {
    const { env } = setup()
    await call(["chats", "list"], env, async () => connection)

    expect((await call(["doctor", "--online", "--json"], env, async () => connection)).answer.online).toMatchObject({
      ok: true,
      matchesRemembered: true,
    })
    const failed = await call(["doctor", "--online", "--json"], env, refused)
    expect(failed.code).toBe(0)
    expect(failed.answer.online).toMatchObject({ ok: false, errorCode: "authentication_error" })
  })
})

describe("doctor report", () => {
  const failedRun = (root: string) => {
    const dir = join(root, "state", "runs", "2026-09-29", "20260929T100000Z-chats-list-abc123")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({
        runId: "20260929T100000Z-chats-list-abc123",
        command: "chats list",
        profile: "default",
        startedAt: "2026-09-29T10:00:00.000Z",
        status: "failed",
        cliVersion: "1.0.0",
        errorCode: "provider_error",
      }),
    )
    writeFileSync(
      join(dir, "events.jsonl"),
      `${JSON.stringify({
        level: 30,
        hostname: "owners-laptop",
        msg: "Book club",
        event: "response",
        operation: "chats.show",
        ids: { chat: "-1001234567890" },
        outcome: "error",
        errorCode: "provider_error",
      })}\n`,
    )
  }

  it("**writes a file with no id, no title and no home folder in it**, and the same label for the same id", async () => {
    const { root, env } = setup()
    const home = join(root, "home")
    await call(["chats", "list", "--json"], env, async () => connection)
    failedRun(root)
    mkdirSync(join(root, "state", "sends"), { recursive: true })
    writeFileSync(
      join(root, "state", "sends", "default.jsonl"),
      `${JSON.stringify({ at: "2026-09-29T10:00:00.000Z", profile: "default", chatId: "-1001234567890", outcome: "sent", messageId: "42", length: 5 })}\n`,
    )
    const output = join(root, "report.json")

    const { code, answer } = await call(
      ["doctor", "report", "create", "--output", output, "--json"],
      { ...env, HOME: root, CHAT_CONFIG_DIR: join(home, "config") },
      refused,
    )

    expect(code).toBe(0)
    expect(answer).toEqual({ path: output, run: "20260929T100000Z-chats-list-abc123" })
    const text = readFileSync(output, "utf8")
    for (const secret of ["-1001234567890", "Book club", "owners-laptop", root]) expect(text).not.toContain(secret)
    const report = JSON.parse(text)
    const label = report.run.events[0].ids.chat
    expect(label).toMatch(/^id:[0-9a-f]{12}$/)
    expect(report.sends[0]).toMatchObject({ chatId: label, outcome: "sent", length: 5 })
    expect(report.doctor.account.remembered).toMatch(/^id:/)
    expect(report.doctor.config.path).toBe("~/home/config/config.json")
    expect(Object.keys(report.run.events[0]).sort()).toEqual(["errorCode", "event", "ids", "operation", "outcome"])
  })

  it("names a run that does not exist, and explains itself without writing", async () => {
    const { env } = setup()
    const missing = await call(["doctor", "report", "create", "--run", "nope"], env, refused)
    expect(missing.code).not.toBe(0)
    expect(missing.stderr.join("\n")).toContain("chat runs list")

    const explained = await call(["doctor", "report", "--json"], env, refused)
    expect(explained.answer).toMatchObject({ create: "chat doctor report create" })
  })
})
