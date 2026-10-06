import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { decide, type Incoming } from "./decide.js"
import { defaultRule, parseReplyRules, type ReplyRule } from "./rules.js"
import { emptyState, type RepliesState, recordReply } from "./state.js"

const WEDNESDAY_EVENING = Date.parse("2026-10-07T18:30:00Z")

const ruleWith = (changes: Record<string, unknown> = {}): ReplyRule => {
  const base = defaultRule("after-hours")
  const [rule] = parseReplyRules(
    {
      rules: [
        {
          ...base,
          on: true,
          reply: { template: "Thanks, {firstName} — tomorrow morning.", model: "fill-only", asReply: true },
          ...changes,
          when: { ...base.when, ...(changes.when as object) },
          where: { ...base.where, kinds: ["dialog", "group"], ...(changes.where as object) },
        },
      ],
    },
    "replies.json",
  )
  return rule as ReplyRule
}

const messageWith = (changes: Partial<Message> = {}): Message => ({
  id: "m1",
  chatId: "c1",
  senderId: "p1",
  senderName: "Ana Example",
  timestamp: new Date(WEDNESDAY_EVENING - 60_000).toISOString(),
  editedAt: null,
  text: "hello there",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...changes,
})

const incomingWith = (changes: Omit<Partial<Incoming>, "message"> & { message?: Partial<Message> } = {}): Incoming => ({
  chat: { id: "c1", kind: "dialog" },
  owner: { id: "me", username: "owner" },
  sender: { isBot: false, isContact: true, isTester: true },
  since: WEDNESDAY_EVENING - 3_600_000,
  ...changes,
  message: messageWith(changes.message),
})

const outcome = (rule: ReplyRule, incoming: Incoming, state: RepliesState = emptyState(), now = WEDNESDAY_EVENING) => {
  const decided = decide(rule, incoming, state, now)
  return "skip" in decided ? decided.skip : (decided.reply?.text ?? decided.actions.join("+"))
}

const MADRID = { outside: "09:00-19:00", days: "mon-fri", timezone: "Europe/Madrid" }
const NIGHT_SHIFT = { outside: "22:00-02:00", days: "fri", timezone: "Europe/Madrid" }
const REPLY = "Thanks, Ana — tomorrow morning."

