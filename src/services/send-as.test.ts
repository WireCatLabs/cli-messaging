import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { Chat, SenderIdentity } from "../domain/models.js"
import type { GuardRequest, SendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { chatsService } from "./chats.js"
import { onlineDeps } from "./deps.js"
import { messagesService } from "./messages.js"

const messenger = { provider: "test", chatArgument: "a chat" } as Messenger
const chat: Chat = {
  id: "-1007",
  title: "Synthetic group",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
}
const identities: SenderIdentity[] = [
  { id: "500", title: "Owner", kind: "self", premiumRequired: false, default: false },
  { id: "-1002", title: "Synthetic channel", kind: "channel", premiumRequired: false, default: true },
]

const setup = (options: { capable?: boolean } = {}) => {
  const journal: Omit<SendEntry, "at" | "profile">[] = []
  const checked: GuardRequest[] = []
  const guard = {
    check: (request: GuardRequest) => checked.push(request),
    record: (entry: Omit<SendEntry, "at" | "profile">) => journal.push(entry),
  } as unknown as SendGuard
  const sendAsIdentities = vi.fn(async () => identities)
  const resolve = vi.fn(async () => chat)
  const send = vi.fn(async (chatId: string, text: string, sent: { sendId: string }) => ({
    sendId: sent.sendId,
    message: { id: "4", chatId, text } as never,
  }))
  const adapter = {
    self: () => "500",
    resolve,
    send,
    validateThread: async () => {},
    ...(options.capable === false ? {} : { sendAsIdentities }),
  } as unknown as MessengerAdapter
  const deps = onlineDeps(messenger, adapter, guard)
  return { deps, journal, checked, sendAsIdentities, resolve, send }
}

describe("listing sender identities", () => {
  it("asks the adapter with the resolved chat id", async () => {
    const { deps, sendAsIdentities } = setup()
    expect(await chatsService(deps).sendAs("Synthetic group")).toEqual(identities)
    expect(sendAsIdentities).toHaveBeenCalledWith("-1007")
  })

  it("refuses offline and a messenger without the capability", async () => {
    const offline = setup()
    const connection = vi.fn(offline.deps.connection)
    await expect(chatsService({ ...offline.deps, offline: true, connection }).sendAs("x")).rejects.toThrow(
      "not with --offline",
    )
    expect(connection).not.toHaveBeenCalled()
    const lacking = setup({ capable: false })
    await expect(chatsService(lacking.deps).sendAs("x")).rejects.toThrow("cannot send as another identity")
    expect(lacking.resolve).not.toHaveBeenCalled()
  })
})

describe("sending as an identity", () => {
  it("passes the identity to the adapter and the journal", async () => {
    const { deps, send, journal, checked } = setup()
    await messagesService(deps).send({ chat: "Synthetic group", text: "hello", sendAs: "-1002", threadId: "3" })
    expect(send).toHaveBeenCalledWith("-1007", "hello", expect.objectContaining({ sendAs: "-1002" }))
    expect(checked[0]).toMatchObject({ sendAs: "-1002" })
    expect(journal).toEqual([expect.objectContaining({ outcome: "sent", sendAs: "-1002" })])
  })

  it("refuses an id the chat does not offer, before the guard", async () => {
    const { deps, send, checked } = setup()
    await expect(messagesService(deps).send({ chat: "x", text: "hello", sendAs: "-1099" })).rejects.toThrow(
      "not an identity this account may post as",
    )
    expect(checked).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it("refuses rather than falling back when the messenger cannot send as another identity", async () => {
    const { deps, send, resolve } = setup({ capable: false })
    await expect(messagesService(deps).send({ chat: "x", text: "hello", sendAs: "-1002" })).rejects.toThrow(
      "cannot send as another identity",
    )
    expect(resolve).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("refuses an attachment before connecting", async () => {
    const { deps } = setup()
    const connection = vi.fn(deps.connection)
    await expect(
      messagesService({ ...deps, connection }).send({
        chat: "x",
        text: "caption",
        sendAs: "-1002",
        attachments: [{ kind: "file", name: "synthetic.txt", bytes: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow("text only")
    expect(connection).not.toHaveBeenCalled()
  })

  it("leaves a send without an identity untouched", async () => {
    const { deps, send, sendAsIdentities, journal } = setup()
    await messagesService(deps).send({ chat: "x", text: "hello" })
    expect(sendAsIdentities).not.toHaveBeenCalled()
    expect(send.mock.calls[0]?.[2]).not.toHaveProperty("sendAs")
    expect(journal[0]).not.toHaveProperty("sendAs")
  })
})
