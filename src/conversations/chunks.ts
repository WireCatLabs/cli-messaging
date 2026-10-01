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

/** A chunk's text from its messages, as the build cut it: what is hashed and what the model reads. */
export const chunkTextOf = (lines: ChunkLine[]): string =>
  lines
    .filter(({ text }) => text.trim())
    .map(lineOf)
    .join("\n")

export const chunkHash = (text: string): string => createHash("sha256").update(text).digest("hex")

/**
 * A conversation, oldest message first, cut at message boundaries into chunks of at most `limit`
 * characters. A message longer than the limit is a chunk of its own; the model cuts it further.
 * Messages with no text add nothing, and a conversation of only those has no chunk.
 */
export const cutChunks = (members: ChunkLine[], limit = CHUNK_CHARS): Chunk[] => {
  const chunks: Chunk[] = []
  let open: ChunkLine[] = []
  let size = 0
  const close = () => {
    const first = open[0]
    const last = open.at(-1)
    if (!first || !last) return
    const text = chunkTextOf(open)
    chunks.push({ firstId: first.id, lastId: last.id, text, hash: chunkHash(text) })
    open = []
    size = 0
  }
  for (const member of members) {
    if (!member.text.trim()) continue
    const length = lineOf(member).length
    if (open.length > 0 && size + 1 + length > limit) close()
    size += (open.length > 0 ? 1 : 0) + length
    open.push(member)
  }
  close()
  return chunks
}
