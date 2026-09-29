import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import { readAll } from "./stdin.js"

describe("readAll", () => {
  it("reads a pipe to the end, and nothing from a terminal", async () => {
    expect(await readAll(Readable.from([Buffer.from("héllo "), "world"]))).toBe("héllo world")
    expect(await readAll(Object.assign(Readable.from(["typed"]), { isTTY: true }))).toBe("")
  })
})
