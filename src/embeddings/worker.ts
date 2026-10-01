import { parentPort, workerData } from "node:worker_threads"
import { type Kind, openEmbedder } from "./embed.js"
import type { TextModel } from "./models.js"

const { model, directory, threads } = workerData as { model: TextModel; directory: string; threads: number }
const embedder = await openEmbedder(model, directory, { threads })
const port = parentPort
if (!port) throw new Error("run as a worker")

port.on("message", async (job: { id: number; texts: string[]; kind: Kind } | "close") => {
  if (job === "close") {
    await embedder.close()
    port.close()
    return
  }
  try {
    port.postMessage({ id: job.id, vectors: await embedder.embed(job.texts, job.kind) })
  } catch (error) {
    port.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) })
  }
})
port.postMessage("ready")
