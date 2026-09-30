// Hides a share of the reply links in a real store and counts how many the rules find again. Prints
// counts per chat key only — never a title, a name or a message.
// Usage: node --experimental-strip-types holdout.ts <messages.db> [share=0.2] [min messages=200]
import { DatabaseSync } from "node:sqlite"
import { type LinkInput, linkMessages } from "../../src/conversations/link.ts"

const [path, shareArg = "0.2", minArg = "200"] = process.argv.slice(2)
if (!path) throw new Error("usage: holdout.ts <messages.db> [share] [min messages]")
const share = Number(shareArg)
const db = new DatabaseSync(path, { readOnly: true })

let seed = 42
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
  return seed / 2 ** 31
}

const chats = db
  .prepare("SELECT chat_pk FROM messages WHERE deleted_at IS NULL GROUP BY chat_pk HAVING count(*) >= ?")
  .all(Number(minArg)) as { chat_pk: number }[]

for (const { chat_pk } of chats) {
  const rows = db
    .prepare(
      `SELECT m.native_id, m.sender_identity_pk, m.text, m.sent_at, m.reply_to_native_id, m.thread_native_id, i.username
       FROM messages m LEFT JOIN identities i ON i.pk = m.sender_identity_pk
       WHERE m.chat_pk = ? AND m.deleted_at IS NULL ORDER BY m.sent_at, m.pk`,
    )
    .all(chat_pk) as Record<string, string | number | null>[]
  const held = new Set(rows.map((row) => String(row.native_id)))
  const handles = new Map<string, string>()
  const hidden = new Map<string, string>()
  const messages: LinkInput[] = rows.map((row) => {
    const id = String(row.native_id)
    const senderId = row.sender_identity_pk === null ? null : String(row.sender_identity_pk)
    if (senderId && typeof row.username === "string") handles.set(row.username.toLowerCase(), senderId)
    let replyToId = row.reply_to_native_id === null ? undefined : String(row.reply_to_native_id)
    if (replyToId && held.has(replyToId) && random() < share) {
      hidden.set(id, replyToId)
      replyToId = undefined
    }
    const sentAt = Number(row.sent_at)
    return {
      id,
      senderId,
      text: String(row.text ?? ""),
      timestamp: new Date(sentAt > 1e11 ? sentAt : sentAt * 1000).toISOString(),
      ...(replyToId ? { replyToId } : {}),
      ...(row.thread_native_id === null ? {} : { threadId: String(row.thread_native_id) }),
    }
  })
  const { parents } = linkMessages(messages, { handles })
  let right = 0
  let wrong = 0
  for (const [id, parent] of hidden) {
    const found = parents.get(id)
    if (found === parent) right++
    else if (found !== null) wrong++
  }
  const none = hidden.size - right - wrong
  const pct = (n: number) => (hidden.size ? ((100 * n) / hidden.size).toFixed(1) : "0")
  console.log(
    `chat ${chat_pk}: ${rows.length} messages, ${hidden.size} replies hidden — found ${right} (${pct(right)}%), wrong ${wrong} (${pct(wrong)}%), none ${none} (${pct(none)}%)`,
  )
}
