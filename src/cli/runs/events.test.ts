import { describe, expect, it } from "vitest"
import { providerErrorKey, renderEvent } from "./events.js"

describe("renderEvent", () => {
  it("shows a request and its response with ids, duration, counts and the error", () => {
    expect(renderEvent({ event: "request", operation: "messages.list", ids: { chat: "777" } })).toBe(
      "→ messages.list    chat 777",
    )
    expect(
      renderEvent({
        event: "response",
        operation: "messages.list",
        ids: { chat: "777" },
        durationMs: 118,
        counts: { messages: 3 },
        errorCode: "provider_error",
        providerError: "FLOOD_WAIT",
      }),
    ).toBe("← messages.list    chat 777  118ms  3 messages  provider_error  FLOOD_WAIT")
  })

  it("shows a warning by its code", () => {
    expect(renderEvent({ event: "warning", code: "partial", operation: "chats.list" })).toBe(
      "! chats.list       partial",
    )
    expect(renderEvent({ event: "warning", code: "partial" })).toBe(`! ${" ".repeat(16)} partial`)
  })
})

describe("providerErrorKey", () => {
  it("keeps a key and drops a sentence, which may quote what was sent", () => {
    expect(providerErrorKey("PEER_ID_INVALID")).toBe("PEER_ID_INVALID")
    expect(providerErrorKey("login.token")).toBe("login.token")
    expect(providerErrorKey("chat 'Book club' not found")).toBeUndefined()
    expect(providerErrorKey(42)).toBeUndefined()
  })
})
