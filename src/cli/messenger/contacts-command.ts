import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { phoneOf } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { CONTEXT_BYTES, CONTEXT_MESSAGES } from "../../services/person-context.js"
import { readSecret } from "../../terminal/prompt.js"
import { positiveCount, renderPage, window, withPaging } from "../paging.js"
import { contactWriteCommands } from "./admin-contacts-command.js"
import { type Messenger, messengerContext } from "./context.js"

/** People this account has a one-to-one chat with, as the people service counts them. */
export const contactsCommand = (messenger: Messenger): Command => {
  const contacts = new Command("contacts").description("people this account has a one-to-one chat with")

  contacts.addCommand(
    withPaging(new Command("list").description("people you have a one-to-one chat with"))
      .option("--order <recent|name>", "newest conversation first, or alphabetical", "recent")
      .option("--search <text>", "only people whose name or @username contains this")
      .action(async function (this: Command) {
        const { order, search } = this.opts<{ order: string; search?: string }>()
        if (order !== "recent" && order !== "name") {
          throw new CliError("validation_error", `--order is recent or name, not "${order}"`)
        }
        const context = messengerContext(this, messenger)
        const found = await context.withServices((services) =>
          services.people.list({ order, ...(search ? { search } : {}), ...window(context.settings) }),
        )
        renderPage(context, found)
      }),
  )

  contacts
    .command("show")
    .description("one person and the chats you share with them")
    .argument("<person>", "their id, @username, or part of their name")
    .action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.people.show(person)))
    })

  contacts
    .command("context")
    .description(
      "what the store holds about one person, in every messenger linked to them: shared chats, the last " +
        "messages each way, their recent messages, where others mentioned them — never connects",
    )
    .argument("<person>", "their id, @username, or part of their name")
    .option(
      "--limit <n>",
      `at most this many messages in each list; ${CONTEXT_MESSAGES} if not given`,
      positiveCount("--limit"),
    )
    .option("--since-time <time>", "nothing older than this ISO 8601 time, or 2h / 1d ago")
    .action(async function (this: Command, person: string) {
      const { limit, sinceTime } = this.opts<{ limit?: number; sinceTime?: string }>()
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) =>
        services.people.context(person, {
          messages: limit ?? CONTEXT_MESSAGES,
          bytes: CONTEXT_BYTES,
          ...(sinceTime === undefined ? {} : { since: momentOf(sinceTime, "--since-time") }),
        }),
      )
      for (const chat of found.notRead) {
        context.renderer.note(
          `${chat.title ?? chat.chatId}: ${chat.reason === "not_fetched" ? "nothing" : "only part"} of it is stored — ` +
            `\`${messenger.app.command} store fetch ${chat.chatId}\``,
        )
      }
      if (found.hasMore) context.renderer.note("cut at --limit; a larger one shows more")
      context.renderer.result(found)
    })

  contacts
    .command("link")
    .description("record that two people in the store are one person — the same name is never enough")
    .argument("<person>", "their id, @username, or part of their name")
    .argument("<other>", "the same in another messenger of the store, as <messenger>:<person> — max:Ana")
    .action(async function (this: Command, person: string, other: string) {
      const context = messengerContext(this, messenger)
      const linked = await context.withServices((services) => services.people.link(person, other))
      context.renderer.result(linked)
      context.renderer.success(`${linked.identities.length} identities are now one person`)
    })

  contacts
    .command("unlink")
    .description("undo contacts link for one identity: it is a person of its own again")
    .argument("<person>", "their id, @username, or part of their name; <messenger>:<person> for another messenger")
    .action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.people.unlink(person)))
    })

  /**
   * ⚠ **The number is asked for or piped, never an argument**: argv is read by `ps` and kept by shell
   * history, and a phone number is personal data.
   */
  contacts
    .command("lookup")
    .description("who has this phone number — asks for it, or reads it from stdin; never an argument")
    // Commander's own refusal would repeat the number on stderr.
    .allowExcessArguments()
    .action(async function (this: Command) {
      if (this.args.length > 0) {
        throw new CliError(
          "validation_error",
          "the phone number is never an argument — pipe it in, or type it when asked",
        )
      }
      const context = messengerContext(this, messenger)
      const phone = phoneOf(await readSecret("phone number: ", { input: context.stdin, echo: true }))
      context.renderer.result(await context.withServices((services) => services.people.lookup(phone)))
    })

  contacts
    .command("sync")
    .description("take the whole contact list from the messenger into the local store")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const summary = await context.withServices((services) => services.people.sync())
      context.renderer.result(summary)
      context.renderer.success(`${summary.added} new, ${summary.changed} changed, ${summary.known} people known`)
    })

  for (const command of contactWriteCommands(messenger)) contacts.addCommand(command)
  return contacts
}
