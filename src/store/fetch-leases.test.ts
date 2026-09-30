import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "leases-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

describe("fetch leases", () => {
  it("**one holder at a time**: another waits for the lease to run out or be given back", async () => {
    let clock = 1_000
    const store = await openStore({ path: fresh(), now: () => clock })

    expect(await store.claim(OWNER, "-1", "newest", "a", 5_000)).toBe(true)
    expect(await store.claim(OWNER, "-1", "newest", "b", 5_000)).toBe(false)
    expect(await store.claim(OWNER, "-1", "older", "b", 5_000)).toBe(true)
    expect(await store.claim(OWNER, "-1", "newest", "a", 5_000)).toBe(true)

    clock += 5_000
    expect(await store.claim(OWNER, "-1", "newest", "b", 5_000)).toBe(true)

    await store.release(OWNER, "-1", "newest", "a")
    expect(await store.claim(OWNER, "-1", "newest", "a", 5_000)).toBe(false)
    await store.release(OWNER, "-1", "newest", "b")
    expect(await store.claim(OWNER, "-1", "newest", "a", 5_000)).toBe(true)
    await store.close()
  })

  it("keeps two accounts' leases apart, even on chats with the same id", async () => {
    const store = await openStore({ path: fresh() })
    expect(await store.claim(OWNER, "-1", "newest", "a", 60_000)).toBe(true)
    expect(await store.claim(OTHER, "-1", "newest", "b", 60_000)).toBe(true)
    await store.release({ provider: "max", account: "3" }, "-1", "newest", "a")
    await store.close()
  })
})

describe("a build on version 6, on a version 9 file", () => {
  it("keeps reading and writing: version 9 only adds a table", async () => {
    const path = fresh()
    await (await openStore({ path })).close()

    const { openStore: openOlder } = await import("cli-messaging-0.49/store")
    const older = await openOlder({ path })
    await older.saveAccount(OWNER, { name: "Owner" })
    await older.close()
  })
})
