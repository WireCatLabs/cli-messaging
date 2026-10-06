import { CliError } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import { answered, failed, Picture } from "./tool.js"

describe("MCP result contract", () => {
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