describe("decide", () => {
  it("answers a direct message with the template filled", () => {
    expect(decide(ruleWith(), incomingWith(), emptyState(), WEDNESDAY_EVENING)).toEqual({
      actions: ["reply"],
      reply: { text: REPLY, asReply: true, model: "fill-only" },
    })
  })

  it("opens a task for anyone, but answers only a test account", () => {
    const both = ruleWith({ do: ["reply", "task"] })
    const stranger = incomingWith({ sender: { isBot: false, isContact: true, isTester: false } })

    expect(decide(both, stranger, emptyState(), WEDNESDAY_EVENING)).toEqual({ actions: ["task"], reply: null })
    expect(decide(ruleWith({ do: ["task"] }), incomingWith(), emptyState(), WEDNESDAY_EVENING)).toEqual({
      actions: ["task"],
      reply: null,
    })
    expect(decide(both, incomingWith(), emptyState(), WEDNESDAY_EVENING)).toMatchObject({
      actions: ["reply", "task"],
      reply: { text: REPLY },
    })
  })

  it.each([
    ["your own message", { message: { outgoing: true } }],
    ["the account is not known", { message: { outgoing: null } }],
    ["sent as a chat, not by a person", { message: { senderIsChat: true } }],
    ["sent by a bot", { sender: { isBot: true, isContact: false, isTester: true } }],
    ["not a test account", { sender: { isBot: false, isContact: true, isTester: false } }],
    ["a channel is never answered", { chat: { id: "c1", kind: "channel" as const } }],
    ["a saved is never answered", { chat: { id: "c1", kind: "saved" as const } }],
    ["an edited message", { message: { editedAt: new Date(WEDNESDAY_EVENING).toISOString() } }],
    ["older than the catch-up start", { since: WEDNESDAY_EVENING }],
    [
      "a group message that neither mentions you nor replies to you",
      { chat: { id: "g1", kind: "group" as const }, message: { chatId: "g1" } },
    ],
  ])("never answers: %s", (why, changes) => {
    expect(outcome(ruleWith(), incomingWith(changes))).toBe(why)
  })

  it.each([
    ["an @mention", { text: "@Owner can you look?" }],
    ["a mention by id", { mentions: ["me"] }],
    [
      "a reply to the owner",
      {
        replyTo: {
          id: "m0",
          senderId: "me",
          senderName: null,
          timestamp: null,
          text: "",
          attachments: [],
          outgoing: true,
        },
      },
    ],
  ])("answers in a group on %s", (_, message) => {
    const incoming = incomingWith({ chat: { id: "g1", kind: "group" }, message: { chatId: "g1", ...message } })
    expect(outcome(ruleWith(), incoming)).toBe(REPLY)
  })

  it("answers any message in a group the rule names", () => {
    const incoming = incomingWith({ chat: { id: "g1", kind: "group" }, message: { chatId: "g1" } })
    expect(outcome(ruleWith({ where: { chats: ["g1"] } }), incoming)).toBe(REPLY)
  })

  it.each([
    [
      "Wednesday 10:00 in Madrid is working time",
      MADRID,
      "2026-10-07T08:00:00Z",
      "inside the hours the rule leaves alone",
    ],
    ["Wednesday 20:30 in Madrid is after hours", MADRID, "2026-10-07T18:30:00Z", REPLY],
    ["Saturday is outside mon-fri", MADRID, "2026-10-10T10:00:00Z", REPLY],
    [
      "the same instant is 17:00 in Tokyo",
      { ...MADRID, timezone: "Asia/Tokyo" },
      "2026-10-07T08:00:00Z",
      "inside the hours the rule leaves alone",
    ],
    ["and 04:00 in New York", { ...MADRID, timezone: "America/New_York" }, "2026-10-07T08:00:00Z", REPLY],
    [
      "Friday 23:00 is inside a window across midnight",
      NIGHT_SHIFT,
      "2026-10-09T21:00:00Z",
      "inside the hours the rule leaves alone",
    ],
    [
      "so is Saturday 01:00, the window started Friday",
      NIGHT_SHIFT,
      "2026-10-09T23:00:00Z",
      "inside the hours the rule leaves alone",
    ],
    ["Saturday 03:00 is past it", NIGHT_SHIFT, "2026-10-10T01:00:00Z", REPLY],
    ["Thursday 23:00 is not a Friday window", NIGHT_SHIFT, "2026-10-08T21:00:00Z", REPLY],
  ])("hours: %s", (_, hours, at, expected) => {
    const now = Date.parse(at)
    const incoming = incomingWith({
      since: now - 3_600_000,
      message: { timestamp: new Date(now - 60_000).toISOString() },
    })
    expect(outcome(ruleWith({ when: { hours } }), incoming, emptyState(), now)).toBe(expected)
  })

  it.each([
    ["price", "What is the PRICE?", REPLY],
    ["price", "prices went up", "none of the rule's words"],
    ["цена", "Какая Цена?", REPLY],
    ["цена", "ценами", "none of the rule's words"],
    ["how much", "so, how much is it", REPLY],
  ])("words: %s in %j", (word, text, expected) => {
    expect(outcome(ruleWith({ when: { words: [word] } }), incomingWith({ message: { text } }))).toBe(expected)
  })

  it.each([
    [{ question: true }, { text: "see https://x.example/?a=1" }, "not a question"],
    [{ question: true }, { text: "free tomorrow?" }, REPLY],
    [{ mentionsMe: true }, {}, "does not mention you or reply to you"],
    [{ from: { people: ["p2"], notPeople: [], contactsOnly: false } }, {}, "not from the rule's people"],
    [{ from: { people: [], notPeople: ["p1"], contactsOnly: false } }, {}, "from a person the rule leaves out"],
  ])("conditions: %j", (when, message, expected) => {
    expect(outcome(ruleWith({ when }), incomingWith({ message }))).toBe(expected)
  })

  it("contactsOnly leaves out a stranger", () => {
    const rule = ruleWith({ when: { from: { people: [], notPeople: [], contactsOnly: true } } })
    expect(outcome(rule, incomingWith({ sender: { isBot: false, isContact: false, isTester: true } }))).toBe(
      "not from a contact",
    )
  })

  it.each([
    [{ where: { kinds: ["group"] } }, "the rule does not answer a dialog"],
    [{ where: { chats: ["c9"] } }, "not one of the rule's chats"],
    [{ where: { notChats: ["c1"] } }, "one of the chats the rule leaves out"],
    [{ on: false }, "the rule is off"],
  ])("where and on: %j", (changes, expected) => {
    expect(outcome(ruleWith(changes), incomingWith())).toBe(expected)
  })

  it("does not answer a message twice, nor while paused", () => {
    const rule = ruleWith()
    const replied = recordReply(emptyState(), rule, messageWith(), WEDNESDAY_EVENING)
    expect(outcome(rule, incomingWith(), replied)).toBe("already answered")
    expect(outcome(rule, incomingWith(), { ...emptyState(), paused: true })).toBe("replies are paused")
  })

  it("a second message from the person inside perPerson gets nothing, and one after it does", () => {
    const rule = ruleWith({ limits: { perChat: "5/1h", perPerson: "1/1d" } })
    const replied = recordReply(emptyState(), rule, messageWith(), WEDNESDAY_EVENING)
    const next = incomingWith({ message: { id: "m2" } })
    expect(outcome(rule, next, replied, WEDNESDAY_EVENING + 3_600_000)).toBe("the person's limit is reached")
    const nextDay = WEDNESDAY_EVENING + 86_400_000
    expect(
      outcome(
        rule,
        {
          ...next,
          since: nextDay - 120_000,
          message: { ...next.message, timestamp: new Date(nextDay - 60_000).toISOString() },
        },
        replied,
        nextDay,
      ),
    ).toBe(REPLY)
  })

  it("two auto-repliers answering each other stop at the chat's limit", () => {
    const rule = ruleWith({ limits: { perChat: "1/12h", perPerson: "10/1h" } })
    let state = emptyState()
    const answered: string[] = []
    for (let turn = 0; turn < 5; turn += 1) {
      const now = WEDNESDAY_EVENING + turn * 60_000
      const incoming = incomingWith({ message: { id: `m${turn}`, timestamp: new Date(now - 1000).toISOString() } })
      const decided = decide(rule, incoming, state, now)
      if ("reply" in decided) {
        answered.push(incoming.message.id)
        state = recordReply(state, rule, incoming.message, now)
      }
    }
    expect(answered).toEqual(["m0"])
  })

  it("skips a template that needs a name the sender has not given", () => {
    expect(outcome(ruleWith(), incomingWith({ message: { senderName: null } }))).toBe(
      "the template needs a name the sender has not given",
    )
  })
})
