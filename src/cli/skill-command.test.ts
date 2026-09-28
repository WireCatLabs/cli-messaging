import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import { run } from "./program.js"
import { skillCommand } from "./skill-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test CLI", version: "1.0.0" }

const show = async (argv: string[]) => {
  const file = join(mkdtempSync(join(tmpdir(), "skill-")), "SKILL.md")
  writeFileSync(file, "---\nname: chat-cli\n---\n\n# chat\n\n")
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [skillCommand(app, pathToFileURL(file))] },
    { streams, tty: false },
  )
  return { code, stdout: streams.stdout }
}

describe("skill show", () => {
  it("prints the file itself into a pipe, so a redirect installs it", async () => {
    const { code, stdout } = await show(["skill", "show"])

    expect(code).toBe(0)
    expect(stdout).toEqual(["---\nname: chat-cli\n---\n\n# chat"])
  })

  it("answers JSON when asked for it by name", async () => {
    const { stdout } = await show(["skill", "show", "--json"])

    expect(JSON.parse(stdout[0] ?? "")).toEqual({ name: "chat-cli", content: "---\nname: chat-cli\n---\n\n# chat" })
  })
})
