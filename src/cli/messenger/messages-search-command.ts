import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { parseLocator } from "../../domain/locator.js"
import { renderMessages } from "../../render/messages.js"
import { environmentOf } from "../context.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

export const messagesSearchCommand = (messenger: Messenger): Command =>
  new Command("search")
    .description("search the local store — what was read, fetched or kept by serve; never asks the messenger")
    .argument(
      "[query...]",
      'strict Lucene query: words, "phrases", AND/OR/NOT, field groups and date ranges; --language legacy keeps discovery; with --saved, more words AND-ed to it',
    )
    .option("--chat <chat>", `only this chat — the same as chat: in the query; ${messenger.chatArgument}`)
    .option(
      "--source <messenger>",
      "every account of this messenger held in the store; personal, bots or all — the same as in: in the query",
    )
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--newest", "newest first instead of best first")
    .option("--context <n>", "messages before and after each hit; 2 in the terminal, 0 otherwise", wholeCount)
    .option("--language <lucene|legacy>", "the query language: strict Lucene or legacy discovery", languageOf)
    .option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
    .addHelpText(
      "after",
      "Search guide: https://github.com/leemour/cli-messaging/blob/main/docs/search/query-language.md",
    )
    .option("--regex", "the words are one regular expression, case-insensitive, tested against every stored text")
    .option("--saved <name|id>", "run a saved search or an earlier run; options typed here replace its own")
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const {
        chat,
        source,
        regex,
        language,
        timezone,
        newest,
        context: around,
        limit: typedLimit,
        saved,
      } = this.opts<{
        chat?: string
        source?: string
        regex?: boolean
        language?: "lucene" | "legacy"
        timezone?: string
        newest?: boolean
        context?: number
        limit?: number
        saved?: string
      }>()
      if (saved === undefined && words.length === 0)
        throw new CliError("validation_error", "give a query, or --saved <name> to run a saved search")
      if (saved !== undefined && regex)
        throw new CliError("validation_error", "--regex is kept with the saved search; not with --saved")
      const controller = new AbortController()
      context.track({ close: async () => controller.abort() })
      const external = environmentOf(this).signal
      const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal
      const typed = {
        ...(chat === undefined ? {} : { chat }),
        ...(source === undefined ? {} : { source }),
        ...(language === undefined ? {} : { language }),
        ...(timezone === undefined ? {} : { timezone }),
        ...(newest ? { newest: true } : {}),
        ...(around === undefined ? {} : { context: around }),
        ...(typedLimit === undefined ? {} : { limit: typedLimit }),
      }
      let limit = context.settings.limit
      const found = await context.withServices(async (services) => {
        if (saved === undefined) {
          const pattern = regex ? patternOf(words.join(" ")) : undefined
          return services.messages.search({
            ...typed,
            ...(pattern ? { pattern } : { text: words.join(" ") }),
            limit,
            signal,
            language: language ?? (pattern ? "legacy" : "lucene"),
            newest: newest === true,
            context: around ?? (context.format === "pretty" ? 2 : 0),
          })
        }
        const { id, params, pattern } = await services.searches.resolve(saved, { ...typed, text: words.join(" ") })
        limit = params.limit ?? limit
        return services.messages.search({
          ...(pattern ? { pattern } : params.text === undefined ? {} : { text: params.text }),
          ...(params.ast === undefined ? {} : { ast: params.ast }),
          ...(params.chat === undefined ? {} : { chat: params.chat }),
          ...(params.source === undefined ? {} : { source: params.source }),
          ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
          limit,
          signal,
          language: params.language ?? (pattern ? "legacy" : "lucene"),
          newest: params.newest === true,
          context: params.context ?? (context.format === "pretty" ? 2 : 0),
          saved: id,
        })
      })
      const { command } = messenger.app
      for (const { from, to } of found.corrections) context.renderer.note(`${from} → ${to.join(", ")}`)
      if (!found.wordsReady) {
        context.renderer.note(
          found.query
            ? `the word index is still being built, so a search by words fails until \`${command} store migrate\` finishes it`
            : `the word index is still being built, so a search by words reads pieces of words until \`${command} store migrate\` finishes it`,
        )
      }
      const incomplete = found.completeness.filter((chat) => chat.state !== "complete").length
      if (incomplete > 0) {
        context.renderer.note(
          `${incomplete} of the chats searched are not held in full — \`${command} store fetch <chat>\` fetches one`,
        )
      }
      if (context.format === "pretty") {
        const options = {
          color: context.color,
          verbosity: context.settings.detail,
          senderColors: context.settings.senderColors,
          profile: context.profile,
          provider: messenger.provider,
          locale: messenger.app.locale,
        }
        const hits = found.items.map((hit) => ({ hit, at: parseLocator(hit.locator) }))
        const spans = new Set(hits.map(({ at }) => `${at.provider}/${at.account}`)).size > 1
        context.streams.data(
          hits
            .map(({ hit, at }) => {
              const title = hit.chatTitle ?? hit.chatId
              return `${spans ? `${at.provider} · ${title}` : title}  ${hit.locator}\n${renderMessages(hit.context ?? [hit], options)}`
            })
            .join("\n\n"),
        )
        const elsewhere = [...new Set(hits.map(({ at }) => at.provider))].filter((one) => one !== messenger.provider)
        if (elsewhere.length > 0) {
          context.renderer.note(
            `hits in ${elsewhere.join(", ")} open in that messenger's own CLI, by the locator: messages context msg:…`,
          )
        }
        if (found.items.length === 0)
          context.renderer.note("nothing found — only what is in the local store is searched")
        return
      }
      if (context.format === "jsonl") context.renderer.stream(found.items)
      else context.renderer.result({ ...found, page: 1, limit })
    })

const patternOf = (source: string): RegExp => {
  try {
    return new RegExp(source, "iu")
  } catch {
    throw new CliError("validation_error", "not a regular expression — check JavaScript syntax or use Lucene regex")
  }
}

export const wholeCount = (value: string): number => {
  if (!/^\d+$/.test(value.trim())) {
    throw new CliError("validation_error", `--context takes a whole number from 0 upwards, not "${value}"`)
  }
  return Number(value)
}

export const languageOf = (value: string): "lucene" | "legacy" => {
  if (value !== "lucene" && value !== "legacy")
    throw new CliError("validation_error", "--language takes lucene or legacy")
  return value
}
