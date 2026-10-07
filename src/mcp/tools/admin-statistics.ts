import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { AdminQuery } from "../../services/admin-statistics.js"
import { searchServices } from "../search-sync.js"
import { type AnyTool, READ, tool } from "../tool.js"

const common = {
  saved: v.optional(v.string()),
  timezone: v.optional(v.string()),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
}
const query = {
  ...common,
  text: v.optional(v.string()),
  ast: v.optional(v.unknown()),
  chat: v.optional(v.string()),
  source: v.optional(v.string()),
  exact: v.optional(v.boolean()),
}
const people = { answerer: v.optional(v.array(v.string())) }
export const adminStatisticsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const definitions: Record<string, AnyTool> = {}
  for (const report of ["unanswered", "responses", "newcomers", "discussion"] as const) {
    const path = report === "responses" ? "contacts" : report === "newcomers" ? "chats" : "messages"
    const entries: v.ObjectEntries =
      report === "newcomers"
        ? {
            ...common,
            ...people,
            chat: v.string(),
            since_time: v.optional(v.string()),
            until_time: v.optional(v.string()),
            within: v.optional(v.string()),
          }
        : report === "discussion"
          ? {
              ...query,
              min_views: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
              max_replies: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
            }
          : {
              ...query,
              ...people,
              ...(report === "unanswered" ? { older_than: v.optional(v.string()) } : {}),
            }
    const input = v.object(entries)
    definitions[`stats_${path}_${report}`] = tool({
      title: `Stored ${report} report`,
      description:
        "Administrator statistics from authorized stored history only. Explicit qualifying replies; selected answerer identities do not prove historical admin roles. Missing joining dates, reply history and counters remain unknown or partial. Returns bounded drilldown selections. No fetch, sends, mark-read or model calls.",
      input,
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults) => {
        const services = searchServices(messenger, store, account, defaults)
        const values = args as Partial<AdminQuery> & {
          answerer?: string[]
          older_than?: string
          since_time?: string
          until_time?: string
          min_views?: number
          max_replies?: number
        }
        return services.adminStatistics.report(report, {
          limit: values.limit ?? 20,
          timezone: values.timezone,
          saved: values.saved,
          signal: defaults.signal,
          text: values.text,
          ast: values.ast,
          chat: values.chat,
          source: values.source,
          exact: values.exact,
          answerers: values.answerer,
          olderThan: values.older_than,
          within: values.within,
          sinceTime: values.since_time,
          untilTime: values.until_time,
          minViews: values.min_views,
          maxReplies: values.max_replies,
        })
      },
    })
  }
  return definitions
}
