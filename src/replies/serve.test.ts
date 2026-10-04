import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { defaultRule } from "./rules.js"
import { NOT_ALLOWED, type Replier, replyTo } from "./serve.js"
import { paused, readRepliesState, writeRepliesState } from "./state.js"

const NOW = Date.parse("2026-10-07T18:30:00Z")

const said = (id: string, changes: Partial<Message> = {}): Message => ({
  id,
  chatId: "c1",
  senderId: "tester",
  senderName: "Test Account",
  timestamp: new Date(NOW - 60_000).toISOString(),
  editedAt: null,
  text: "are you there?",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...changes,
})

const setUp = ({ testers = [{ id: "tester" }], allowed = true, perChat = "5/1d" } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "replies-serve-"))
  const rule = {
    ...defaultRule("away"),
    on: true,
    reply: { template: "Thanks, {firstName}.", model: "fill-only", asReply: true },
    limits: { perChat, perPerson: "5/1d" },
  }
  const rulesPath = join(root, "replies.json")
  writeFileSync(rulesPath, JSON.stringify({ testers, rules: [rule] }))
  const sent: { chat: string; text: string; sendId: string; origin: string }[] = []
  let fails = 0
  const deps: Replier = {
    rulesPath,
    statePath: join(root, "state.json"),
    provider: "chat",
    owner: { id: "me" },
    since: NOW - 3_600_000,
    allowed: () => allowed,
    chatOf: async (id) => ({ id, kind: "dialog" }),
    senderOf: async () => ({ isBot: false, isContact: true }),
    send: async (reply) => {
      if (reply.chat !== "c1") throw new Error("never anyone but the test chat")
      if (fails > 0) {
        fails -= 1
        throw new CliError("network_error", "dropped")
      }
      sent.push(reply)
    },
    newSendId: () => `send-${sent.length}`,
    now: () => NOW,
  }
  return { deps, sent, failNext: (times: number) => (fails = times) }
}

describe("serve's reply rules", () => {
  it("**answers a test account once, and nobody else at all**", async () => {
    const { deps, sent } = setUp()

    const stranger = await replyTo(deps, said("1", { senderId: "real-person" }))
    const tester = await replyTo(deps, said("2"))
    const again = await replyTo(deps, said("2"))

    expect(stranger).toEqual({ skip: "not a test account" })
    expect(tester).toEqual({ sent: "away" })
    expect(again).toEqual({ skip: "already answered" })
    expect(sent).toEqual([{ chat: "c1", text: "Thanks, Test.", replyTo: "2", sendId: "send-0", origin: "rule:away" }])
  })

  it("answers nobody when no test account is named", async () => {
    const { deps, sent } = setUp({ testers: [] })

    expect(await replyTo(deps, said("1"))).toEqual({ skip: "not a test account" })
    expect(sent).toEqual([])
  })

  it("sends nothing unless replies.send is allow", async () => {
    const { deps, sent } = setUp({ allowed: false })

    expect(await replyTo(deps, said("1"))).toEqual({ skip: NOT_ALLOWED })
    expect(sent).toEqual([])
  })

  it("stops at once when paused, without a restart", async () => {
    const { deps, sent } = setUp()

    await replyTo(deps, said("1"))
    writeRepliesState(deps.statePath, paused(readRepliesState(deps.statePath), true))
    const after = await replyTo(deps, said("2"))

    expect(after).toEqual({ skip: "replies are paused" })
    expect(sent).toHaveLength(1)
  })

  it("leaves what came in before serve started", async () => {
    const { deps, sent } = setUp()

    const old = await replyTo(deps, said("1", { timestamp: new Date(deps.since - 1).toISOString() }))

    expect(old).toEqual({ skip: "older than the catch-up start" })
    expect(sent).toEqual([])
  })

  it("tries a failed send once more with the same send id", async () => {
    const { deps, sent, failNext } = setUp()
    failNext(1)

    expect(await replyTo(deps, said("1"))).toEqual({ sent: "away" })
    expect(sent.map((one) => one.sendId)).toEqual(["send-0"])
  })

  it("stops two auto-repliers answering each other at the first limit", async () => {
    const { deps, sent } = setUp({ perChat: "1/1h" })

    await replyTo(deps, said("1"))
    const echo = await replyTo(deps, said("2", { text: "Thanks — auto-reply" }))

    expect(echo).toEqual({ skip: "the chat's limit is reached" })
    expect(sent).toHaveLength(1)
  })
})
