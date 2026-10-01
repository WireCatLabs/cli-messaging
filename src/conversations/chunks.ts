import { createHash } from "node:crypto"
import type { Id } from "../domain/models.js"

/**
 * ~300 tokens: e5's tokenizer reads 3.7 characters a token in Russian and 4.0 in English
 * (phase 5 E1). Characters, not tokens, so a chunk is the same whatever model embeds it.
 */
export const CHUNK_CHARS = 1_200

export interface ChunkLine {
  id: Id
  sender: string | null
  text: string
}

export interface Chunk {
  firstId: Id
  lastId: Id
  /** What the model is given; never stored, only its hash. */
  text: string
  hash: string
}

const lineOf = ({ sender, text }: ChunkLine) => (sender ? `${sender}: ${text}` : text)

export const chunkHash = (text: string): string => createHash("sha256").update(text).digest("hex")

/**
 * A conversation, oldest message first, cut at message boundaries into chunks of at most `limit`
 * characters. A message longer than the limit is a chunk of its own; the model cuts it further.
 * Messages with no text add nothing, and a conversation of only those has no chunk.
 */
export const cutChunks = (members: ChunkLine[], limit = CHUNK_CHARS): Chunk[] => {
  const chunks: Chunk[] = []
  let lines: string[] = []
  let first: Id | undefined
  let last: Id | undefined
  let size = 0
  const close = () => {
    if (first === undefined || last === undefined) return
    const text = lines.join("\n")
    chunks.push({ firstId: first, lastId: last, text, hash: chunkHash(text) })
    lines = []
    first = undefined
    size = 0
  }
  for (const member of members) {
    if (!member.text.trim()) continue
    const line = lineOf(member)
    if (first !== undefined && size + 1 + line.length > limit) close()
    lines.push(line)
    size += (lines.length > 1 ? 1 : 0) + line.length
    first ??= member.id
    last = member.id
  }
  close()
  return chunks
}
