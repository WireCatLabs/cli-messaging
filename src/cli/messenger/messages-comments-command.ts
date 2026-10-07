import { Command } from "commander"
import { renderMessages } from "../../render/messages.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

export const commentsCommand = (messenger: Messenger): Command =>
  new Command("comments")
    .description("the comments under a channel post, oldest to newest; they live in its discussion group")
    .argument("<chat>", `the channel: ${messenger.chatArgument}`)
    .argument("<post>", "the post's message id in the channel")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--before-id <id>", "only comments older than this comment id")
    .action(async function (this: Command, chat: string, post: string) {
      const context = messengerContext(this, messenger)
      const { beforeId } = this.opts<{ beforeId?: string }>()
      const { limit } = context.settings
      const found = await context.withServices((services) =>
        services.messages.comments(chat, post, { limit, ...(beforeId === undefined ? {} : { before: beforeId }) }),
      )
      const more = `older comments: --before-id ${found.items[0]?.id}`
      if (context.format === "pretty") {
        context.streams.data(
          renderMessages(found.items, {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
            locale: messenger.app.locale,
          }),
        )
      } else if (context.format === "jsonl") context.renderer.stream(found.items)
      else context.renderer.result({ discussion: found.discussion, items: found.items, hasMore: found.hasMore })
      if (found.hasMore) context.renderer.note(more)
    })
