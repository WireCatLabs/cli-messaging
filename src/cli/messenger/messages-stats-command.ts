import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import type { StatsGrouping } from "../../services/messages-search.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

const GROUPINGS: StatsGrouping[] = ["chat", "sender", "day", "hour"]

export const messagesStatsCommand = (messenger: Messenger): Command =>
  new Command("stats")
    .description(
      "how many stored messages match, by chat, sender, day or hour — the local store only; never asks the messenger",
    )
    .argument("[query...]", "a strict Lucene query, as for messages search; none counts every stored message")
    .option("--by <chat|sender|day|hour>", "what to count by (default: chat)", groupingOf)
    .option("--chat <chat>", `only this chat — the same as chat: in the query; ${messenger.chatArgument}`)
    .option(
      "--source <messenger>",
      "every account of this messenger held in the store; personal, bots or all — the same as in: in the query",
    )
    .option("--limit <n>", "how many rows", positiveCount("--limit"))
    .option("--timezone <zone>", "the IANA timezone for calendar days and hours")
    .addHelpText(
      "after",
      "Search guide: https://github.com/leemour/cli-messaging/blob/main/docs/search/query-language.md",
    )
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const { by, chat, source, timezone } = this.opts<{
        by?: StatsGrouping
        chat?: string
        source?: string
        timezone?: string
      }>()
      const { limit } = context.settings
      const stats = await context.withServices((services) =>
        services.messages.stats({
          ...(words.length ? { text: words.join(" ") } : {}),
          by: by ?? "chat",
          limit,
          language: "lucene",
          ...(timezone === undefined ? {} : { timezone }),
          ...(chat === undefined ? {} : { chat }),
          ...(source === undefined ? {} : { source }),
        }),
      )
      const incomplete = stats.completeness.filter((one) => one.state !== "complete").length
      if (incomplete > 0)
        context.renderer.note(
          `${incomplete} of the chats counted are not held in full, so these are lower bounds — \`${messenger.app.command} store fetch <chat>\` fetches one`,
        )
      if (context.format === "pretty") {
        const width = String(Math.max(0, ...stats.items.map(({ count }) => count))).length
        context.streams.data(
          stats.items
            .map(({ key, name, count }) => `${String(count).padStart(width)}  ${name ? `${name} (${key})` : key}`)
            .join("\n"),
        )
        context.renderer.note(`${stats.total} messages${stats.hasMore ? `; more rows than --limit ${limit}` : ""}`)
        return
      }
      if (context.format === "jsonl") context.renderer.stream(stats.items)
      else context.renderer.result({ ...stats, page: 1, limit })
    })

const groupingOf = (value: string): StatsGrouping => {
  if (!(GROUPINGS as string[]).includes(value))
    throw new CliError("validation_error", `--by takes ${GROUPINGS.join(", ")}`)
  return value as StatsGrouping
}
