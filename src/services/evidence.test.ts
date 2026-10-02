import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { type EvidencePacketInput, prepareEvidencePacket } from "./evidence.js"

const source = { provider: "test", account: "owner/a", chat: "room/a" }
const message = (id: string, text = "A decision"): Message => ({
  id,
  chatId: source.chat,
  senderId: "author",
  senderName: "Example author",
  timestamp: "2026-10-02T09:00:00.000Z",
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const input = (items = [message("first"), message("second")]): EvidencePacketInput => ({
  kind: "chats",
  source,
  page: { items, hasMore: false },
})

describe("evidence packets", () => {
  it("preserves order and produces escaped source and reply locators without provider payloads", () => {
    const first: Message = {
      ...message("first/b"),
      senderIsChat: true,
      replyToId: "parent/b",
      threadId: "topic",
      attachments: [{ kind: "photo", url: "https://example.test/file", providerRef: { token: "fixture-only" } }],
      providerMetadata: { token: "fixture-only", unrelated: "not evidence" },
    }
    const suppliedSource = { ...source }
    const packet = prepareEvidencePacket({ ...input([first, message("second")]), source: suppliedSource })

    expect(packet.items.map(({ locator }) => locator)).toEqual([
      "msg:test/owner%2Fa/room%2Fa/first%2Fb",
      "msg:test/owner%2Fa/room%2Fa/second",
    ])
    expect(packet.items[0]).toMatchObject({
      replyTo: "msg:test/owner%2Fa/room%2Fa/parent%2Fb",
      threadId: "topic",
      attachmentKinds: ["photo"],
      senderIsChat: true,
    })
    expect(JSON.stringify(packet)).not.toMatch(/fixture-only|example\.test|not evidence/)
    first.text = "changed later"
    first.attachments = [{ kind: "video", url: "", providerRef: {} }]
    suppliedSource.account = "changed later"
    expect(packet.items[0]?.text).toBe("A decision")
    expect(packet.items[0]?.attachmentKinds).toEqual(["photo"])
    expect(packet.source.account).toBe("owner/a")
  })

  it("reports count truncation and upstream paging without claiming complete history", () => {
    const packet = prepareEvidencePacket({
      ...input(),
      page: { ...input().page, hasMore: true },
      limits: { messages: 1 },
    })

    expect(packet.coverage).toEqual({
      provided: 2,
      included: 1,
      omitted: 1,
      hasMore: true,
      history: "unknown",
      truncatedBy: "messages",
    })
  })

  it("counts UTF-8 bytes including array separators and includes the exact byte boundary", () => {
    const prepared = input([message("first", "Привет 🌍"), message("second", "世界")])
    const full = prepareEvidencePacket(prepared)
    const one = prepareEvidencePacket({ ...prepared, limits: { messages: 1 } })
    const exact = prepareEvidencePacket({ ...prepared, limits: { bytes: full.contentBytes } })
    const smaller = prepareEvidencePacket({ ...prepared, limits: { bytes: full.contentBytes - 1 } })

    expect(full.contentBytes).toBe(Buffer.byteLength(JSON.stringify(full.items), "utf8"))
    expect(full.contentBytes).toBeGreaterThan(JSON.stringify(full.items).length)
    expect(exact.items).toHaveLength(2)
    expect(exact.coverage.truncatedBy).toBeNull()
    expect(smaller.items).toHaveLength(1)
    expect(smaller.contentBytes).toBe(one.contentBytes)
    expect(smaller.coverage).toMatchObject({ omitted: 1, truncatedBy: "bytes" })
  })

  it("leaves an oversized message whole and reports it as omitted", () => {
    const packet = prepareEvidencePacket({ ...input(), limits: { bytes: 2 } })

    expect(packet.items).toEqual([])
    expect(packet.contentBytes).toBe(2)
    expect(packet.coverage).toMatchObject({ included: 0, omitted: 2, truncatedBy: "bytes" })
  })

  it("supports an empty page without inventing archive coverage", () => {
    const packet = prepareEvidencePacket(input([]))

    expect(packet.items).toEqual([])
    expect(packet.coverage).toMatchObject({ provided: 0, omitted: 0, history: "unknown", truncatedBy: null })
  })

  it("binds fingerprints to the supplied evidence and operation, independently of packet ids", () => {
    const first = prepareEvidencePacket(input())
    const repeated = prepareEvidencePacket(input())
    const edited = prepareEvidencePacket(input([message("first", "An amended decision"), message("second")]))
    const news = prepareEvidencePacket({ ...input(), kind: "news" })
    const otherAccount = prepareEvidencePacket({ ...input(), source: { ...source, account: "other" } })

    expect(first.id).not.toBe(repeated.id)
    expect(first.fingerprint).toBe(repeated.fingerprint)
    expect(first.items[0]?.fingerprint).toBe(repeated.items[0]?.fingerprint)
    expect(first.fingerprint).not.toBe(edited.fingerprint)
    expect(first.items[0]?.fingerprint).not.toBe(edited.items[0]?.fingerprint)
    expect(first.fingerprint).not.toBe(news.fingerprint)
    expect(first.items[0]?.fingerprint).not.toBe(otherAccount.items[0]?.fingerprint)
  })

  it("uses a quoted reply id when the provider did not supply replyToId", () => {
    const quoted = {
      ...message("first"),
      replyTo: {
        id: "parent",
        senderId: null,
        senderName: null,
        timestamp: null,
        text: "quote",
        attachments: [],
        outgoing: null,
      },
    }
    expect(prepareEvidencePacket(input([quoted])).items[0]?.replyTo).toBe("msg:test/owner%2Fa/room%2Fa/parent")
  })

  it("refuses a mismatched chat even if that message would be omitted", () => {
    const mixed = input([message("first"), { ...message("second"), chatId: "other" }])
    expect(() => prepareEvidencePacket({ ...mixed, limits: { messages: 1 } })).toThrow(/named chat/)
  })

  it("refuses missing or repeated message ids so citations are unambiguous", () => {
    expect(() => prepareEvidencePacket(input([message(" ")]))).toThrow(/must have an id/)
    expect(() => prepareEvidencePacket(input([message("same"), message("same", "another version")]))).toThrow(
      /must not repeat/,
    )
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid message and byte limits: %s",
    (limit) => {
      for (const limits of [{ messages: limit }, { bytes: limit }]) {
        expect(() => prepareEvidencePacket({ ...input(), limits })).toThrow(/safe integer/)
      }
    },
  )

  it("refuses a byte budget smaller than the empty array and an unspecified scope", () => {
    expect(() => prepareEvidencePacket({ ...input(), limits: { bytes: 1 } })).toThrow(/at least 2/)
    for (const part of ["provider", "account", "chat"] as const) {
      expect(() => prepareEvidencePacket({ ...input(), source: { ...source, [part]: " " } })).toThrow(
        /source must name/,
      )
    }
    expect(() => prepareEvidencePacket({ ...input(), kind: "unsupported" as EvidencePacketInput["kind"] })).toThrow(
      /kind must be/,
    )
  })
})
