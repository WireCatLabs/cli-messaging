import { Command } from "commander"
import { renderMessages } from "../../render/messages.js"
import { storedChatId } from "./commands.js"
import { type Messenger, messengerContext } from "./context.js"

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
        const rows = await context.withStore((store, account) => {
          const only = chat === undefined ? undefined : storedChatId(messenger, chat, store, account)
          return store
            .chatStats(account, only)
            .map((stats) => ({ ...stats, held: store.ranges(account, stats.chatId) }))
        })
        context.renderer.stream(rows)
        if (rows.length === 0) context.renderer.note("the store holds no messages for this profile yet")
      }),
  )

/** One chat's stored messages, oldest first — `--jsonl` for a file or a pipe, one message per line. */
export const exportCommand = (messenger: Messenger): Command =>
  new Command("export")
    .description("a chat's stored messages as JSON lines, oldest first; never asks the messenger")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const messages = await context.withStore(
        (store, account) =>
          store.messages(account, storedChatId(messenger, chat, store, account), { limit: Number.MAX_SAFE_INTEGER })
            .items,
      )
      if (context.format === "json") context.renderer.result({ items: messages })
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
