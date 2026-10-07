import { describe, expect, it } from "vitest"
import { needsRankingContext, rankingOptions, rankingQuestion, rankingScore, rankingWords } from "./rankings-options.js"

describe("ranking options", () => {
  it("defaults to reactions for messages and counts for authors", () => {
    expect(rankingOptions("messages", {})).toMatchObject({
      measure: "reactions",
      minMessages: 1,
      messageKind: "all",
      weights: null,
    })
    expect(rankingOptions("contacts", {})).toMatchObject({ measure: "messages", order: "descending" })
    expect(rankingOptions("contacts", { measure: "answer-time" }).order).toBe("ascending")
  })
  it("keeps engaging's author threshold and replaces all preset weights", () => {
    expect(rankingOptions("contacts", { score: "engaging" })).toMatchObject({ minMessages: 5 })
    expect(rankingOptions("contacts", { score: "engaging", minMessages: 2, weights: '{"words":1}' })).toMatchObject({
      minMessages: 2,
      weights: { words: 1 },
      components: ["words"],
    })
    expect(rankingOptions("messages", { score: "engaging" }).weights).toEqual({
      reactions: 0.5,
      "replies-from-others": 0.5,
    })
    expect(rankingOptions("contacts", { weights: { words: 2, replies: 0 } })).toMatchObject({
      preset: "custom",
      components: ["words"],
    })
  })
  it.each([
    { measure: "messages" },
    { measure: "reactions", score: "engaging" },
    { measure: "views", weights: { views: 1 } },
    { score: "helpful" },
    { score: "active" },
    { score: "unknown" },
    { messageKind: "unknown" },
    { minMessages: 1 },
  ])("refuses unsupported message combinations: %j", (input) => {
    expect(() => rankingOptions("messages", input)).toThrow()
  })
  it.each([
    null,
    [],
    "broken",
    {},
    { messages: 0 },
    { unknown: 0, messages: 1 },
    { messages: -1 },
    { messages: Infinity },
    { messages: NaN },
    { messages: "1" },
    { "answer-time": 1 },
    { views: 1 },
  ])("rejects invalid author weights: %j", (weights) => {
    expect(() => rankingOptions("contacts", { weights })).toThrow()
  })
  it.each([0, -1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid message thresholds: %s",
    (minMessages) => {
      expect(() => rankingOptions("contacts", { minMessages })).toThrow()
    },
  )
  it("requests context only for positively weighted graph components", () => {
    expect(needsRankingContext(rankingOptions("contacts", { score: "helpful" }))).toBe(true)
    expect(needsRankingContext(rankingOptions("contacts", { score: "active" }))).toBe(false)
    expect(needsRankingContext(rankingOptions("contacts", { weights: { messages: 1, answers: 0 } }))).toBe(false)
  })
})

describe("versioned ranking components", () => {
  it("counts Unicode letter/digit runs and excludes URLs from words and question detection", () => {
    expect(rankingWords("Synthetic пример café 42 🙂 https://example.test/a?x=2")).toBe(4)
    expect(rankingWords("www.example.test/a ftp://example.test/file")).toBe(0)
    expect(rankingQuestion("Read https://example.test/a?x=2")).toBe(false)
    expect(rankingQuestion("Can this synthetic fixture help? https://example.test/a")).toBe(true)
    expect(rankingWords("")).toBe(0)
  })
  it("handles long non-URL scheme-like text without an unbounded regex search", () => {
    const text = "a-".repeat(50_000)
    expect(rankingWords(text)).toBe(50_000)
    expect(rankingQuestion(text)).toBe(false)
  })
  it("reports every normalized score contribution", () => {
    const weights = rankingOptions("contacts", { score: "helpful" }).weights ?? {}
    const result = rankingScore(
      { answers: 2, "replies-from-others": 4, reactions: 0 },
      { answers: 4, "replies-from-others": 4, reactions: 0 },
      weights,
    )
    expect(result).toEqual({
      score: 50,
      normalized: { answers: 0.5, "replies-from-others": 1, reactions: 0 },
      contributions: { answers: 25, "replies-from-others": 25, reactions: 0 },
    })
  })
  it("retains measured zero and excludes unknown positive components", () => {
    expect(rankingScore({ messages: 0 }, { messages: 0 }, { messages: 1 })?.score).toBe(0)
    expect(
      rankingScore({ messages: 10, reactions: null }, { messages: 10, reactions: 20 }, { messages: 1, reactions: 1 }),
    ).toBeNull()
    expect(
      rankingScore({ messages: 10, reactions: null }, { messages: 10 }, { messages: 1, reactions: 0 })?.score,
    ).toBe(100)
    expect(rankingScore({ messages: 10 }, { messages: 5 }, { messages: 1 })).toBeNull()
  })
  it("supports finite extreme weights without overflow", () => {
    expect(
      rankingScore({ messages: 10, words: 2 }, { messages: 10, words: 4 }, { messages: 1e308, words: 1e308 })?.score,
    ).toBe(75)
    expect(rankingScore({}, {}, {})).toBeNull()
  })
})
