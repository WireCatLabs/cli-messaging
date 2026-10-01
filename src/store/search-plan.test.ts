import { describe, expect, it } from "vitest"
import { migrate } from "./migrations.js"
import { openSqlite } from "./sqlite/open.js"
import { matching, newestHits } from "./sqlite/search.js"

const opened = async () => {
  const sqlite = await openSqlite(":memory:")
  migrate(sqlite.database)
  return { ...sqlite, now: () => 0 }
}

const planOf = (context: Awaited<ReturnType<typeof opened>>, sql: string, params: unknown[]) =>
  context.database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as never[]))
    .map((row) => String(row.detail))

/** The shape the benchmark found slow: the index searched again for every message row, by its rowid. */
const perRow = (plan: string[]) => plan.some((line) => /VIRTUAL TABLE INDEX \d+:=/.test(line))

describe("the search query plan", () => {
  it("**reads the text index once**, not once per message, with text and chat filters", async () => {
    const context = await opened()
    const where = matching(context, {
      account: { provider: "telegram", account: "1" },
      chatId: "-100",
      text: "valencia",
    })
    const { sql, params } = newestHits(context, where, 21).toSQL()

    expect(perRow(planOf(context, sql, params))).toBe(false)
    context.database.close()
  })

  it("would notice the slow shape", async () => {
    const context = await opened()
    const forced = `SELECT m.pk FROM chats c CROSS JOIN messages m CROSS JOIN messages_fts f
                    WHERE m.chat_pk = c.pk AND f.rowid = m.pk AND messages_fts MATCH ? AND c.native_id = ?`

    expect(perRow(planOf(context, forced, ['"valencia"', "-100"]))).toBe(true)
    context.database.close()
  })
})
