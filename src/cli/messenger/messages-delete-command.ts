import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import type { Deletion } from "../../domain/models.js"
import type { SendGuard } from "../../sends/guard.js"
import { guardedWrite } from "../../sends/guarded.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability, type MessengerAdapter } from "./port.js"

/** max-cli's: many at once is what a ban for automation looks like. */
export const DELETE_AT_ONCE = 10

/**
 * ⚠ **`--allow-dangerous` is required** and nothing asks instead: a deletion cannot be undone, and a
 * prompt is one Enter away from it. For everyone only with `--for-everyone` (max-cli `NEED-238`, `NEED-239`).
 */
export const deleteCommand = (messenger: Messenger): Command =>
  annotate(new Command("delete"), { mutates: true })
    .description("delete messages for you only; with --for-everyone, for everyone in the chat")
    .argument("<chat>", messenger.chatArgument)
    .argument("<messages...>", `the message ids, at most ${DELETE_AT_ONCE}`)
    .option("--for-everyone", "delete for everyone in the chat, not only for you — they cannot get it back")
    .option("--allow-dangerous", "yes, delete — it cannot be undone")
    .action(async function (this: Command, chat: string, messages: string[]) {
      const context = messengerContext(this, messenger)
      const { forEveryone, allowDangerous } = this.opts<{ forEveryone?: boolean; allowDangerous?: boolean }>()
      const everyone = forEveryone === true
      if (allowDangerous !== true) {
        throw new CliError(
          "confirmation_required",
          `this deletes ${messages.length === 1 ? "a message" : `${messages.length} messages`} ` +
            `${everyone ? "for everyone in the chat" : "for you"}, and it cannot be undone — ` +
            "add --allow-dangerous to go ahead",
        )
      }
      context.renderer.result(
        await context.withMessenger((connection) =>
          guardedDelete(context.guard, connection, {
            chat,
            messages: messages.map((one) => one.trim()),
            forEveryone: everyone,
          }),
        ),
      )
    })

/** Each message counts toward the hourly limit. */
export const guardedDelete = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, messages, forEveryone }: { chat: string; messages: string[]; forEveryone: boolean },
): Promise<Deletion> => {
  if (messages.length > DELETE_AT_ONCE) {
    throw new CliError("validation_error", `at most ${DELETE_AT_ONCE} messages at once, got ${messages.length}`)
  }
  const remove = capability(connection, "delete", "delete messages")
  const { id: chatId } = await connection.resolve(chat)
  await guardedWrite(guard, { chatId, kind: "delete", count: messages.length, forEveryone }, () =>
    remove(chatId, messages, { forEveryone }),
  )
  return { chatId, deleted: messages, forEveryone }
}
