import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { chatChart } from "../../charts/chat.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { openStore } from "../../store/store.js"
import { seedSearchRecipes } from "../../testing/search-recipes.js"
import type { Defaults } from "../tool.js"
import { statsTools } from "./stats.js"

const messenger = {
  app: { command: "chat" },
  provider: "chat",
  chatArgument: "a chat",
  connect: async () => {
    throw new Error("chart tool connected")
  },
} as unknown as Messenger
const defaults: Defaults = {
  limit: 20,
  guard: { check: () => {}, record: () => {} },
  env: {},
  settings: { profile: "default", configured: {}, shared: {} },
}
const account = { provider: "chat", account: "500" }

describe("stats_charts", () => {
  it("returns the same neutral data as CLI's builder, entirely from the store", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "chart-tool-")), "m.db") })
    try {
      await seedSearchRecipes(store, account)
      const tool = statsTools(messenger).stats_charts
      if (!tool?.stored) throw new Error("stats_charts is not stored")
      const stats = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).chats.stats("7", {
        by: "day",
        since: Date.parse("2026-01-01"),
        timezone: "UTC",
      })
      expect(
        await tool.stored(store, account, { chat: "7", since_time: "2026-01-01", timezone: "UTC" }, defaults),
      ).toEqual({ chart: chatChart(stats, { by: "day", kind: "messages", timezone: "UTC" }) })
      expect(
        await tool.stored(
          store,
          account,
          { chat: "7", chart_kind: "active", by: "week", since_time: "2026-01-01" },
          defaults,
        ),
      ).toMatchObject({ chart: { kind: "line", x: { type: "week" } } })
      await expect(tool.stored(store, account, { chat: "7", chart_kind: "membership" }, defaults)).rejects.toThrow(
        "unavailable",
      )
    } finally {
      await store.close()
    }
  })
})
