import { Command } from "commander"
import { FloodMemory, floodPathFor } from "../../sends/flood.js"
import { DEFAULT_PACE, Pacer, pacePathFor } from "../../sends/pace.js"
import { type Messenger, messengerContext } from "./context.js"

/**
 * The owner's way out of a remembered wait or a hold on writes, once they know it is over. No MCP
 * tool on purpose: an agent that could lift a hold would send straight into a spam limit again.
 */
export const floodCommand = (messenger: Messenger): Command => {
  const { app } = messenger
  const name = messenger.name ?? app.command
  return new Command("flood")
    .description(`the waits ${name} asked this profile to keep, and a hold on its writes`)
    .addCommand(
      new Command("clear")
        .description(
          `forget them, lift the hold and the profile's pace, once ${name} no longer limits the account; changes nothing there`,
        )
        .action(function (this: Command) {
          const context = messengerContext(this, messenger)
          const { profile } = context
          const { deadlines, sendBlock } = new FloodMemory(floodPathFor(app, profile, context.env)).clear()
          new Pacer(pacePathFor(app, profile, context.env), DEFAULT_PACE).reset()
          const value = { profile, cleared: { deadlines, sendBlock: sendBlock ?? null } }
          if (context.format !== "pretty") {
            context.renderer.result(value)
            return
          }
          const waits = deadlines.map(
            (one) =>
              `- the wait before ${one.operation}${one.chatId ? ` in chat ${one.chatId}` : ""}, until ${one.until}`,
          )
          const hold = sendBlock ? [`- the hold on writes (${sendBlock.state}), until ${sendBlock.until}`] : []
          context.streams.data(
            waits.length + hold.length === 0
              ? `Nothing to clear for profile ${profile}.`
              : [`Cleared for profile ${profile}:`, ...hold, ...waits].join("\n"),
          )
        }),
    )
}
