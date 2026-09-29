import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { backfillCommand } from "./backfill-command.js"
import type { SpawnJob } from "./backfill-jobs.js"
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

const call = async (
  argv: string[],
  connection: MessengerAdapter,
  env: NodeJS.ProcessEnv,
  extra: { spawnJob?: SpawnJob; signal?: AbortSignal } = {},
) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => connection,
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [backfillCommand(messenger)] },
    {
      streams,
      tty: false,
      env,
      ...extra,
    },
  )
  return {
    code,
    answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined,
    stdout: streams.stdout,
    stderr: streams.stderr.join("\n"),
  }
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

describe("backfill in the background", () => {
  const spawned = (pid: number) => {
    const calls: { argv: string[]; env: NodeJS.ProcessEnv; log: string }[] = []
    const spawnJob: SpawnJob = (argv, env, log) => {
      calls.push({ argv, env, log })
      return pid
    }
    return { calls, spawnJob }
  }
  const idle = chatOf({ newest: 0, asked: [] })

  it("**starts a job that runs the same backfill apart, pinned to the profile, with no shell timeout**", async () => {
    const env = { ...setup(), CHAT_TIMEOUT: "30s" }
    const { calls, spawnJob } = spawned(process.pid)

    const started = await call(["backfill", "7", "--max", "50", "--pace", "1ms", "--background", "--json"], idle, env, {
      spawnJob,
    })

    expect(started.answer).toMatchObject({ pid: process.pid, chat: "7" })
    const job = started.answer.job as string
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(["backfill", "7", "--max", "50", "--pace", "1ms", "--json"])
    expect(calls[0]?.env).toMatchObject({ CHAT_PROFILE: "default", CHAT_BACKFILL_JOB: job })
    expect(calls[0]?.env.CHAT_TIMEOUT).toBeUndefined()
    expect((await call(["backfill", "list", "--json"], idle, env)).answer).toEqual([
      expect.objectContaining({ job, state: "running", fetched: 0, max: 50 }),
    ])

    const again = await call(["backfill", "7", "--background"], idle, env, { spawnJob })
    expect(again.code).not.toBe(0)
    expect(again.stderr).toContain(`job ${job} is already backfilling 7`)
  })

  it("the job's own run records its progress and outcome, and status adds what the store holds", async () => {
    const env = setup()
    const { calls, spawnJob } = spawned(process.pid)
    const { job } = (await call(["backfill", "7", "--background", "--json"], idle, env, { spawnJob })).answer

    const state = { newest: 150, asked: [] as (string | undefined)[] }
    const child = await call(calls[0]?.argv ?? [], chatOf(state), { ...env, ...calls[0]?.env })
    expect(child.code).toBe(0)

    expect((await call(["backfill", "status", "--json"], idle, env)).answer).toMatchObject({
      job,
      state: "done",
      fetched: 150,
      complete: true,
      held: [{ from: 1, to: 150 }],
    })
  })

  it("a job that fails says how; one that vanished without a word has died", async () => {
    const env = setup()
    const { calls, spawnJob } = spawned(process.pid)
    const { job } = (await call(["backfill", "7", "--background", "--json"], idle, env, { spawnJob })).answer
    const wait = { newest: 10, asked: [] as (string | undefined)[], wait: 10 * 60_000 }
    await call(calls[0]?.argv ?? [], chatOf(wait), { ...env, ...calls[0]?.env })

    expect((await call(["backfill", "status", job, "--json"], idle, env)).answer).toMatchObject({
      state: "failed",
      error: { code: "rate_limited" },
    })

    const gone = spawned(2 ** 22 + 12345)
    const other = (await call(["backfill", "8", "--background", "--json"], idle, env, gone)).answer
    expect((await call(["backfill", "status", other.job, "--json"], idle, env)).answer).toMatchObject({ state: "died" })
    const refused = await call(["backfill", "cancel", other.job], idle, env)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain("is not running — it is died")
  })

  it("cancel sends the job SIGTERM", async () => {
    const env = setup()
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"])
    const exited = new Promise((resolve) => sleeper.on("exit", (_code, signal) => resolve(signal)))
    const { job } = (await call(["backfill", "7", "--background", "--json"], idle, env, spawned(sleeper.pid ?? 0)))
      .answer

    expect((await call(["backfill", "cancel", job, "--json"], idle, env)).answer).toEqual({ job, cancelled: true })
    expect(await exited).toBe("SIGTERM")
    expect((await call(["backfill", "status", job, "--json"], idle, env)).answer).toMatchObject({ state: "cancelled" })
  })

  it("a stop ends the run after the page in hand, with that page kept", async () => {
    const stop = new AbortController()
    const chat = chatOf({ newest: 250, asked: [] })
    const history = chat.history.bind(chat)
    chat.history = async (...args) => {
      stop.abort()
      return history(...args)
    }

    const { answer } = await call(["backfill", "7", "--pace", "1ms", "--json"], chat, setup(), { signal: stop.signal })
    expect(answer).toMatchObject({ fetched: 100, stopped: true, ranges: [{ from: 151, to: 250 }] })
  })

  it("status and cancel name a job that does not exist", async () => {
    const env = setup()
    expect((await call(["backfill", "status"], idle, env)).stderr).toContain("no background backfill jobs")
    expect((await call(["backfill", "cancel", "nope"], idle, env)).stderr).toContain("no backfill job nope")
    expect((await call(["backfill", "list", "--json"], idle, env)).answer).toEqual([])
  })
})
