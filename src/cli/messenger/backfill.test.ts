import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { backfillCommand } from "./backfill-command.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const message = (id: number): Message => ({
  id: String(id),
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString(),
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

/** A chat whose messages are 1..newest; `wait` makes the first request refuse with a FloodWait. */
const chatOf = (state: { newest: number; asked: (string | undefined)[]; wait?: number }): MessengerAdapter =>
  ({
    self: () => "500",
    close: async () => {},
    history: async (_chat: string, { limit, before }: { limit: number; before?: string }) => {
      state.asked.push(before)
      if (state.wait !== undefined) {
        const retryAfterMs = state.wait
        delete state.wait
        throw new CliError("rate_limited", "wait", { retryAfterMs })
      }
      const upper = before === undefined ? state.newest : Number(before) - 1
      const low = Math.max(1, upper - limit + 1)
      const items = upper < 1 ? [] : Array.from({ length: upper - low + 1 }, (_, index) => message(low + index))
      return { items, hasMore: low > 1 }
    },
  }) as unknown as MessengerAdapter

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "backfill-"))
  return { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
}

const call = async (argv: string[], connection: MessengerAdapter, env: NodeJS.ProcessEnv) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => connection,
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [backfillCommand(messenger)] }, { streams, tty: false, env })
  return { code, answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined }
}

describe("backfill", () => {
  it("**stops at --max keeping what it read, and the next run fetches only what is missing**", async () => {
    const env = setup()
    const state = { newest: 250, asked: [] as (string | undefined)[] }

    const first = await call(["backfill", "7", "--max", "120", "--pace", "1ms", "--json"], chatOf(state), env)
    expect(first.answer).toEqual({ chat: "7", fetched: 200, complete: false, ranges: [{ from: 51, to: 250 }] })

    state.newest = 260
    state.asked = []
    const second = await call(["backfill", "7", "--pace", "1ms", "--json"], chatOf(state), env)
    expect(second.answer).toEqual({ chat: "7", fetched: 150, complete: true, ranges: [{ from: 1, to: 260 }] })
    // The newest page, then straight past the 51..250 already held.
    expect(state.asked).toEqual([undefined, "51"])
  })

  it("sits out a short wait the provider asks for", async () => {
    const state = { newest: 30, asked: [] as (string | undefined)[], wait: 5 }
    const { code, answer } = await call(["backfill", "7", "--pace", "1ms", "--json"], chatOf(state), setup())

    expect(code).toBe(0)
    expect(answer).toMatchObject({ fetched: 30, complete: true })
  })

  it("stops at a long wait with what it had read kept", async () => {
    const env = setup()
    const state = { newest: 250, asked: [] as (string | undefined)[] }
    await call(["backfill", "7", "--max", "100", "--pace", "1ms"], chatOf(state), env)

    const refused = await call(["backfill", "7", "--pace", "1ms"], chatOf({ ...state, wait: 10 * 60_000 }), env)
    expect(refused.code).toBe(8)
    const resumed = await call(["backfill", "7", "--pace", "1ms", "--json"], chatOf(state), env)
    expect(resumed.answer).toMatchObject({ complete: true, ranges: [{ from: 1, to: 250 }] })
  })
})
