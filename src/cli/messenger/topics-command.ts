import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
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

  annotate(topics.command("enable"), { mutates: true })
    .description("enable forum topics; only the owner, with an explicit upgrade for a basic group")
    .argument("<chat>", messenger.chatArgument)
    .option("--upgrade", "upgrade a basic group to a supergroup first; its chat id changes")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withServices((services) =>
          services.topics.enable(chat, { upgrade: this.opts<{ upgrade?: boolean }>().upgrade === true }),
        ),
      )
    })
  annotate(topics.command("create"), { mutates: true })
    .description("create a named topic in an existing forum; never enable or upgrade a group implicitly")
    .argument("<chat>", messenger.chatArgument)
    .argument("<title>", "the topic title, at most 128 UTF-8 bytes")
    .option("--send-id <id>", "repeat an unknown creation with the same id, without a second topic")
    .action(async function (this: Command, chat: string, title: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withServices((services) => services.topics.create(chat, title, this.opts<{ sendId?: string }>())),
      )
    })
  return topics
}
