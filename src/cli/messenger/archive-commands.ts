import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { toMarkdown } from "../../render/markdown.js"
import { renderMessages } from "../../render/messages.js"
import { type Messenger, messengerContext } from "./context.js"
import { storedChatId } from "./messages-command.js"

/**
 * What the local store holds, per chat — read from the store alone. Whether a backfill reached a
 * chat's very first message is not recorded, so it is not claimed: the stretches held are shown.
 */
export const syncCommand = (messenger: Messenger): Command =>
  new Command("sync").description("what the local store holds").addCommand(
    new Command("status")
      .description("per chat: messages stored, the oldest and newest, and the stretches held completely")
      .argument("[chat]", messenger.chatArgument)
      .action(async function (this: Command, chat: string | undefined) {
        const context = messengerContext(this, messenger)
        const rows = await context.withStore(async (store, account) => {
          const only = chat === undefined ? undefined : await storedChatId(messenger, chat, store, account)
          const stats = await store.chatStats(account, only)
          return Promise.all(stats.map(async (one) => ({ ...one, held: await store.ranges(account, one.chatId) })))
        })
        context.renderer.stream(rows)
        if (rows.length === 0) context.renderer.note("the store holds no messages for this profile yet")
      }),
  )

/**
 * One chat's stored messages, oldest first — `--jsonl` for a file or a pipe, one message per line,
 * `--format markdown` for a transcript a person reads.
 */
export const exportCommand = (messenger: Messenger): Command =>
  new Command("export")
    .description("a chat's stored messages as JSON lines, oldest first; never asks the messenger")
    .argument("<chat>", messenger.chatArgument)
    .option("--format <format>", "markdown: a transcript with a heading per day, replies and forwards quoted")
    .action(async function (this: Command, chat: string) {
      const { format } = this.opts<{ format?: string }>()
      if (format !== undefined && format !== "markdown") {
        throw new CliError(
          "validation_error",
          `--format knows markdown, not "${format}" — --json and --jsonl give data`,
        )
      }
      const context = messengerContext(this, messenger)
      const { title, messages } = await context.withStore(async (store, account) => {
        const chatId = await storedChatId(messenger, chat, store, account)
        return {
          title: (await store.chatStats(account, chatId))[0]?.title ?? chatId,
          messages: (await store.messages(account, chatId, { limit: Number.MAX_SAFE_INTEGER })).items,
        }
      })
      if (format === "markdown") context.streams.data(toMarkdown(title, messages).replace(/\n$/, ""))
      else if (context.format === "json") context.renderer.result({ items: messages })
      else if (context.format === "jsonl") for (const message of messages) context.streams.data(JSON.stringify(message))
      else
        context.streams.data(
          renderMessages(messages, {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
          }),
        )
      context.renderer.note(`${messages.length} messages`)
    })
