import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import type { Id } from "../../domain/models.js"
import type { SendGuard } from "../../sends/guard.js"
import { guardedWrite } from "../../sends/guarded.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability, type MessengerAdapter } from "./port.js"

export interface MarkedRead {
  chatId: Id
  /** `null`: up to the newest message. */
  until: Id | null
}

export const markReadCommand = (messenger: Messenger): Command =>
  annotate(new Command("mark-read"), { mutates: true })
    .description("mark a chat read; the other side sees that you read it")
    .argument("<chat>", messenger.chatArgument)
    .option("--until <message>", "only up to this message id; the newest by default")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { until } = this.opts<{ until?: string }>()
      context.renderer.result(
        await context.withMessenger((connection) =>
          guardedMarkRead(context.guard, connection, { chat, ...(until === undefined ? {} : { until: until.trim() }) }),
        ),
      )
    })

/** One path for `chats mark-read` and the MCP tool. Never counts toward the hourly limit. */
export const guardedMarkRead = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, until }: { chat: string; until?: string },
): Promise<MarkedRead> => {
  const markRead = capability(connection, "markRead", "mark a chat read")
  const { id: chatId } = await connection.resolve(chat)
  await guardedWrite(guard, { chatId, kind: "read", ...(until === undefined ? {} : { messageId: until }) }, () =>
    markRead(chatId, until),
  )
  return { chatId, until: until ?? null }
}
