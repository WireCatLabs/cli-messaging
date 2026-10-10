import type { Id } from "../../domain/models.js"
import { and, eq, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { messageTranscripts } from "./schema.js"

export const transcript = ({ orm }: StoreContext, chatKey: number, messageId: Id) =>
  orm
    .select({ text: messageTranscripts.text, source: messageTranscripts.source })
    .from(messageTranscripts)
    .where(and(eq(messageTranscripts.chatId, chatKey), eq(messageTranscripts.messageExternalId, messageId)))
    .get()

export const keepTranscript = (
  { orm, database, now }: StoreContext,
  chatKey: number,
  messageId: Id,
  text: string,
  source: string,
): void => {
  const message = database
    .prepare("SELECT id, deleted_at FROM messages WHERE chat_id=? AND external_id=?")
    .get(chatKey, messageId)
  if (message?.deleted_at != null) return
  orm
    .insert(messageTranscripts)
    .values({
      messageId: message ? Number(message.id) : null,
      chatId: chatKey,
      messageExternalId: messageId,
      text,
      source,
      heardAt: now(),
      createdAt: now(),
      updatedAt: now(),
    })
    .onConflictDoUpdate({
      target: [messageTranscripts.chatId, messageTranscripts.messageExternalId],
      set: {
        text: sql`excluded.text`,
        source: sql`excluded.source`,
        heardAt: sql`excluded.heard_at`,
        updatedAt: sql`excluded.updated_at`,
        messageId: sql`coalesce(excluded.message_id, ${messageTranscripts.messageId})`,
      },
    })
    .run()
}
