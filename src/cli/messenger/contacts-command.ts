import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { phoneOf } from "../../services/index.js"
import { readSecret } from "../../terminal/prompt.js"
import { renderPage, window, withPaging } from "../paging.js"
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

  return contacts
}
