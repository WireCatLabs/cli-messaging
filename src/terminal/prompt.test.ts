import { PassThrough, Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import { readSecret } from "./prompt.js"

const terminal = () => Object.assign(new PassThrough(), { isTTY: true })
const collected = () => {
  const output = new PassThrough()
  const chunks: string[] = []
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()))
  return { output, text: () => chunks.join("") }
}

describe("readSecret", () => {
  it("reads a piped secret whole and trimmed, with no prompt", async () => {
    const { output, text } = collected()
    expect(await readSecret("token: ", { input: Readable.from(["abc", "def\n"]), output })).toBe("abcdef")
    expect(text()).toBe("")
  })

  it("**never echoes what is typed at a terminal**, but shows the prompt", async () => {
    const input = terminal()
    const { output, text } = collected()
    const answer = readSecret("token: ", { input, output })
    input.write("s3cret\n")

    expect(await answer).toBe("s3cret")
    expect(text()).toContain("token: ")
    expect(text()).not.toContain("s3cret")
  })

  it("echoes when asked to, for a code a person has to see", async () => {
    const input = terminal()
    const { output, text } = collected()
    const answer = readSecret("code: ", { input, output, echo: true })
    input.write("12345\n")

    expect(await answer).toBe("12345")
    expect(text()).toContain("12345")
  })

  it("is cancelled, not left waiting, when the terminal closes", async () => {
    const input = terminal()
    const answer = readSecret("token: ", { input, output: collected().output })
    input.end()

    await expect(answer).rejects.toMatchObject({ code: "cancelled" })
  })
})
