import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { readUpload } from "../../sends/upload.js"
import { maskedAccount } from "../../services/people.js"
import { accountSessionsCommand } from "./account-sessions-command.js"
import { type Messenger, messengerContext } from "./context.js"

export const accountCommand = (messenger: Messenger): Command =>
  new Command("account")
    .description("the logged-in account")
    .addCommand(
      new Command("show")
        .description("who this profile is logged in as; the phone number shows its last four digits")
        .option("--show-phone", "print the whole phone number")
        .action(async function (this: Command) {
          const whole = this.opts<{ showPhone?: boolean }>().showPhone === true
          const context = messengerContext(this, messenger)
          const account = await context.withMessenger((connection) => connection.me())
          context.renderer.result(whole ? account : maskedAccount(account))
        }),
    )
    .addCommand(
      annotate(new Command("update"), { mutates: true })
        .description("change the name, the description or the photo everyone sees on your profile")
        .option("--first-name <name>", "your first name")
        .option("--last-name <name>", "your last name")
        .option("--description <text>", "about you")
        .option("--photo <file>", "a new profile photo — an image file")
        .action(async function (this: Command) {
          const context = messengerContext(this, messenger)
          const { firstName, lastName, description, photo } = this.opts<{
            firstName?: string
            lastName?: string
            description?: string
            photo?: string
          }>()
          const upload =
            photo === undefined ? undefined : await readUpload("photo", photo, { app: messenger.app, env: context.env })
          context.renderer.result(
            await context.withServices((services) =>
              services.account.update({
                ...(firstName === undefined ? {} : { firstName }),
                ...(lastName === undefined ? {} : { lastName }),
                ...(description === undefined ? {} : { description }),
                ...(upload === undefined ? {} : { photo: upload }),
              }),
            ),
          )
        }),
    )
    .addCommand(accountSessionsCommand(messenger))
