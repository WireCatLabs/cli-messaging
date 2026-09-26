import { captureStreams } from "@leemour/cli-core"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { baseContext } from "./context.js"
import { run } from "./program.js"
import { settingsFor } from "./settings.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "A test CLI", version: "1.2.3" }
const { resolveSettings } = settingsFor(app)

/** An error as another copy of cli-core builds it: the same name and code, a different class. */
const foreignFailure = (code: string, message: string) =>
  Object.assign(new Error(message), { name: "CliError", code, details: { candidates: [{ id: "1" }] } })

const definition = (action: (command: Command) => Promise<void>) => ({
  app,
  commands: () => [
    new Command("chats").addCommand(
      new Command("list").action(async function (this: Command) {
        await action(this)
      }),
    ),
  ],
})

const call = async (argv: string[], action: (command: Command) => Promise<void> = async () => {}) => {
  const streams = captureStreams()
  const code = await run(argv, definition(action), { streams, tty: false, env: {} })
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

describe("running a messenger CLI", () => {
  it("**knows a CliError built by another copy of cli-core**, and keeps its code and details", async () => {
    const { code, stdout, stderr } = await call(["chats", "list"], async () => {
      throw foreignFailure("validation_error", '"Va" matches 2 chats')
    })

    expect(code).toBe(2)
    expect(stdout).toEqual([])
    expect(JSON.parse(stderr[0] ?? "").error).toMatchObject({
      code: "validation_error",
      candidates: [{ id: "1" }],
    })
  })

  it("answers a profile with no command after it with a validation error, not help on stdout", async () => {
    const { code, stdout, stderr } = await call(["personal"])

    expect(code).toBe(2)
    expect(stdout).toEqual([])
    expect(stderr[0]).toContain("read as a profile name")
  })

  it("hands the first word to the command as its profile", async () => {
    let profile = ""
    await call(["work", "chats", "list"], async (command) => {
      profile = baseContext(command, resolveSettings).settings.profile
    })
    expect(profile).toBe("work")
  })

  it("writes a subcommand's help to the injected stdout, not the terminal", async () => {
    const { code, stdout } = await call(["chats", "--help"])

    expect(code).toBe(0)
    expect(stdout.join("\n")).toContain("list")
  })

  it("says which word was read as a profile when the command after it is unknown", async () => {
    const { code, stderr } = await call(["chat", "list"])

    expect(code).toBe(1)
    expect(stderr.join("\n")).toContain('"chat" is not a command')
  })

  it("**closes what the command tracked when --timeout expires**, then reports a timeout", async () => {
    let closed = false
    const { code, stderr } = await call(["--timeout", "20ms", "chats", "list"], async (command) => {
      const context = baseContext(command, resolveSettings)
      await context.run(async () => {
        context.track({
          close: async () => {
            closed = true
          },
        })
        await new Promise(() => {})
      })
    })

    expect(closed).toBe(true)
    expect(code).toBe(9)
    expect(JSON.parse(stderr[0] ?? "").error.code).toBe("timeout")
  })
})
