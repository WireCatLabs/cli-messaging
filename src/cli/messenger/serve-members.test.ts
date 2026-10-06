import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AccountKey, type MessageStore, openStore } from "../../store/store.js"
import { memberFetches } from "./serve-members.js"

const account: AccountKey = { provider: "test", account: "500" }
const opened: MessageStore[] = []
const tracking = async (ids: string[]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "serve-members-")), "m.db") })
  opened.push(store)
  await store.saveChats(
    account,
    ids.map((id) => ({ id, title: null, kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 1 })),
  )
  for (const id of ids) await store.trackMembers(account, id, true)
  return store
}
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

describe("serve's daily member fetch", () => {
  it("fetches every tracked chat in turn, skips one fetched today, and goes on past a failure", async () => {
    const store = await tracking(["7", "8", "9"])
    await store.saveRoster(account, "8", { members: [], complete: true, participants: 0 })
    const fetched: string[] = []
    const warned: string[] = []
    const fetches = memberFetches({
      withStore: (work) => work(store, account),
      fetch: async (_store, _account, chatId) => {
        fetched.push(chatId)
        if (chatId === "7") throw new Error("flood wait")
      },
      warn: (text) => warned.push(text),
      firstMs: 1,
      everyMs: 60_000,
    })

    fetches.start()
    await settle(30)
    await fetches.stop()

    expect(fetched).toEqual(["7", "9"])
    expect(fetches.summary()).toEqual({ fetched: 1, failed: 1 })
    expect(warned).toEqual(["members of 7 were not fetched: flood wait"])
  })

  it("does nothing when stopped before its first round, and leaves no timer behind", async () => {
    const store = await tracking(["7"])
    const fetched: string[] = []
    const fetches = memberFetches({
      withStore: (work) => work(store, account),
      fetch: async (_store, _account, chatId) => {
        fetched.push(chatId)
      },
      warn: () => {},
      firstMs: 20,
    })

    fetches.start()
    await fetches.stop()
    await settle(40)

    expect(fetched).toEqual([])
  })
})
