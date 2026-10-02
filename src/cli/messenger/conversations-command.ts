import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { DEFAULT_TEXT_MODEL } from "../../embeddings/models.js"
import { isLocal, remoteModel } from "../../embeddings/remote.js"
import { renderMessages } from "../../render/messages.js"
import { levelFor } from "../../sends/permissions.js"
import { BATCH_SIZE } from "../../services/conversations.js"
import type { EmbedStatus, ModelChoice } from "../../services/embeddings.js"
import { momentOf } from "../../services/moment.js"
import type { AgentAnswer, ConversationSummary } from "../../store/store.js"
import { embeddingKeys } from "../embedding-keys.js"
import { positiveCount } from "../paging.js"
import { answerOf as askOwner } from "./ask.js"
import { type Messenger, type MessengerContext, messengerContext } from "./context.js"
import { readAll } from "./stdin.js"

/**
 * `conversations`: the threads inside a group chat, found by rules over the stored messages — replies,
 * mentions, one sender's messages in a row. From the store alone; nothing is built until asked (phase 3).
 */
export const conversationsCommand = (messenger: Messenger): Command => {
  const conversations = new Command("conversations").description(
    "the conversations inside a chat, found in the stored messages by replies, mentions and who wrote next",
  )

  conversations
    .command("build")
    .description(
      "find a chat's conversations in what the store holds, replacing the last build; never asks the messenger",
    )
    .requiredOption("--chat <chat>", messenger.chatArgument)
    .action(async function (this: Command) {
      const { chat } = this.opts<{ chat: string }>()
      const context = messengerContext(this, messenger)
      const built = await context.withServices((services) => services.conversations.build(chat))
      if (context.format === "pretty") {
        context.streams.data(
          `${built.messages} messages → ${built.conversations} conversations, ${built.links} links (rules v${built.rulesVersion})\n`,
        )
      } else context.renderer.result(built)
    })

  conversations
    .command("list")
    .description("a chat's conversations, the newest first: when, how many messages, how many people")
    .requiredOption("--chat <chat>", messenger.chatArgument)
    .option("--since-time <time>", "only those that started at this ISO 8601 time, or 30m / 2h / 1d ago, or later")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .action(async function (this: Command) {
      const { chat, sinceTime: since } = this.opts<{ chat: string; sinceTime?: string }>()
      const context = messengerContext(this, messenger)
      const { limit } = context.settings
      const page = await context.withServices((services) =>
        services.conversations.list(chat, {
          limit,
          ...(since === undefined ? {} : { since: new Date(momentOf(since, "--since-time")).toISOString() }),
        }),
      )
      if (context.format === "pretty") {
        context.streams.data(page.items.map((one) => `${line(one)}\n`).join(""))
        if (page.items.length === 0) context.renderer.note("no conversations in that window")
      } else if (context.format === "jsonl") context.renderer.stream(page.items)
      else context.renderer.result({ items: page.items, limit, hasMore: page.hasMore })
    })

  conversations
    .command("show")
    .description("one conversation's messages, oldest first — by its id, or the one a message is in")
    .argument(
      "<conversation>",
      `a conversation id from \`conversations list\`; or ${messenger.chatArgument}, with a message`,
    )
    .argument("[message]", "a message id in that chat: show the conversation it is in")
    .action(async function (this: Command, first: string, message: string | undefined) {
      const context = messengerContext(this, messenger)
      if (message === undefined && !/^\d+$/.test(first)) {
        throw new CliError("validation_error", "a conversation id is a number; for a chat, name a message too")
      }
      const { summary, messages } = await context.withServices((services) =>
        services.conversations.show(message === undefined ? { id: first } : { chat: first, message }),
      )
      if (context.format === "pretty") {
        context.streams.data(
          `${line(summary)}\n\n${renderMessages(messages, {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
            locale: messenger.app.locale,
          })}`,
        )
      } else if (context.format === "jsonl") context.renderer.stream(messages)
      else context.renderer.result({ ...summary, messages })
    })

  withModelOptions(conversations.command("search"))
    .description(
      "the conversations nearest in meaning to a query, in one chat or every embedded one — " +
        "after `conversations embed`; runs on this machine",
    )
    .argument("<query>", "what to look for, in your own words, in any language the model reads")
    .option("--chat <chat>", `only this chat: ${messenger.chatArgument}`)
    .option("--since-time <time>", "only those still going at this ISO 8601 time, or 30m / 2h / 1d ago, or later")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .action(async function (this: Command, query: string) {
      const options = this.opts<ModelOptions & { chat?: string; sinceTime?: string }>()
      const { chat, sinceTime: since } = options
      const context = messengerContext(this, messenger)
      const model = choiceOf(options, messenger, context)
      const { limit } = context.settings
      const found = await context.withServices((services) =>
        services.embeddings.search(query, {
          limit,
          ...(chat === undefined ? {} : { chat }),
          model,
          ...(since === undefined ? {} : { since: new Date(momentOf(since, "--since-time")).toISOString() }),
        }),
      )
      if (context.format === "pretty") {
        context.streams.data(
          found.hits
            .map(
              ({ summary, chunk, score }) =>
                `${score.toFixed(3)}  ${line(summary)}  (messages ${chunk.firstMessageId}–${chunk.lastMessageId})\n`,
            )
            .join(""),
        )
        if (found.hits.length === 0) {
          context.renderer.note(
            `nothing embedded with ${found.model} matches — \`conversations embed --chat <chat>\` first`,
          )
        }
      } else if (context.format === "jsonl") context.renderer.stream(found.hits)
      else {
        const { model, hits, embeddedOnlyElsewhere } = found
        context.renderer.result({ model, items: hits, limit, embeddedOnlyElsewhere })
      }
      if (found.embeddedOnlyElsewhere.length > 0) {
        context.renderer.note(
          `not searched, embedded only with another model: chat ${found.embeddedOnlyElsewhere.join(", ")} — ` +
            "give that model with --model, or `conversations embed` them with this one",
        )
      }
    })

  const batches = conversations
    .command("batches")
    .description("windows of a chat for your own AI agent to link: which earlier message each one answers")
  const sizeOption = (command: Command) =>
    command.option(
      "--size <n>",
      `messages to answer per batch, ${BATCH_SIZE.min}–${BATCH_SIZE.max}; ${BATCH_SIZE.default} by default`,
      positiveCount("--size"),
    )

  sizeOption(
    batches
      .command("status")
      .description("how many messages still wait for an answer, in how many batches, and how much text")
      .requiredOption("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const { chat, size = BATCH_SIZE.default } = this.opts<{ chat: string; size?: number }>()
    const context = messengerContext(this, messenger)
    const status = await context.withServices((services) => services.conversations.batchStatus(chat, size))
    if (context.format === "pretty") {
      context.streams.data(
        `${status.messages} messages to answer, about ${status.batches} batches, ` +
          `${status.characters} characters (about ${status.tokensEstimate} tokens)\n`,
      )
    } else context.renderer.result(status)
  })

  sizeOption(
    batches
      .command("next")
      .description("the next window to answer, with the messages before it; message text goes to stdout only")
      .requiredOption("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const { chat, size = BATCH_SIZE.default } = this.opts<{ chat: string; size?: number }>()
    const context = messengerContext(this, messenger)
    const batch = await context.withServices((services) => services.conversations.nextBatch(chat, size))
    if (!batch) {
      if (context.format === "pretty") context.renderer.note("every message of this chat has an answer")
      else context.renderer.result(null)
      return
    }
    if (context.format !== "pretty") {
      context.renderer.result(batch)
      return
    }
    context.streams.data(
      `${batch.batch}\n${batch.messages
        .map(
          (one) =>
            `${one.answer ? "?" : " "} ${one.id}  ${one.at.slice(0, 16).replace("T", " ")}  ${one.sender.name ?? one.sender.id ?? ""}` +
            `${one.replyTo ? `  ↳ ${one.replyTo}` : ""}\n    ${one.text.replaceAll("\n", "\n    ")}\n`,
        )
        .join("")}`,
    )
    context.renderer.note(`${batch.remaining.messages} messages left after this batch`)
  })

  const links = conversations
    .command("links")
    .description("your agent's answers: which earlier message each message of a batch answers")

  links
    .command("add")
    .description(
      'store your agent\'s answer to a batch, read as JSON from stdin: { "model", "answers": [{ "message", ' +
        '"parent", "confidence" }] }; all or nothing',
    )
    .requiredOption("--batch <id>", "the batch id `conversations batches next` printed")
    .action(async function (this: Command) {
      const { batch } = this.opts<{ batch: string }>()
      const context = messengerContext(this, messenger)
      writable(context, messenger.app.command)
      const answer = answerOf(await readAll(context.stdin))
      const stored = await context.withServices((services) => services.conversations.addAnswers(batch, answer))
      if (context.format === "pretty") {
        context.streams.data(
          `${stored.stored} answers stored — \`conversations build --chat ${stored.chat}\` uses them\n`,
        )
      } else context.renderer.result(stored)
    })

  links
    .command("clear")
    .description("drop your agent's answers for a chat, or only one model's; messages are never touched")
    .requiredOption("--chat <chat>", messenger.chatArgument)
    .option("--model <model>", "only the answers this model gave")
    .action(async function (this: Command) {
      const { chat, model } = this.opts<{ chat: string; model?: string }>()
      const context = messengerContext(this, messenger)
      writable(context, messenger.app.command)
      const cleared = await context.withServices((services) => services.conversations.clearAnswers(chat, model))
      if (context.format === "pretty") context.streams.data(`${cleared.cleared} answers dropped\n`)
      else context.renderer.result(cleared)
    })

  const embed = withModelOptions(
    new Command("embed")
      .description(
        "compute a vector for each chunk of a chat's conversations for search by meaning — on this machine, or " +
          "with --provider through a service and your key; resumes where it stopped",
      )
      .option("--chat <chat>", messenger.chatArgument),
  )
    .option(
      "--workers <n>",
      "local: sessions in parallel, each with its own copy of the model (~0.7 GB each)",
      positiveCount("--workers"),
    )
    .option("--threads <n>", "local: threads in all (default: min(8, cores))", positiveCount("--threads"))
    .option("--concurrency <n>", "remote: requests at once (default: 4)", positiveCount("--concurrency"))
    .option(
      "--max-tokens <n>",
      "remote: stop before a run that could send more tokens than this",
      positiveCount("--max-tokens"),
    )
    .action(async function (this: Command) {
      const options = this.optsWithGlobals<
        ModelOptions & { chat?: string; workers?: number; threads?: number; maxTokens?: number; yes?: boolean }
      >()
      const chat = chatOf(options)
      const context = messengerContext(this, messenger)
      writable(context, messenger.app.command, EMBED_KEY)
      const model = choiceOf(options, messenger, context)
      const done = await context.withServices(async (services) => {
        const status = await services.embeddings.status(chat, model)
        context.renderer.note(
          `${status.left} of ${status.chunks} chunks to embed with ${status.model}` +
            (status.estimateSeconds === null ? "" : `, ${minutes(status.estimateSeconds)} on one session`),
        )
        if (typeof model !== "string" && status.left > 0 && !isLocal(model.remote.baseUrl)) {
          await consent(this, status, model.remote.baseUrl, options)
        }
        return services.embeddings.embed(chat, {
          model,
          ...(options.workers ? { workers: options.workers } : {}),
          ...(options.threads ? { threads: options.threads } : {}),
          progress: (embedded, left) => context.renderer.note(`${embedded} embedded, ${left} left`),
        })
      })
      if (context.format === "pretty") {
        context.streams.data(
          `${done.embedded} chunks embedded with ${done.model}${done.skipped ? `, ${done.skipped} changed since the build — run \`conversations build\` again` : ""}\n`,
        )
      } else context.renderer.result(done)
    })

  withModelOptions(
    embed
      .command("status")
      .description("how many chunks of a chat have a vector of the model, how many are left, and what is left costs")
      .option("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const options = this.optsWithGlobals<ModelOptions & { chat?: string }>()
    const chat = chatOf(options)
    const context = messengerContext(this, messenger)
    const model = choiceOf(options, messenger, context, { needKey: false })
    const status = await context.withServices((services) => services.embeddings.status(chat, model))
    if (context.format === "pretty") {
      context.streams.data(
        `${status.embedded} of ${status.chunks} chunks embedded with ${status.model}; ${status.left} left` +
          (status.estimateSeconds === null ? "" : `, ${minutes(status.estimateSeconds)}`) +
          (status.priceAtMost ? `, at most ${dollars(status.priceAtMost.usd)}` : "") +
          "\n",
      )
    } else context.renderer.result(status)
  })

  withModelOptions(
    embed
      .command("clear")
      .description("drop a chat's vectors, or only one model's; messages and conversations are never touched")
      .option("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const options = this.optsWithGlobals<ModelOptions & { chat?: string }>()
    const chat = chatOf(options)
    const context = messengerContext(this, messenger)
    writable(context, messenger.app.command, EMBED_KEY)
    const given = options.model !== undefined || options.provider !== undefined || options.baseUrl !== undefined
    const model = given ? choiceOf(options, messenger, context, { needKey: false }) : undefined
    const cleared = await context.withServices((services) => services.embeddings.clear(chat, model))
    if (context.format === "pretty") context.streams.data(`${cleared.cleared} vectors dropped\n`)
    else context.renderer.result(cleared)
  })

  conversations.addCommand(embed)

  return conversations
}

/**
 * `deny` already stopped the command (`messengerContext`); `readonly` stops this write too. There is no
 * question to put to the owner here, so `ask` refuses rather than writing unasked.
 */
const writable = (context: MessengerContext, command: string, permission = LINKS_KEY) => {
  const { settings } = context
  const { level, key } = levelFor(settings.permissions, permission)
  if (level === "allow") return
  throw new CliError(
    level === "ask" ? "confirmation_required" : "permission_error",
    `profile ${settings.profile} does not let ${permission} write (permissions.${key} is ${level}, from the ` +
      `${settings.permissionSources[key ?? ""] ?? "default"}); to allow it: ` +
      `${command} ${settings.profile} config set permissions.${permission} allow`,
    { permission },
  )
}

/**
 * `embed` and its subcommands all take `--chat` and the model options, and commander gives each value to
 * the group: a subcommand reads them with the group's (`optsWithGlobals`) and checks `--chat` itself.
 */
const chatOf = ({ chat }: { chat?: string }): string => {
  if (!chat) throw new CliError("validation_error", "--chat is required: the chat whose conversations to embed")
  return chat
}

interface ModelOptions {
  model?: string
  provider?: string
  baseUrl?: string
  dims?: number
  concurrency?: number
}

const withModelOptions = (command: Command): Command =>
  command
    .option(
      "--model <model>",
      "local: a model id from `models text list` (default: e5-small); remote: the provider's model",
    )
    .option("--provider <provider>", "embed through a service with your key instead of on this machine: openai")
    .option(
      "--base-url <url>",
      "a server with OpenAI's /v1/embeddings: Gemini, Jina, or Ollama and LM Studio on this machine",
    )
    .option(
      "--dims <n>",
      "remote: the vector size — needed with --base-url; shortens an OpenAI model's",
      positiveCount("--dims"),
    )

/** A local model id, or a remote model with its key from `models text key set`. */
const choiceOf = (
  { model, provider, baseUrl, dims, concurrency }: ModelOptions,
  messenger: Messenger,
  context: MessengerContext,
  { needKey = true }: { needKey?: boolean } = {},
): ModelChoice => {
  if (provider === undefined && baseUrl === undefined) return model ?? DEFAULT_TEXT_MODEL
  if (provider !== undefined && provider !== "openai") {
    throw new CliError("validation_error", `no provider ${provider} — openai, or a server with --base-url`)
  }
  const remote = remoteModel({
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(dims ? { dims } : {}),
  })
  const keyName = baseUrl === undefined ? "openai" : new URL(baseUrl).host
  const key = embeddingKeys(messenger.app, context.env).read(keyName)?.key
  if (!key && needKey && baseUrl === undefined) {
    throw new CliError(
      "authentication_error",
      `no OpenAI key — \`${messenger.app.command} models text key set openai\`, or OPENAI_API_KEY`,
    )
  }
  return { remote, ...(key ? { apiKey: key } : {}), ...(concurrency ? { concurrency } : {}) }
}

/**
 * The messages leave the machine: say where, how much and what it may cost, and wait for a yes — `--yes`
 * in machine mode (E11). Every run asks again.
 */
const consent = async (
  command: Command,
  status: EmbedStatus,
  baseUrl: string,
  { yes, maxTokens }: { yes?: boolean; maxTokens?: number },
) => {
  if (maxTokens !== undefined && status.tokensAtMost > maxTokens) {
    throw new CliError(
      "validation_error",
      `this run could send up to ${status.tokensAtMost} tokens, above --max-tokens ${maxTokens} — nothing was sent`,
    )
  }
  const price = status.priceAtMost
    ? `, at most ${dollars(status.priceAtMost.usd)} at the price read ${status.priceAtMost.read}`
    : ""
  const what =
    `${status.left} chunks of chat ${status.chat}, up to ${status.tokensAtMost} tokens${price}, ` +
    `go to ${status.model} (${new URL(baseUrl).host})`
  if (yes) return
  const answer = await askOwner(command, `${what}. Send them? [y/N] `)
  if (answer === null) throw new CliError("confirmation_required", `${what} — add --yes to send them`)
  if (!/^y(es)?$/i.test(answer.trim())) throw new CliError("cancelled", "cancelled — nothing was sent")
}

const LINKS_KEY = "conversations.links"
const EMBED_KEY = "conversations.embed"

const dollars = (usd: number) => (usd < 0.0001 ? "under $0.0001" : `$${usd.toFixed(4)}`)

const minutes = (seconds: number) => (seconds < 90 ? `about ${seconds} s` : `about ${Math.round(seconds / 60)} min`)

/** The agent's JSON, shaped enough for the store to check the rest against the batch. */
const answerOf = (text: string): AgentAnswer => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError("validation_error", "the answer on stdin is not JSON — see `conversations links add --help`")
  }
  const answer = parsed as Partial<AgentAnswer> | null
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.answers)) {
    throw new CliError(
      "validation_error",
      'the answer needs "answers": a list of { "message", "parent", "confidence" }',
    )
  }
  return answer as AgentAnswer
}

/** `messages links`: why a message sits where it does in its conversation. */
export const linksCommand = (messenger: Messenger): Command =>
  new Command("links")
    .description("why a message is in its conversation: each link it has, and the chain of answers back to the start")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.conversations.links(chat, message))
      if (context.format !== "pretty") {
        context.renderer.result(found)
        return
      }
      if (found.links.length === 0) {
        context.renderer.note("no links: it starts a conversation, or the chat is not built — `conversations build`")
      }
      context.streams.data(
        found.links
          .map(
            (link) =>
              `${link.chosen ? "→" : " "} ${link.parentId ?? "(starts)"}  ${link.source} ${link.kind} ` +
              `${link.confidence}  ${link.method}${link.stale ? "  stale" : ""}\n`,
          )
          .join("") + (found.chain.length > 0 ? `chain: ${[message, ...found.chain].join(" ← ")}\n` : ""),
      )
    })

const line = (one: ConversationSummary) =>
  `${one.id}  ${one.firstAt.slice(0, 16).replace("T", " ")}–${one.lastAt.slice(11, 16)}  ` +
  `${one.messageCount} messages · ${one.senders} people · from message ${one.firstMessageId}`
