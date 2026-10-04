import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FloodMemory, floodPathFor, SEND_BLOCK_MS } from "./flood.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "0" }
const at = (iso: string) => () => Date.parse(iso)
const memoryAt = (iso: string, path = join(mkdtempSync(join(tmpdir(), "flood-")), "flood", "p.json")) =>
  new FloodMemory(path, at(iso))

describe("flood memory", () => {
  it("lives in the state folder, one file per profile", () => {
    expect(floodPathFor(app, "work", { APP_STATE_DIR: "/state" })).toBe("/state/flood/work.json")
  })

  it("**remembers a wait across instances, owner-only, and forgets it once it has passed**", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    memory.remember({ operation: "history", waitMs: 60_000, providerError: "FLOOD_WAIT" })

    const later = new FloodMemory(memory.path, at("2026-10-04T10:00:59Z"))
    expect(later.owed("history", "42")).toEqual({
      operation: "history",
      until: "2026-10-04T10:01:00.000Z",
      providerError: "FLOOD_WAIT",
    })
    expect(new FloodMemory(memory.path, at("2026-10-04T10:01:00Z")).owed("history")).toBeUndefined()
    expect(statSync(memory.path).mode & 0o777).toBe(0o600)
  })

  it("a wait said about one chat holds only that chat; one said about the call holds every chat", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    memory.remember({ operation: "send", chatId: "1", waitMs: 30_000 })

    expect(memory.owed("send", "1")).toBeDefined()
    expect(memory.owed("send", "2")).toBeUndefined()
    expect(memory.owed("history", "1")).toBeUndefined()
  })

  it("keeps at most 50, dropping the ones that end soonest", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    for (let i = 1; i <= 55; i += 1) memory.remember({ operation: `op${i}`, waitMs: i * 1000 })

    const { deadlines } = memory.read()
    expect(deadlines).toHaveLength(50)
    expect(deadlines.map((one) => one.operation)).not.toContain("op5")
    expect(deadlines.map((one) => one.operation)).toContain("op6")
  })

  it("reads a torn or foreign file as empty rather than failing a command", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    memory.remember({ operation: "history", waitMs: 1000 })
    writeFileSync(memory.path, "{not json")

    expect(memory.read()).toEqual({ deadlines: [] })
  })

  it("**holds writes for a day when the end is unknown**; lifting a frozen hold leaves a spam limit alone", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    const block = memory.block({ state: "limited", hint: "spam" })
    expect(Date.parse(block.until) - Date.parse(block.since)).toBe(SEND_BLOCK_MS)

    memory.unblock("frozen")
    expect(memory.sendBlock()).toMatchObject({ state: "limited" })
    memory.unblock("limited")
    expect(memory.sendBlock()).toBeUndefined()

    memory.block({ state: "frozen", hint: "frozen", until: "2026-10-04T09:00:00Z" })
    expect(memory.sendBlock()).toBeUndefined()
  })
})
