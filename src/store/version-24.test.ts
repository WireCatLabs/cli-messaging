import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const account = { provider: "telegram", account: "1" }
const now = Date.parse("2026-10-08T12:00:00Z")
it("keeps schema 6 writers compatible without fabricating freshness", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "migration-24-")), "store.db")
  const db = await openCache(path)
  migrate(db, { migrations: MIGRATIONS.filter((migration) => migration.version < 24) })
  db.exec("INSERT INTO accounts(pk,provider,native_id,created_at) VALUES(1,'telegram','1',0)")
  db.exec("INSERT INTO chats(pk,account_pk,native_id,kind,updated_at) VALUES(1,1,'7','group',0)")
  db.exec(
    `INSERT INTO messages(pk,chat_pk,account_pk,native_id,sent_at,text,normalized_text,normalizer_version,ingested_at,ingested_via,provider_metadata) VALUES(1,1,1,'42',0,'Synthetic','synthetic',1,0,'history','{"views":10}')`,
  )
  db.close()
  const store = await openStore({ path, now: () => now })
  try {
    expect((await store.counterStates?.(account, "7", "42", { now, maxAge: 1000 }))?.[0]).toMatchObject({
      value: 10,
      freshness: "unknown",
      observedAt: null,
    })
    await store.updateCounterObservations?.(account, "7", "42", {
      views: { value: 20, observedAt: new Date(now).toISOString(), source: "remote_fetch" },
    })
    const legacy = await openCache(path)
    try {
      migrate(legacy, { migrations: MIGRATIONS.filter((migration) => migration.version <= 6) })
      legacy.exec(`UPDATE messages SET provider_metadata='{"views":30}' WHERE pk=1`)
      expect(legacy.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version).toBe(24)
    } finally {
      legacy.close()
    }
    expect((await store.counterStates?.(account, "7", "42", { now, maxAge: 1000 }))?.[0]).toMatchObject({
      value: 30,
      freshness: "unknown",
      observedAt: null,
    })
  } finally {
    await store.close()
  }
})

describe("observation purge", () => {
  it("cascades new history tables when a stored chat is explicitly purged", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "purge-observations-")), "store.db")
    const store = await openStore({ path, now: () => now })
    try {
      await store.saveChats(account, [
        { id: "7", title: "Synthetic", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 1 },
      ])
      await store.saveRoster(account, "7", {
        members: [{ id: "2", name: "Synthetic", username: null, role: "member" }],
        complete: true,
        participants: 1,
        observation: { observedAt: new Date(now).toISOString(), source: "remote_fetch" },
      })
      await store.markChatsLeft(account, [])
      await store.leftChats(account, { clear: true })
      const db = await openCache(path)
      try {
        expect(db.prepare("SELECT count(*) AS n FROM membership_batches").get()?.n).toBe(0)
        expect(db.prepare("SELECT count(*) AS n FROM membership_batch_members").get()?.n).toBe(0)
      } finally {
        db.close()
      }
    } finally {
      await store.close()
    }
  })
})
