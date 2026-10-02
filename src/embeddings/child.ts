import { createInterface } from "node:readline"
import { type Kind, openEmbedder } from "./embed.js"
import type { TextModel } from "./models.js"

const { model, directory, threads } = JSON.parse(process.argv[2] ?? "{}") as {
  model: TextModel
  directory: string
  threads: number
}
const embedder = await openEmbedder(model, directory, { threads })
// stdout carries the answers alone, one JSON line each: anything else there breaks the parent's reading.
const answer = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`)
answer({ ready: true })
for await (const line of createInterface({ input: process.stdin })) {
  const { id, texts, kind } = JSON.parse(line) as { id: number; texts: string[]; kind: Kind }
  try {
    answer({ id, vectors: (await embedder.embed(texts, kind)).map((vector) => Array.from(vector)) })
  } catch (error) {
    answer({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
await embedder.close()
process.exit(0)
