import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { INBOX_CHATS, kindsOf, newIn, reviewIn, unreadIn } from "../../services/inbox.js"
import { momentOf } from "../../services/moment.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { inboxCommand } from "./inbox.js"
import type { MessengerAdapter, ServerReads } from "./port.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 28, 10, minute)).toISOString()

const chatAt = (id: string, minute: number, unreadCount = 0): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount,
  lastMessageAt: at(minute),
  participantsCount: 3,
})

const messageAt = (chatId: string, id: string, minute: number, outgoing = false): Message => ({
  id,
  chatId,
  senderId: outgoing ? "500" : "9",
  senderName: outgoing ? "Owner" : "Olga",
  timestamp: at(minute),
  editedAt: null,
  text: `message ${id}`,
  outgoing,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

/** A messenger whose chats and histories are given; `history` answers each chat's newest `limit`. */
const messengerWith = (chats: Chat[], histories: Record<string, Message[]>) => {
  const read: string[] = []
  const adapter: MessengerAdapter & ServerReads = {
    self: () => "500",
    me: async () => ({ id: "500", name: "Owner", username: null }),
    chats: async ({ limit, offset }) => ({
      items: chats.slice(offset, limit === undefined ? undefined : offset + limit),
      hasMore: limit !== undefined && chats.length > offset + limit,
    }),
    history: async (chat, { limit }) => {
      read.push(chat)
      return { items: (histories[chat] ?? []).slice(-limit), hasMore: false }
    },
    resolve: async () => chats[0] as Chat,
    chat: async () => ({ ...(chats[0] as Chat), members: [] }),
    contact: async () => ({ id: "9", name: null, username: null, description: null, lastMessagedAt: null, chats: [] }),
    around: async () => [],
    send: async () => {
      throw new Error("inbox never sends")
    },
    logout: async () => {},
    close: async () => {},
  }
  return { adapter, read }
}

describe("the unread inbox", () => {
  it("reads each chat's unread messages, newest chats first, and leaves out the owner's own", async () => {
    const { adapter } = messengerWith([chatAt("1", 5, 2), chatAt("2", 9, 1), chatAt("3", 8, 0)], {
      "1": [messageAt("1", "10", 1), messageAt("1", "11", 4, true), messageAt("1", "12", 5)],
      "2": [messageAt("2", "20", 9)],
    })

    const inbox = await unreadIn(adapter, { limit: 20 })

    expect(inbox.chats.map((chat) => [chat.id, chat.messages.map((one) => one.id)])).toEqual([
      ["2", ["20"]],
      ["1", ["12"]],
    ])
  })

  it(`reads at most ${INBOX_CHATS} chats, and names the rest`, async () => {
    const chats = Array.from({ length: INBOX_CHATS + 2 }, (_, index) => chatAt(String(index), 59 - index, 1))
    const histories = Object.fromEntries(chats.map((chat) => [chat.id, [messageAt(chat.id, "1", 1)]]))
    const { adapter, read } = messengerWith(chats, histories)

    const inbox = await unreadIn(adapter, { limit: 20 })

    expect(read).toHaveLength(INBOX_CHATS)
    expect(inbox.skipped.map((chat) => chat.id)).toEqual([String(INBOX_CHATS), String(INBOX_CHATS + 1)])
  })

  it("keeps only the kinds asked for, before the cap, so a busy kind does not crowd out another", async () => {
    const groups = Array.from({ length: INBOX_CHATS + 2 }, (_, index) => chatAt(String(index), 59 - index, 1))
    const channel = { ...chatAt("c", 0, 1), kind: "channel" as const }
    const chats = [...groups, channel]
    const histories = Object.fromEntries(chats.map((chat) => [chat.id, [messageAt(chat.id, "1", 0)]]))
    const { adapter, read } = messengerWith(chats, histories)

    const inbox = await unreadIn(adapter, { limit: 20, kinds: ["channel"] })

    expect(read).toEqual(["c"])
    expect(inbox.skipped).toEqual([])
  })

  it("leaves out muted and archived chats unless they mention the owner, and counts them", async () => {
    const chats = [
      { ...chatAt("1", 5, 1), muted: true },
      { ...chatAt("2", 4, 1), archived: true },
      { ...chatAt("3", 3, 1), muted: true, unreadMentions: 1 },
      { ...chatAt("4", 2, 1), muted: false },
    ]
    const histories = Object.fromEntries(chats.map((chat) => [chat.id, [messageAt(chat.id, "1", 1)]]))
    const { adapter, read } = messengerWith(chats, histories)

    const inbox = await unreadIn(adapter, { limit: 20 })

    expect(read).toEqual(["3", "4"])
    expect(inbox.quiet).toBe(2)
    expect((await unreadIn(adapter, { limit: 20, all: true })).chats).toHaveLength(4)
  })
})

describe("what is new since a moment", () => {
  it("cuts at the chat list's newest message, so a message arriving during the reads waits for the next run", async () => {
    const histories = {
      "1": [messageAt("1", "10", 3)],
      // Arrived after the chat list was taken: newer than any chat's last message in it.
      "2": [messageAt("2", "20", 5), messageAt("2", "21", 7)],
    }
    const { adapter } = messengerWith([chatAt("1", 3), chatAt("2", 5)], histories)

    const inbox = await newIn(adapter, { since: Date.parse(at(2)), limit: 20 })

    expect(inbox.chats.flatMap((chat) => chat.messages.map((one) => one.id))).toEqual(["20", "10"])
    expect(inbox.until).toBe(at(5))
  })

  it("reads no chat whose last message is older than the moment", async () => {
    const { adapter, read } = messengerWith([chatAt("1", 3), chatAt("2", 1)], { "1": [messageAt("1", "10", 3)] })

    await newIn(adapter, { since: Date.parse(at(2)), limit: 20 })

    expect(read).toEqual(["1"])
  })

  it("leaves out a muted chat that changed, unless all", async () => {
    const histories = { "1": [messageAt("1", "10", 3)], "2": [messageAt("2", "20", 4)] }
    const { adapter } = messengerWith([chatAt("1", 3), { ...chatAt("2", 4), muted: true }], histories)

    const quietly = await newIn(adapter, { since: Date.parse(at(2)), limit: 20 })
    const everything = await newIn(adapter, { since: Date.parse(at(2)), limit: 20, all: true })

    expect(quietly.chats.map((chat) => chat.id)).toEqual(["1"])
    expect(quietly.quiet).toBe(1)
    expect(everything.chats.map((chat) => chat.id)).toEqual(["2", "1"])
  })
})

describe("a point per chat", () => {
  it("starts each chat from its own point, and from since where it has none", async () => {
    const histories = { "1": [messageAt("1", "10", 3), messageAt("1", "11", 6)], "2": [messageAt("2", "20", 4)] }
    const { adapter } = messengerWith([chatAt("1", 6), chatAt("2", 4)], histories)

    const inbox = await newIn(adapter, {
      since: Date.parse(at(2)),
      points: new Map([["1", Date.parse(at(5))]]),
      limit: 20,
    })

    expect(inbox.chats.map((chat) => [chat.id, chat.messages.map((one) => one.id)])).toEqual([
      ["1", ["11"]],
      ["2", ["20"]],
    ])
    expect(inbox.checked).toEqual({ "1": at(6), "2": at(6) })
  })

  it("checks only the chats it read: other kinds and chats past the cap keep their point", async () => {
    const histories = { g: [messageAt("g", "1", 4)], c: [messageAt("c", "2", 5)] }
    const { adapter } = messengerWith([chatAt("g", 4), { ...chatAt("c", 5), kind: "channel" }], histories)

    const inbox = await newIn(adapter, { since: Date.parse(at(2)), limit: 20, kinds: ["channel"] })

    expect(inbox.checked).toEqual({ c: at(5) })
  })
})

describe("--kind", () => {
  it("takes kinds comma-separated and refuses anything else", () => {
    expect(kindsOf("dialog, group")).toEqual(["dialog", "group"])
    expect(() => kindsOf("groups")).toThrow(/dialog, group, channel, saved/)
    expect(() => kindsOf(",")).toThrow(/--kind/)
  })

  it("narrows a review to those kinds", async () => {
    const histories = { g: [messageAt("g", "1", 4)], c: [messageAt("c", "2", 5)] }
    const { adapter, read } = messengerWith([chatAt("g", 4), { ...chatAt("c", 5), kind: "channel" }], histories)

    const review = await reviewIn(adapter, { since: Date.parse(at(2)), kinds: ["group"] })

    expect(review.chats.map((chat) => chat.id)).toEqual(["g"])
    expect(read).toEqual(["g"])
  })
})

describe("--since", () => {
  it("takes an ISO time or 30m, 2h, 1d ago, and refuses a message id", () => {
    const now = Date.parse("2026-09-28T12:00:00Z")
    expect(momentOf("2026-09-28T10:00:00Z", "--since", now)).toBe(Date.parse("2026-09-28T10:00:00Z"))
    expect(momentOf("2h", "--since", now)).toBe(Date.parse("2026-09-28T10:00:00Z"))
    expect(momentOf("1d", "--since", now)).toBe(Date.parse("2026-09-27T12:00:00Z"))
    expect(() => momentOf("12345")).toThrow(/ISO 8601/)
  })
})

describe("inbox --new", () => {
  const setup = (histories: Record<string, Message[]>, chats: Chat[]) => {
    const root = mkdtempSync(join(tmpdir(), "inbox-"))
    const env = {
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const scripted = messengerWith(chats, histories)
    let failing = false
    const messenger: Messenger = {
      app,
      provider: "chat",
      resolveSettings: settingsFor(app).resolveSettings,
      connect: async () =>
        failing
          ? {
              ...scripted.adapter,
              history: async () => {
                throw new Error("the connection dropped")
              },
            }
          : scripted.adapter,
      chatArgument: "a chat",
    }
    const inbox = async (argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        ["inbox", ...argv, "--json"],
        { app, commands: () => [inboxCommand(messenger)] },
        {
          streams,
          tty: false,
          env,
        },
      )
      return { code, answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined }
    }
    const pointFile = join(env.CHAT_STATE_DIR, "inbox", "default.json")
    return {
      inbox,
      fail: (on: boolean) => {
        failing = on
      },
      saved: () => JSON.parse(readFileSync(pointFile, "utf8")),
      save: (points: unknown) => {
        mkdirSync(join(env.CHAT_STATE_DIR, "inbox"), { recursive: true })
        writeFileSync(pointFile, JSON.stringify(points))
      },
    }
  }

  const startedAt = Date.now()
  const minutesAgo = (minutes: number) => new Date(startedAt - minutes * 60_000).toISOString()
  const recentChat = (id: string, minutes: number, kind: Chat["kind"] = "group"): Chat => ({
    ...chatAt(id, 0),
    kind,
    lastMessageAt: minutesAgo(minutes),
  })
  const recentMessage = (chat: string, minutes: number): Message => ({
    ...messageAt(chat, `${chat}-1`, 0),
    timestamp: minutesAgo(minutes),
  })

  it("shows each message once: a second run starts where the first one printed up to", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    const chat = { ...chatAt("1", 0), lastMessageAt: recent }
    const { inbox } = setup({ "1": [{ ...messageAt("1", "10", 0), timestamp: recent }] }, [chat])

    const first = await inbox(["--new"])
    const second = await inbox(["--new"])

    expect(first.answer.chats.map((one: { id: string }) => one.id)).toEqual(["1"])
    expect(second.answer.chats).toEqual([])
    expect(second.answer.since).toBe(recent)
  })

  it(`loses nothing past the first ${INBOX_CHATS} chats: the next run shows the ones skipped`, async () => {
    const chats = Array.from({ length: INBOX_CHATS + 2 }, (_, index) => recentChat(`c${index}`, index + 1))
    const histories = Object.fromEntries(chats.map((chat, index) => [chat.id, [recentMessage(chat.id, index + 1)]]))
    const { inbox } = setup(histories, chats)

    const first = await inbox(["--new"])
    const second = await inbox(["--new"])

    expect(first.answer.chats).toHaveLength(INBOX_CHATS)
    expect(second.answer.chats.map((one: { id: string }) => one.id)).toEqual([`c${INBOX_CHATS}`, `c${INBOX_CHATS + 1}`])
  })

  it("a channels-only run leaves the groups for the next run", async () => {
    const chats = [recentChat("g", 2), recentChat("c", 1, "channel")]
    const { inbox } = setup({ g: [recentMessage("g", 2)], c: [recentMessage("c", 1)] }, chats)

    const channels = await inbox(["--new", "--kind", "channel"])
    const groups = await inbox(["--new", "--kind", "group"])

    expect(channels.answer.chats.map((one: { id: string }) => one.id)).toEqual(["c"])
    expect(groups.answer.chats.map((one: { id: string }) => one.id)).toEqual(["g"])
  })

  it("reads the single point older versions kept, and keeps it as where unread chats start", async () => {
    const point = minutesAgo(10)
    const { inbox, save, saved } = setup({ g: [recentMessage("g", 5)] }, [recentChat("g", 5)])
    save({ lastCheckAt: point })

    const { answer } = await inbox(["--new"])

    expect(answer.since).toBe(point)
    expect(saved()).toEqual({ lastCheckAt: point, chats: { g: answer.until } })
  })

  it("--all takes in muted and archived chats", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    const chat = { ...chatAt("1", 0), lastMessageAt: recent, archived: true }
    const { inbox } = setup({ "1": [{ ...messageAt("1", "10", 0), timestamp: recent }] }, [chat])

    expect((await inbox(["--since-time", "1d"])).answer.chats).toEqual([])
    expect((await inbox(["--since-time", "1d", "--all"])).answer.chats).toHaveLength(1)
  })

  it("looks back 24 hours the first time", async () => {
    const { inbox } = setup({}, [])

    const { answer } = await inbox(["--new"])

    expect(Date.now() - Date.parse(answer.since)).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5000)
  })

  it("leaves the saved point alone after a run that failed, or one given --since", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    const chat = { ...chatAt("1", 0), lastMessageAt: recent }
    const { inbox, fail } = setup({ "1": [{ ...messageAt("1", "10", 0), timestamp: recent }] }, [chat])

    fail(true)
    expect((await inbox(["--new"])).code).not.toBe(0)
    fail(false)
    expect((await inbox(["--new", "--since-time", "1d"])).answer.chats).toHaveLength(1)
    const { answer } = await inbox(["--new"])

    expect(answer.chats.map((one: { id: string }) => one.id)).toEqual(["1"])
  })
})
