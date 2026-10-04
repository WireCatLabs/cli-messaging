import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import { defaultRule } from "../../replies/rules.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"
import { repliesCommand } from "./replies-command.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const sendsNothing = async (): Promise<MessengerAdapter> => {
  throw new Error("replies test must never connect, let alone send")
}

const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: sendsNothing,
  chatArgument: "a chat",
}

const setUp = async () => {
  const root = mkdtempSync(join(tmpdir(), "replies-test-"))
  const env = {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  rememberAccount(app, "default", "500", env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  const account = { provider: "chat", account: "500" }
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const dialog = { kind: "dialog" as const, unreadCount: 0, lastMessageAt: at(1), participantsCount: null }
  const said = (id: string, minutes: number) => ({
    id,
    chatId: "11",
    senderId: "11",
    senderName: "Ana Example",
    timestamp: at(minutes),
    editedAt: null,
    text: "are you there?",
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  })
  await store.saveChats(account, [{ ...dialog, id: "11", title: "Ana" }])
  await store.saveMessages(account, "11", [said("1", 30), said("2", 20)], { via: "test" })
  await store.close()
  mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
  const rule = {
    ...defaultRule("away"),
    reply: { template: "Thanks, {firstName} — later today.", model: "fill-only", asReply: true },
    limits: { perChat: "5/1d", perPerson: "1/1d" },
  }
  writeFileSync(
    join(env.CHAT_CONFIG_DIR, "default.replies.json"),
    JSON.stringify({ testers: [{ id: "11" }], rules: [rule] }),
  )
  return { env, root }
}

const replies = async (argv: string[], env: NodeJS.ProcessEnv) => {
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [repliesCommand(messenger)] }, { streams, tty: false, env })
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

describe("replies test", () => {
  it("**says what a rule would answer, counting its limits, and sends, connects and saves nothing**", async () => {
    const { env } = await setUp()
    const before = readdirSync(env.CHAT_STATE_DIR).sort()

    const { code, stdout } = await replies(["replies", "test", "--json"], env)

    expect(code).toBe(0)
    const answer = JSON.parse(stdout.join(""))
    const [away] = answer.rules
    expect(away.would).toEqual([
      expect.objectContaining({
        locator: "msg:chat/500/11/1",
        to: { id: "11", name: "Ana Example" },
        text: "Thanks, Ana — later today.",
      }),
    ])
    expect(away.skipped).toEqual({ "the person's limit is reached": 1 })
    expect(answer.botUnknown).toBe(1)
    expect(readdirSync(env.CHAT_STATE_DIR).sort()).toEqual(before)
  })

  it("refuses a rule it does not have, naming the ones it has", async () => {
    const { env } = await setUp()

    const { code, stderr } = await replies(["replies", "test", "nope"], env)

    expect(code).not.toBe(0)
    expect(stderr.join("")).toContain("away")
  })
})
