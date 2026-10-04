import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { defaultRule, parseReplyRules, type ReplyRule } from "./rules.js"
import {
  ANSWERED_KEPT,
  emptyState,
  paused,
  readRepliesState,
  recordReply,
  repliesStatePathFor,
  writeRepliesState,
} from "./state.js"

const fileIn = () => join(mkdtempSync(join(tmpdir(), "replies-state-")), "state.json")
const [rule] = parseReplyRules(
  { rules: [{ ...defaultRule("r"), reply: { template: "ok", model: "fill-only", asReply: false } }] },
  "replies.json",
) as [ReplyRule]
const message = (id: string, chatId = "c1", senderId: string | null = "p1") => ({ id, chatId, senderId })

describe("reply state", () => {
  it("starts empty, and writes and reads back a paused state, owner-only", () => {
    const path = fileIn()
    expect(readRepliesState(path)).toEqual(emptyState())

    writeRepliesState(path, paused(emptyState(), true))

    expect(readRepliesState(path).paused).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("keeps the newest answered ids and drops the oldest", () => {
    const now = Date.parse("2026-10-07T12:00:00Z")
    let state = emptyState()
    for (let at = 0; at < ANSWERED_KEPT + 5; at += 1) state = recordReply(state, rule, message(`m${at}`), now)

    expect(state.answered).toHaveLength(ANSWERED_KEPT)
    expect(state.answered[0]).toBe("c1:m5")
    expect(state.answered.at(-1)).toBe(`c1:m${ANSWERED_KEPT + 4}`)
  })

  it("counts a reply per chat and per person, and drops counts no limit reads any more", () => {
    const now = Date.parse("2026-10-07T12:00:00Z")
    const first = recordReply(emptyState(), rule, message("m1", "c1", "p1"), now)
    const later = recordReply(first, rule, message("m2", "c2", "p2"), now + 2 * 86_400_000)

    expect(first.sent.r).toEqual({
      chats: { c1: [new Date(now).toISOString()] },
      people: { p1: [new Date(now).toISOString()] },
    })
    expect(Object.keys(later.sent.r?.chats ?? {})).toEqual(["c2"])
    expect(Object.keys(later.sent.r?.people ?? {})).toEqual(["p2"])
  })

  it("refuses a state file it cannot read rather than forget what was answered", () => {
    const path = fileIn()
    writeFileSync(path, JSON.stringify({ paused: "yes", answered: [], sent: {} }))
    expect(() => readRepliesState(path)).toThrow("the reply state")
    writeFileSync(path, "not json")
    expect(() => readRepliesState(path)).toThrow("fix or move the file")
  })

  it("lives in the profile's state folder", () => {
    const path = repliesStatePathFor({ appName: "tg", envPrefix: "TG", command: "tg" } as never, "work", {
      TG_STATE_DIR: "/state",
    })
    expect(path.endsWith("work.replies-state.json")).toBe(true)
  })
})
