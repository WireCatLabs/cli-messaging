import * as v from "valibot"
import { chatChart } from "../../charts/chat.js"
import { CHART_KINDS } from "../../charts/model.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { timezoneOf } from "../../search/lucene/dates.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { type AnyTool, chatOf, READ, tool } from "../tool.js"

export const statsTools = (messenger: Messenger): Record<string, AnyTool> => ({
  stats_charts: tool({
    title: "A chart from a chat's statistics",
    description:
      "A neutral chart description as JSON: messages or active authors per day or week, from the local store. " +
      "Missing dates are gaps, and partial marks lower bounds. Membership needs online events and is unavailable here. " +
      "No image file is written and no messenger connection is opened.",
    input: v.object({
      chat: chatOf(messenger),
      chart_kind: v.optional(v.picklist(CHART_KINDS)),
      by: v.optional(v.picklist(["day", "week"])),
      since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
      timezone: v.optional(v.pipe(v.string(), v.description("the IANA timezone for calendar days"))),
    }),
    annotations: { ...READ, openWorldHint: false },
    stored: async (store, account, args, defaults) => {
      const timezone = timezoneOf(args.timezone)
      const by = args.by ?? "day"
      const stats = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).chats.stats(args.chat, {
        by,
        timezone,
        ...(args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") }),
      })
      return { chart: chatChart(stats, { kind: args.chart_kind ?? "messages", by, timezone }) }
    },
  }),
})
