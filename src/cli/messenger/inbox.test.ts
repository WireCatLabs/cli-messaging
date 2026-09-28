import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { INBOX_CHATS, inboxCommand, momentOf, newIn, unreadIn } from "./inbox.js"
import type { MessengerAdapter } from "./port.js"

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
  const adapter: MessengerAdapter = {
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
    return {
      inbox,
      fail: (on: boolean) => {
        failing = on
      },
    }
  }

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
    expect((await inbox(["--new", "--since", "1d"])).answer.chats).toHaveLength(1)
    const { answer } = await inbox(["--new"])

    expect(answer.chats.map((one: { id: string }) => one.id)).toEqual(["1"])
  })
})
