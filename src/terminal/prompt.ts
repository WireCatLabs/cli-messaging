import { createInterface } from "node:readline"
import { Writable } from "node:stream"
import { CliError } from "@leemour/cli-core"

export interface SecretInput {
  input?: NodeJS.ReadableStream & { isTTY?: boolean }
  output?: NodeJS.WritableStream
  /** For a phone number or an SMS code, which a person needs to see while typing. */
  echo?: boolean
  /** Cancels pending input without closing the caller's stream. */
  signal?: AbortSignal
}

/**
 * One line of secret, taken without a file and without argv.
 *
 * A token on a command line is read by `ps` and kept by shell history; a token in a file is a
 * second copy nobody remembers to delete. Both are avoided by never letting it land anywhere: it
 * is typed or piped, goes straight to the keyring, and is never echoed.
 *
 * The prompt goes to **stderr**, not stdout, so that `session start --json` still writes one JSON
 * value and nothing else.
 */
export const readSecret = async (
  prompt: string,
  { input = process.stdin, output = process.stderr, echo = false, signal }: SecretInput = {},
): Promise<string> => {
  const cancelled = () => new CliError("cancelled", "cancelled — nothing was stored")
  if (signal?.aborted) throw cancelled()
  if (!input.isTTY) {
    if (signal) {
      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        const cleanup = () => {
          input.off("data", data).off("end", end).off("error", error).off("close", abort)
          signal.removeEventListener("abort", abort)
        }
        const data = (chunk: Buffer | string) => chunks.push(Buffer.from(chunk))
        const end = () => {
          cleanup()
          resolve(Buffer.concat(chunks).toString("utf8").trim())
        }
        const error = (cause: Error) => {
          cleanup()
          reject(cause)
        }
        const abort = () => {
          cleanup()
          input.pause()
          reject(cancelled())
        }
        input.on("data", data).once("end", end).once("error", error).once("close", abort)
        signal.addEventListener("abort", abort, { once: true })
      })
    }
    const chunks: Buffer[] = []
    for await (const chunk of input) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString("utf8").trim()
  }

  let muted = false
  const shim = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk)
      done()
    },
  })

  const reader = createInterface({ input, output: shim, terminal: true })
  const abort = () => reader.close()
  try {
    // Ctrl-C and a closed terminal would otherwise leave this waiting for ever, and Node exits
    // on the unsettled promise with a warning and a code nobody documents.
    const answer = await new Promise<string>((resolve, reject) => {
      const cancel = () => reject(cancelled())
      reader.once("SIGINT", cancel)
      reader.once("close", cancel)
      signal?.addEventListener("abort", abort, { once: true })
      reader.question(prompt, resolve)
      muted = !echo
    })
    return answer.trim()
  } finally {
    signal?.removeEventListener("abort", abort)
    reader.close()
    output.write("\n")
  }
}
