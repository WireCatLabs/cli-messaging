import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat } from "../domain/models.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "members-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

const chat = (id: string, lastMessageAt: string | null): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt,
  participantsCount: null,
})

describe("chat members", () => {
  it("**a new list replaces the old one whole**, and members come back by name", async () => {
    const store = await openStore({ path: fresh() })
    await store.savePeople(OWNER, [
      { id: "7", name: "Vera" },
      { id: "8", name: "Anna", username: "anna" },
      { id: "9", name: null },
    ])
    await store.saveMembers(OWNER, "-100", ["7", "8", "9"])
    await store.saveMembers(OWNER, "-100", ["8", "7", "7"])

    expect(await store.members(OWNER, "-100")).toEqual([
      { id: "8", name: "Anna", username: "anna" },
      { id: "7", name: "Vera", username: null },
    ])
    expect(await store.members(OWNER, "-404")).toEqual([])
    await store.close()
  })

  it("finds the chats a person is in, newest first, for this account only", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveChats(OWNER, [chat("-1", "2026-09-01T00:00:00.000Z"), chat("-2", "2026-09-20T00:00:00.000Z")])
    await store.saveMembers(OWNER, "-1", ["7"])
    await store.saveMembers(OWNER, "-2", ["7", "8"])
    await store.saveMembers(OTHER, "-3", ["7"])

    expect((await store.chatsWith(OWNER, "7")).map(({ id }) => id)).toEqual(["-2", "-1"])
    expect((await store.chatsWith(OTHER, "7")).map(({ id }) => id)).toEqual(["-3"])
    expect(await store.members(OTHER, "-2")).toEqual([])
    expect(await store.chatsWith({ provider: "max", account: "3" }, "7")).toEqual([])
    await store.close()
  })
})

describe("a build on version 6, on a version 7 file", () => {
  it("**keeps reading and writing**: version 7 only adds a table", async () => {
    const path = fresh()
    await (await openStore({ path })).close()

    const { openStore: openOlder } = await import("cli-messaging-0.49/store")
    const older = await openOlder({ path })
    await older.saveChats(OWNER, [chat("-1", null)])
    expect((await older.chats(OWNER, {})).items.map(({ id }) => id)).toEqual(["-1"])
    await older.close()
  })
})
