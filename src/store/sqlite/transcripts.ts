import type { Id } from "../../domain/models.js"
import { and, eq, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { transcripts } from "./schema.js"

export const transcript = ({ orm }: StoreContext, chatKey: number, messageId: Id) =>
  orm
    .select({ text: transcripts.text, source: transcripts.source })
    .from(transcripts)
    .where(and(eq(transcripts.chatPk, chatKey), eq(transcripts.messageNativeId, messageId)))
    .get()

export const keepTranscript = (
  { orm, now }: StoreContext,
  chatKey: number,
  messageId: Id,
  text: string,
  source: string,
): void => {
  orm
    .insert(transcripts)
    .values({ chatPk: chatKey, messageNativeId: messageId, text, source, heardAt: now() })
    .onConflictDoUpdate({
      target: [transcripts.chatPk, transcripts.messageNativeId],
      set: { text: sql`excluded.text`, source: sql`excluded.source`, heardAt: sql`excluded.heard_at` },
    })
    .run()
}
