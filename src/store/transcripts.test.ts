import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "transcripts-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

describe("transcripts", () => {
  it("**keep what a voice message said, by chat and message, per account** — even before the message is stored", async () => {
    const store = await openStore({ path: fresh() })
    await store.keepTranscript(OWNER, "-1", "42", "first try", "gigaam-v3")
    await store.keepTranscript(OWNER, "-1", "42", "heard again", "telegram")
    await store.keepTranscript(OWNER, "-1", "43", "   ", "telegram")

    expect(await store.transcript(OWNER, "-1", "42")).toEqual({ text: "heard again", source: "telegram" })
    expect(await store.transcript(OWNER, "-1", "43")).toBeUndefined()
    expect(await store.transcript(OTHER, "-1", "42")).toBeUndefined()
    expect(await store.transcript(OWNER, "-404", "42")).toBeUndefined()
    await store.close()
  })
})

describe("a build on version 6, on a version 11 file", () => {
  it("keeps reading and writing: version 11 only adds a table", async () => {
    const path = fresh()
    await (await openStore({ path })).close()

    const { openStore: openOlder } = await import("cli-messaging-0.49/store")
    const older = await openOlder({ path })
    await older.saveAccount(OWNER, { name: "Owner" })
    await older.close()
  })
})
