import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { renderPage, window, withPaging } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability } from "./port.js"

/** `topics list|search` — a forum group's topics, with the ids its messages carry as `threadId`. */
export const topicsCommand = (messenger: Messenger): Command => {
  const topics = new Command("topics").description("the topics of a forum group")

  const listed = async function (this: Command, chat: string) {
    const [, query] = this.args
    const context = messengerContext(this, messenger)
    if (context.settings.offline) {
      throw new CliError("validation_error", "`topics` asks the messenger; not with --offline")
    }
    const wanted = { ...window(context.settings), ...(query ? { search: query } : {}) }
    renderPage(
      context,
      await context.withMessenger((adapter) => capability(adapter, "topics", "list forum topics")(chat, wanted)),
    )
  }

  topics.addCommand(
    withPaging(
      new Command("list")
        .description("a forum group's topics, newest activity first")
        .argument("<chat>", messenger.chatArgument),
    ).action(listed),
  )
  topics.addCommand(
    withPaging(
      new Command("search")
        .description("a forum group's topics whose title matches")
        .argument("<chat>", messenger.chatArgument)
        .argument("<text>", "words from the topic's title"),
    ).action(listed),
  )

  return topics
}
