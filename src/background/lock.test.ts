import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readLock, takeLock } from "./lock.js"

const lockIn = () => join(mkdtempSync(join(tmpdir(), "serve-lock-")), "serve", "default.lock")
const by = (pid: number) => ({ pid, startedAt: "2026-10-04T20:00:00.000Z" })
const GONE = 2 ** 22 + 12345

describe("takeLock", () => {
  it("takes a free lock, owner-only, and leaves no draft behind", () => {
    const path = lockIn()

    expect(takeLock(path, by(process.pid))).toBeUndefined()

    expect(readLock(path)).toMatchObject({ pid: process.pid })
    expect(readdirSync(join(path, ".."))).toEqual(["default.lock"])
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("answers the live holder and leaves its lock as it was", () => {
    const path = lockIn()
    takeLock(path, by(process.ppid))

    expect(takeLock(path, by(process.pid))).toMatchObject({ pid: process.ppid })
    expect(readLock(path)).toMatchObject({ pid: process.ppid })
  })

  it("lets only the first of two serves taking over a dead holder's lock win", () => {
    const path = lockIn()
    takeLock(path, by(GONE))

    expect(takeLock(path, by(process.pid))).toBeUndefined()
    expect(takeLock(path, by(process.ppid))).toMatchObject({ pid: process.pid })
  })

  it("takes over a lock nobody can read", () => {
    const path = lockIn()
    takeLock(path, by(GONE))
    writeFileSync(path, "not json")

    expect(takeLock(path, by(process.pid))).toBeUndefined()
    expect(readLock(path)).toMatchObject({ pid: process.pid })
  })
})
