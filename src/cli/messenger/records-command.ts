import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { MEDIA_KINDS, type MediaKind } from "../../domain/models.js"
import { positiveCount, renderPage } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability } from "./port.js"

const kindsOf = (typed: string | undefined): MediaKind[] => {
  const kinds = typed === undefined ? [...MEDIA_KINDS] : typed.split(",").map((kind) => kind.trim())
  for (const kind of kinds) {
    if (!(MEDIA_KINDS as readonly string[]).includes(kind))
      throw new CliError("validation_error", `--type takes ${MEDIA_KINDS.join(", ")}, not "${kind}"`)
  }
  return kinds as MediaKind[]
}

/** `chats media` — what a chat's gallery shows, asked of the server, so it finds what was never fetched. */
export const mediaCommand = (messenger: Messenger): Command =>
  new Command("media")
    .description("a chat's photos, videos, files, audio and links, from the messenger's server; reading marks nothing")
    .argument("<chat>", messenger.chatArgument)
    .option("--type <names>", `only these kinds, comma-separated: ${MEDIA_KINDS.join(", ")}`)
    .option("--limit <n>", "how many to show", positiveCount("--limit"))
    .option("--before-id <id>", "read what came before this message id")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { type, beforeId } = this.opts<{ type?: string; beforeId?: string }>()
      const kinds = kindsOf(type)
      const limit = context.settings.limit
      const page = await context.withMessenger(async (adapter) => {
        const { id } = await adapter.resolve(chat)
        return capability(
          adapter,
          "media",
          "list a chat's media",
        )(id, {
          kinds,
          limit,
          ...(beforeId === undefined ? {} : { before: beforeId }),
        })
      })
      renderPage(
        { ...context, settings: { page: 1, limit, all: false } },
        page,
        undefined,
        (items) => `more — \`--before-id ${items[0]?.id ?? ""}\` for older`,
      )
    })

/** `calls list` — the account's call history, newest first. */
export const callsCommand = (messenger: Messenger): Command => {
  const calls = new Command("calls").description("the account's calls")
  calls
    .command("list")
    .description("calls made and received, newest first; reading changes nothing")
    .option("--limit <n>", "how many to show", positiveCount("--limit"))
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const limit = context.settings.limit
      const page = await context.withMessenger((adapter) => capability(adapter, "calls", "list calls")({ limit }))
      renderPage({ ...context, settings: { page: 1, limit, all: false } }, page)
    })
  return calls
}

/** `account privacy` — who may find, call or invite the account, as the messenger reports it. */
export const privacyCommand = (messenger: Messenger): Command => {
  const privacy = new Command("privacy").description("who may find, call or add the account")
  privacy
    .command("show")
    .description("the account's privacy settings; reading changes nothing")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withMessenger((adapter) => capability(adapter, "privacy", "read privacy settings")()),
      )
    })
  return privacy
}
