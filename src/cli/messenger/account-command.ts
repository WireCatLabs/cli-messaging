import { Command } from "commander"
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
    .addCommand(accountSessionsCommand(messenger))
