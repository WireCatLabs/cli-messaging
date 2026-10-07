import { describe, expect, it } from "vitest"
import { RANKING_GRAPH_LIMITS, type RankingGraphNode, rankingGraphEvidence, rankReplyGraph } from "./rankings-graph.js"

const account = { provider: "fixture", account: "owner" }
const node = (pk: number, extra: Partial<RankingGraphNode> = {}): RankingGraphNode => ({
  pk,
  account,
  chatId: "room",
  id: String(pk),
  chatKind: "group",
  sender: String(pk),
  timestamp: pk * 1000,
  text: "Synthetic fixture",
  event: true,
  selected: true,
  graph: { version: 1, reply: null },
  ...extra,
})
const reply = (pk: number, parent: number, extra: Partial<RankingGraphNode> = {}) =>
  node(pk, { graph: { version: 1, reply: { chatId: "room", messageId: String(parent) } }, ...extra })

describe("a bounded reply graph", () => {
  it("counts direct and descendant replies without requiring parents to appear first", () => {
    const found = rankReplyGraph([reply(3, 2), reply(2, 1), node(1)])
    expect(found.rows.get(1)).toMatchObject({ replies: 1, descendants: 2, thread: 1, kind: "posts" })
    expect(found.rows.get(2)).toMatchObject({ replies: 1, descendants: 1, thread: 0, kind: "comments" })
    expect(found.rows.get(3)?.kind).toBe("comments")
    expect(found.quality.complete).toBe(true)
  })
  it("excludes self answers and credits only the first other human reply, before the selected-set filter", () => {
    const question = node(1, { text: "Synthetic question?", selected: false })
    const found = rankReplyGraph([
      question,
      reply(2, 1, { sender: "1" }),
      reply(3, 1, { selected: false }),
      reply(4, 1),
    ])
    expect(found.rows.get(1)).toMatchObject({ replies: 3, selfReplies: 1, otherReplies: 2 })
    expect(found.rows.get(2)?.answerFor).toBeNull()
    expect(found.rows.get(3)?.answerFor).toBeNull()
    expect(found.rows.get(4)?.answerFor).toBeNull()
    const credited = rankReplyGraph([question, reply(3, 1), reply(4, 1)])
    expect(credited.rows.get(3)).toMatchObject({ answerFor: 1, answerDelay: 2000 })
  })
  it("uses canonical keys to resolve equal-time answers and rejects negative delays", () => {
    const found = rankReplyGraph([
      node(1, { text: "Question?" }),
      reply(3, 1, { timestamp: 2000 }),
      reply(2, 1, { timestamp: 2000 }),
      reply(4, 1, { timestamp: 0 }),
    ])
    expect(found.rows.get(2)?.answerFor).toBe(1)
    expect(found.rows.get(3)?.answerFor).toBeNull()
    expect(found.rows.get(4)?.answerFor).toBeNull()
  })
  it("does not count URL question marks or questions outside the event period", () => {
    expect(
      rankReplyGraph([node(1, { text: "https://example.test/a?x=1" }), reply(2, 1)]).rows.get(2)?.answerFor,
    ).toBeNull()
    expect(
      rankReplyGraph([node(1, { text: "Question?", event: false }), reply(2, 1)]).rows.get(2)?.answerFor,
    ).toBeNull()
  })
  it("joins an explicit discussion bridge to its channel without counting the forwarded copy", () => {
    const post = node(1, {
      chatId: "channel",
      chatKind: "channel",
      sender: "channel",
      senderIsChat: true,
      graph: { version: 1, reply: null, discussionChatId: "room" },
    })
    const bridge = node(2, {
      graph: { version: 1, reply: null, discussionSource: { chatId: "channel", messageId: "1" } },
    })
    const found = rankReplyGraph([post, bridge, reply(3, 2)])
    expect(found.rows.get(1)).toMatchObject({ replies: 1, otherReplies: 1, descendants: 1 })
    expect(found.rows.get(2)).toMatchObject({ kind: "bridge", replies: 0, descendants: 0 })
    expect(found.rows.get(3)).toMatchObject({ kind: "comments", answerFor: null })
  })
  it("refuses to infer a channel link from an ordinary forward or an unmatched discussion group", () => {
    const post = node(1, {
      chatId: "channel",
      chatKind: "channel",
      graph: { version: 1, reply: null, discussionChatId: "another-room" },
    })
    const bridge = node(2, {
      graph: { version: 1, reply: null, discussionSource: { chatId: "channel", messageId: "1" } },
    })
    const found = rankReplyGraph([post, bridge, reply(3, 2)])
    expect(found.rows.get(1)?.replies).toBe(0)
    expect(found.rows.get(3)?.kind).toBeNull()
    expect(found.quality.missingParents).toBe(1)
    const ordinary = rankReplyGraph([post, node(2), reply(3, 2)])
    expect(ordinary.rows.get(1)?.replies).toBe(0)
    expect(ordinary.rows.get(2)?.replies).toBe(1)
  })
  it("isolates repeated message ids across providers, accounts and chats", () => {
    const found = rankReplyGraph([
      node(1, { id: "same" }),
      node(2, { id: "same", account: { ...account, account: "other" } }),
      node(3, { id: "same", account: { ...account, provider: "other" } }),
      node(4, { id: "same", chatId: "other" }),
      node(5, { graph: { version: 1, reply: { chatId: "room", messageId: "same" } } }),
    ])
    expect(found.rows.get(1)?.replies).toBe(1)
    for (const pk of [2, 3, 4]) expect(found.rows.get(pk)?.replies).toBe(0)
  })
  it("distinguishes people from chats even when their native ids match", () => {
    const found = rankReplyGraph([
      node(1, { sender: "same", senderIsChat: true, chatKind: "channel", text: "Question?" }),
      reply(2, 1, { sender: "same" }),
    ])
    expect(found.rows.get(1)).toMatchObject({ selfReplies: 0, otherReplies: 1 })
    expect(found.rows.get(2)?.answerFor).toBeNull()
  })
  it("guards cycles without counting a node as its own descendant", () => {
    const found = rankReplyGraph([reply(1, 2), reply(2, 1), reply(3, 3)])
    expect(found.rows.get(1)).toMatchObject({ descendants: 1, thread: 0, kind: null })
    expect(found.rows.get(2)?.descendants).toBe(1)
    expect(found.rows.get(3)?.descendants).toBe(0)
    expect(found.quality.cycles).toBe(3)
    expect(found.quality.complete).toBe(false)
  })
  it("keeps absent linkage and unknown authors visible instead of guessing", () => {
    const found = rankReplyGraph([node(1, { graph: undefined }), reply(2, 1, { sender: null }), reply(3, 99)])
    expect(found.rows.get(1)).toMatchObject({ kind: null, replies: 1, otherReplies: 0 })
    expect(found.quality).toMatchObject({ unknownLinks: 1, unknownAuthors: 1, missingParents: 1, complete: false })
  })
  it("fails closed on graph size, depth, bytes and cancellation", () => {
    expect(() => rankReplyGraph(Array(RANKING_GRAPH_LIMITS.nodes + 1).fill(node(1)))).toThrow("nodes")
    expect(() => rankReplyGraph(Array.from({ length: 258 }, (_, i) => (i === 0 ? node(i) : reply(i, i - 1))))).toThrow(
      "depth",
    )
    expect(() => rankReplyGraph([node(1, { text: "é".repeat(RANKING_GRAPH_LIMITS.bytes / 2 + 1) })])).toThrow("bytes")
    expect(() =>
      rankReplyGraph([node(1)], () => {
        throw new Error("fixture abort")
      }),
    ).toThrow("fixture abort")
    expect(() => rankReplyGraph([node(1), node(1)])).toThrow("duplicate")
  })
  it("accepts only versioned, well-formed linkage", () => {
    expect(rankingGraphEvidence({ version: 1, reply: null })).toEqual({ version: 1, reply: null })
    expect(rankingGraphEvidence({ version: 2, reply: null })).toBeUndefined()
    expect(rankingGraphEvidence(null)).toBeUndefined()
    expect(
      rankingGraphEvidence({
        version: 1,
        reply: { chatId: 1, messageId: "2" },
        discussionSource: { chatId: "room", messageId: "x" },
        discussionChatId: "room",
      }),
    ).toEqual({ version: 1, discussionSource: { chatId: "room", messageId: "x" }, discussionChatId: "room" })
  })
})
