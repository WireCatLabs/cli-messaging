import { Command } from "commander"
import { type Messenger, messengerContext } from "./context.js"

export const accountCommand = (messenger: Messenger): Command =>
  new Command("account").description("the logged-in account").addCommand(
    new Command("show").description("who this profile is logged in as").action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withMessenger((connection) => connection.me()))
    }),
  )
