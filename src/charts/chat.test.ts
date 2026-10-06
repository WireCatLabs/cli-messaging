import { describe, expect, it } from "vitest"
import { type ChatStats, chatStats, type StatsRow } from "../services/chat-stats.js"
import { chartKindOf, chartPeriodOf, chatChart } from "./chat.js"

const statsWith = (series: StatsRow[] = []): ChatStats => ({
  ...chatStats([], {
    chatId: "7",
    timezone: "UTC",
    since: Date.parse("2026-09-01"),
    until: Date.parse("2026-10-01"),
    admins: null,
    completeness: { chatId: "7", state: "complete", upToDate: true, gaps: false, reachesStart: true, fetchedAt: null },
  }),
  series,
})

const rows = [
  { key: "2026-09-01", messages: 4, senders: 2, joined: 1, left: 0 },
  { key: "2026-09-03", messages: 0, senders: 0, joined: 0, left: 3 },
]

describe("a chat's neutral chart", () => {
  it("keeps observed zeroes and missing days distinct", () => {
    expect(chatChart(statsWith(rows), { timezone: "Europe/Madrid" })).toEqual({
      version: 1,
      kind: "bar",
      title: "Messages per day",
      x: { type: "day", values: ["2026-09-01", "2026-09-02", "2026-09-03"] },
      series: [{ name: "Messages", values: [4, null, 0] }],
      unit: "messages",
      timezone: "Europe/Madrid",
      partial: false,
      reasons: [],
    })
    expect(chatChart(statsWith(rows), { kind: "active", timezone: "UTC" })).toMatchObject({
      kind: "line",
      unit: "people",
      series: [{ name: "Authors", values: [2, null, 0] }],
    })
  })

  it("compares joins and leaves, and marks both incomplete sources", () => {
    const stats = statsWith(rows)
    stats.complete = false
    stats.completeness.state = "partial"
    stats.members = { joined: 1, left: 3, net: -2, wrote: 0, medianMinutesToFirstMessage: null, more: true }
    expect(chatChart(stats, { kind: "membership", timezone: "UTC" })).toMatchObject({
      kind: "grouped-bar",
      partial: true,
      reasons: ["store-incomplete", "events-incomplete"],
      series: [
        { name: "Joined", values: [1, null, 0] },
        { name: "Left", values: [0, null, 3] },
      ],
    })
    stats.series = [{ key: "2026-09-01", messages: 4, senders: 2 }]
    expect(chatChart(stats, { kind: "membership", timezone: "UTC" }).series[0]?.values).toEqual([null])
    expect(() => chatChart(statsWith(rows), { kind: "membership", timezone: "UTC" })).toThrow("unavailable")
  })

  it("keeps Monday week keys, including gaps, across a DST change", () => {
    const stats = statsWith([
      { key: "2026-10-19", messages: 2, senders: 1 },
      { key: "2026-11-02", messages: 3, senders: 2 },
    ])
    expect(chatChart(stats, { by: "week", timezone: "Europe/Madrid" })).toMatchObject({
      x: { type: "week", values: ["2026-10-19", "2026-10-26", "2026-11-02"] },
      series: [{ values: [2, null, 3] }],
      timezone: "Europe/Madrid",
    })
  })

  it("accepts empty data and bounds calendar expansion", () => {
    const stats = statsWith()
    delete stats.series
    expect(chatChart(stats, { timezone: "UTC" }).x.values).toEqual([])
    expect(() =>
      chatChart(
        statsWith([
          { key: "1900-01-01", messages: 1, senders: 1 },
          { key: "2026-01-01", messages: 1, senders: 1 },
        ]),
        { timezone: "UTC" },
      ),
    ).toThrow("period is too large")
  })

  it("rejects unknown chart kinds and groupings", () => {
    expect(chartKindOf("membership")).toBe("membership")
    expect(chartPeriodOf("day")).toBe("day")
    expect(chartPeriodOf("week")).toBe("week")
    expect(() => chartKindOf("pie")).toThrow("chart kind")
    expect(() => chartPeriodOf("hour")).toThrow("by takes")
  })
})
