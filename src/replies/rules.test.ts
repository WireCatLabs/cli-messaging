import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  audienceWarnings,
  defaultRule,
  outsideAudience,
  parseReplies,
  parseReplyRules,
  readReplyRules,
} from "./rules.js"

const valid = () => ({
  ...defaultRule("after-hours"),
  reply: { template: "Thanks, {firstName}", model: "fill-only", asReply: true },
})

const refusal = (rules: unknown[]): string => {
  try {
    parseReplyRules({ rules }, "replies.json")
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("expected a refusal")
}

describe("reply rules", () => {
  it("reads a rule with every key written out, windows, days and limits turned into numbers", () => {
    const [rule] = parseReplyRules(
      {
        rules: [
          {
            ...valid(),
            when: { ...valid().when, hours: { outside: "22:00-02:00", days: "fri-mon", timezone: "Europe/Madrid" } },
            limits: { perChat: "1/12h", perPerson: "2/30m" },
          },
        ],
      },
      "replies.json",
    )

    expect(rule?.when.hours).toEqual({
      outside: { from: 22 * 60, to: 2 * 60 },
      days: ["mon", "fri", "sat", "sun"],
      timezone: "Europe/Madrid",
    })
    expect(rule?.limits).toEqual({ perChat: { count: 1, ms: 12 * 3_600_000 }, perPerson: { count: 2, ms: 1_800_000 } })
  })

  it("no file is no rules", () => {
    expect(readReplyRules(join(mkdtempSync(join(tmpdir(), "replies-")), "none.json"))).toEqual([])
  })

  it.each([
    [
      "a typo in a field",
      { ...valid(), when: { ...valid().when, wrods: [] } },
      "rules.0.when.wrods is not a field a rule has",
    ],
    ["a missing field", { ...valid(), limits: undefined }, "rules.0.limits is missing"],
    [
      "an unlimited limit",
      { ...valid(), limits: { perChat: "unlimited", perPerson: "1/1d" } },
      'a limit is written "1/12h"',
    ],
    ["a zero limit", { ...valid(), limits: { perChat: "0/1d", perPerson: "1/1d" } }, "rules.0.limits.perChat"],
    [
      "a bad window",
      { ...valid(), when: { ...valid().when, hours: { outside: "9-19", days: "mon-fri", timezone: "UTC" } } },
      '"09:00-19:00"',
    ],
    [
      "a bad day",
      { ...valid(), when: { ...valid().when, hours: { outside: "09:00-19:00", days: "mon-fry", timezone: "UTC" } } },
      'days are written "mon-fri"',
    ],
    [
      "an unknown time zone",
      {
        ...valid(),
        when: { ...valid().when, hours: { outside: "09:00-19:00", days: "mon", timezone: "Mars/Olympus" } },
      },
      "time zone",
    ],
    ["a channel", { ...valid(), where: { ...valid().where, kinds: ["channel"] } }, "rules.0.where.kinds.0"],
    [
      "an unknown placeholder",
      { ...valid(), reply: { ...valid().reply, template: "Hi {phone}" } },
      "{firstName}, {name}",
    ],
    ["a model that writes freely", { ...valid(), reply: { ...valid().reply, model: "free" } }, "rules.0.reply.model"],
  ])("refuses %s, naming it", (_, rule, words) => {
    expect(refusal([rule])).toContain(words)
  })

  it("refuses two rules with one id", () => {
    expect(refusal([valid(), valid()])).toContain("two rules share an id")
  })

  it("refuses a file that is not JSON, naming the file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "replies-")), "replies.json")
    writeFileSync(path, "{ rules: ")
    expect(() => readReplyRules(path)).toThrow(`the reply rules ${path} cannot be read`)
  })
})

describe("who may be answered", () => {
  const audienceOf = (audience: unknown) => parseReplies({ audience, rules: [] }, "replies.json").audience

  it("answers everyone by default, and never the deny list", () => {
    const open = audienceOf(undefined)
    const denied = audienceOf({ deny: { people: ["p1"], chats: ["c9"] } })

    expect(outsideAudience(open, "p1", "c1")).toBeNull()
    expect(outsideAudience(denied, "p1", "c1")).toBe("a person on the deny list")
    expect(outsideAudience(denied, "p2", "c9")).toBe("a chat on the deny list")
    expect(outsideAudience(denied, "p2", "c1")).toBeNull()
  })

  it("answers only the allow list when listed, and deny wins over allow", () => {
    const listed = audienceOf({
      reply: "listed",
      allow: { people: ["p1", "p2"], chats: ["g1"] },
      deny: { people: ["p2"] },
    })

    expect(outsideAudience(listed, "p1", "c1")).toBeNull()
    expect(outsideAudience(listed, "p3", "g1")).toBeNull()
    expect(outsideAudience(listed, "p3", "c1")).toBe("not on the allow list")
    expect(outsideAudience(listed, "p2", "g1")).toBe("a person on the deny list")
  })

  it("warns about what does not do what it seems to, and refuses an unknown mode", () => {
    expect(
      audienceWarnings(
        audienceOf({
          reply: "listed",
          allow: { people: ["p2"], chats: ["g1"] },
          deny: { people: ["p2"], chats: ["g1"] },
        }),
      ),
    ).toEqual([
      "person p2 is on both lists: deny wins, nobody answers them",
      "chat g1 is on both lists: deny wins, nothing is answered there",
    ])
    expect(audienceWarnings(audienceOf({ allow: { people: ["p1"] } }))).toEqual([
      'the allow list does nothing while audience.reply is "all" — set it to "listed" to answer only those',
    ])
    expect(audienceWarnings(audienceOf({ reply: "listed" }))).toEqual([
      'audience.reply is "listed" and the allow list is empty: nobody is answered',
    ])
    expect(audienceWarnings(audienceOf(undefined))).toEqual([])
    expect(() => audienceOf({ reply: "some" })).toThrow(/audience\.reply/)
  })
})
