import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Chat } from "../../domain/models.js"
import { MIGRATIONS, migrate } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { chatsCommand } from "./commands.js"
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
  return { code, answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined }
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
    expect(answer).toMatchObject({ account: { remembered: "500" }, store: { exists: true, schema: 1, chats: 1 } })
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
    migrate(database, { migrations: [...MIGRATIONS, { version: 2, minCompatible: 2, statements: [] }] })
    database.close()

    const { answer } = await call(["doctor", "--json"], env, refused)
    expect(answer.store).toMatchObject({ schema: 2, speaks: 1, writable: false })
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
