import { CliError } from "@wirecat/cli-core"
import { describe, expect, it } from "vitest"
import { answered, BinaryResource, failed, Picture } from "./tool.js"

describe("MCP result contract", () => {
  it("makes nested hidden text and object keys visible in both result formats, including error and image metadata", () => {
    const hidden = "a\u{e0041}\u0085\u202e\ufeffb"
    const visible = "a\\u{e0041}\\x85\\u202e\\ufeffb"
    const flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"
    const original = { items: [{ [hidden]: hidden }], flag }
    const result = answered(original)
    expect(result.structuredContent).toEqual({ items: [{ [visible]: visible }], flag })
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) })
    expect(original.items).toEqual([{ [hidden]: hidden }])
    expect(JSON.stringify(original)).toContain(hidden)
    for (const value of [
      new Picture(new Uint8Array([1]), "image/png", { text: hidden }),
      new BinaryResource("AQ==", "application/octet-stream", "attachment://fixture", { text: hidden }),
    ]) {
      const response = answered(value)
      expect(response.structuredContent).toEqual({ text: visible })
      expect(response.content[1]).toEqual({ type: "text", text: JSON.stringify({ text: visible }) })
    }
    expect(failed(new CliError("validation_error", hidden, { title: hidden })).structuredContent).toMatchObject({
      error: { message: visible, title: visible },
    })
  })
  it("advertises only objects that it can return as structured content", () => {
    const body = { items: [], page: 1, limit: 0, hasMore: false }
    const result = answered(body)
    expect(result.structuredContent).toEqual(body)
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(body) }])
    for (const value of [null, [], "invalid"]) expect(() => answered(value as never)).toThrow("must be an object")
  })
  it("counts the complete response, including duplicated structured content and image bytes", () => {
    expect(() => answered({ text: "é".repeat(100) }, 200)).toThrow("byte limit")
    const image = new Picture(new Uint8Array(100), "image/png", { chart: "synthetic" })
    expect(answered(image, 0).structuredContent).toEqual({ chart: "synthetic" })
    expect(() => answered(image, 100)).toThrow("byte limit")
  })
  it("keeps explicit retry guidance and refuses automatic replay by default", () => {
    expect(failed(new Error("synthetic")).structuredContent).toMatchObject({ error: { retryable: false } })
    expect(
      failed(new CliError("outcome_unknown", "synthetic", { operationId: "op-synthetic" })).structuredContent,
    ).toMatchObject({ error: { code: "outcome_unknown", operationId: "op-synthetic", retryable: false } })
    expect(
      failed(new CliError("rate_limited", "synthetic", { retryable: true, retryAfterMs: 1000 })).structuredContent,
    ).toMatchObject({ error: { retryable: true, retryAfterMs: 1000 } })
  })
})

it("validates the serialized root and picture metadata, preserving nested ISO dates", () => {
  expect(() => answered(new Date())).toThrow("serialized tool result must be an object")
  expect(() => answered(new Picture(new Uint8Array(), "image/png", []))).toThrow(
    "serialized tool result must be an object",
  )
  expect(answered({ at: new Date("2026-10-06T00:00:00.000Z") }).structuredContent).toEqual({
    at: "2026-10-06T00:00:00.000Z",
  })
})
