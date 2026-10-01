import { Worker } from "node:worker_threads"
import type { Embedder, Kind } from "./embed.js"
import type { TextModel } from "./models.js"

/** `workers` worker threads, each with its own session on `threads` threads; texts are split between them. */
export const openWorkers = async (
  model: TextModel,
  directory: string,
  { workers, threads }: { workers: number; threads: number },
): Promise<Embedder> => {
  const pending = new Map<number, { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void }>()
  const started = await Promise.allSettled(
    Array.from({ length: workers }, () => {
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        workerData: { model, directory, threads },
      })
      return new Promise<Worker>((resolve, reject) => {
        worker.once("error", reject)
        worker.once("message", (first) => {
          if (first !== "ready") return reject(new Error("the embedding worker did not start"))
          worker.off("error", reject)
          worker.on("message", ({ id, vectors, error }: { id: number; vectors?: Float32Array[]; error?: string }) => {
            const job = pending.get(id)
            pending.delete(id)
            if (error !== undefined || !vectors) job?.reject(new Error(error ?? "no vectors"))
            else job?.resolve(vectors)
          })
          resolve(worker)
        })
      })
    }),
  )
  const pool = started.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
  const failed = started.find((result) => result.status === "rejected")
  if (failed) {
    await Promise.all(pool.map((worker) => worker.terminate()))
    throw failed.reason
  }
  let next = 0
  const run = (worker: Worker, texts: string[], kind: Kind) =>
    new Promise<Float32Array[]>((resolve, reject) => {
      const id = next++
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, texts, kind })
    })

  return {
    model,
    embed: async (texts, kind) => {
      const share = Math.ceil(texts.length / pool.length)
      const parts = await Promise.all(
        pool.map((worker, index) => run(worker, texts.slice(index * share, (index + 1) * share), kind)),
      )
      return parts.flat()
    },
    close: async () => {
      await Promise.all(pool.map((worker) => worker.terminate()))
    },
  }
}
