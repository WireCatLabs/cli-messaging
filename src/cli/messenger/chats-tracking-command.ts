import { Command } from "commander"
import { TRACKED_DAYS } from "../../services/chats.js"
import { listed } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

/** The chats whose member lists `serve` fetches daily; kept in the local store, never sent. */
export const trackingCommand = (messenger: Messenger): Command => {
  const tracking = new Command("tracking").description(
    "the chats whose member lists serve fetches daily into the local store — chats members fetch --track adds one",
  )

  tracking
    .command("list")
    .description("every tracked chat: since when, and its last member count")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.chats.tracked())
      if (context.format === "pretty") {
        context.renderer.stream(
          found.map(({ chatId, title, trackedAt, lastCount }) => ({
            chat: title ? `${title} (${chatId})` : chatId,
            since: trackedAt.slice(0, 10),
            last: lastCount
              ? `${lastCount.day}: ${lastCount.participants ?? "?"}${lastCount.complete ? "" : " (partial)"}`
              : "",
          })),
        )
        return
      }
      if (context.format === "jsonl") context.renderer.stream(found)
      else context.renderer.result({ ...listed(found), hasMore: false })
    })

  tracking
    .command("show")
    .description(`one chat: whether it is tracked, and its member count per day for the last ${TRACKED_DAYS} days`)
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.chats.trackedChat(chat)))
    })

  for (const [verb, tracked, description] of [
    ["add", true, "fetch this chat's member list daily while serve runs, from its next run"],
    ["remove", false, "stop fetching it daily; the history already kept stays"],
  ] as const) {
    tracking
      .command(verb)
      .description(description)
      .argument("<chat>", messenger.chatArgument)
      .action(async function (this: Command, chat: string) {
        const context = messengerContext(this, messenger)
        refuseLocalWrite(context, messenger.app.command, `chats.tracking.${verb}`)
        context.renderer.result(await context.withServices((services) => services.chats.track(chat, tracked)))
      })
  }

  return tracking
}
