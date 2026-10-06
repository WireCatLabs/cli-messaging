import { PassThrough } from "node:stream"
import { CliError, captureStreams } from "@leemour/cli-core"
import { annotate as described } from "@leemour/cli-core/commands"
import { Argument, Command, Option } from "commander"
import { describe, expect, it, vi } from "vitest"
import { readSecret } from "../terminal/prompt.js"
import { commandContract, findCommand, resultSchemaFor } from "./command-contract.js"
import { commandsCommand } from "./commands-command.js"
import { environmentOf, outputFor } from "./context.js"
import { preview } from "./preview.js"
import { run } from "./program.js"

const app = {
  command: "fixture",
  appName: "fixture-cli",
  envPrefix: "FIXTURE",
  description: "Synthetic agent tasks",
  version: "1.2.3",
}
const configuration = {
  resolveSettings: () => ({
    profile: "default",
    keepFailedRuns: false,
    keepRunsForDays: 1,
    skillHint: false,
    permissions: {},
  }),
}

const invoke = async (
  argv: string[],
  options: Parameters<typeof run>[2] = {},
  action?: (command: Command) => Promise<void>,
) => {
  const prepare = vi.fn()
  const performed = vi.fn(async function (this: Command) {
    if (action) await action(this)
    else outputFor(this).renderer.result({ id: "synthetic", text: "synthetic payload", operationId: "op-synthetic" })
  })
  const streams = captureStreams()
  const result = await run(
    argv,
    {
      app,
      configuration,
      prepare,
      commands: () => [
        described(
          new Command("messages").addCommand(
            new Command("send").argument("<chat>").argument("[text]").action(performed),
          ),
          { mutates: true },
        ),
        commandsCommand(app),
      ],
    },
    { ...options, streams, tty: options?.tty ?? false },
  )
  return { result, prepare, performed, stdout: streams.stdout, stderr: streams.stderr }
}

describe("agent CLI contract", () => {
  it("previews without prepare, action, payload content or credential input", async () => {
    const result = await invoke(["messages", "send", "chat-synthetic", "synthetic payload", "--dry-run", "--json"])
    expect(result.result).toBe(0)
    expect(result.prepare).not.toHaveBeenCalled()
    expect(result.performed).not.toHaveBeenCalled()
    expect(result.stdout.join()).not.toContain("synthetic payload")
    expect(JSON.parse(result.stdout[0] ?? "")).toMatchObject({
      preview: true,
      effects: { actionInvoked: false, writeReserved: false },
    })
  })

  it("makes JSON on a TTY headless before a secret prompt", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true })
    const result = await invoke(
      ["messages", "send", "synthetic", "--json"],
      { tty: true, stdin: input },
      async (command) => {
        await readSecret("credential", { input: environmentOf(command).stdin })
      },
    )
    expect(result.result).toBe(2)
    expect(result.stdout).toEqual([])
    expect(JSON.parse(result.stderr[0] ?? "").error.reason).toBe("input_required")
  })

  it("allows explicit piped credentials while --no-input is set", async () => {
    const input = new PassThrough()
    input.end("synthetic credential")
    const result = await invoke(
      ["messages", "send", "synthetic", "--no-input", "--json"],
      { stdin: input },
      async (command) => {
        expect(await readSecret("credential", { input: environmentOf(command).stdin })).toBe("synthetic credential")
      },
    )
    expect(result.result).toBe(0)
  })

  it("bounds open stdin with the whole-command deadline", async () => {
    const input = new PassThrough()
    const result = await invoke(
      ["messages", "send", "synthetic", "--timeout", "5ms", "--json"],
      { stdin: input },
      async (command) => {
        await readSecret("credential", { input: environmentOf(command).stdin })
      },
    )
    expect(result.result).toBe(9)
    expect(JSON.parse(result.stderr[0] ?? "").error.code).toBe("timeout")
    expect(input.listenerCount("data")).toBe(0)
  })

  it("projects fields and fails visibly before an oversized document is emitted", async () => {
    const projected = await invoke(["messages", "send", "synthetic", "--json", "--fields", "id"])
    expect(JSON.parse(projected.stdout[0] ?? "")).toEqual({ id: "synthetic", operationId: "op-synthetic" })
    const bounded = await invoke(["messages", "send", "synthetic", "--json", "--max-output-bytes", "4"])
    expect(bounded.result).not.toBe(0)
    expect(bounded.stdout).toEqual([])
    expect(JSON.parse(bounded.stderr[0] ?? "").error).toMatchObject({ reason: "output_limit", retryable: false })
  })

  it("publishes a separately versioned schema without changing the application version", async () => {
    const result = await invoke(["commands", "schema", "messages", "send", "--json"])
    expect(result.result).toBe(0)
    expect(JSON.parse(result.stdout[0] ?? "")).toMatchObject({
      version: "1.2.3",
      schemaVersion: 1,
      path: ["messages", "send"],
      inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
    })
  })

  it("describes variadic choices on items, inherited flags, conflicts and unknown paths", () => {
    const root = new Command("fixture").option("--json")
    const leaf = new Command("probe")
      .addArgument(new Argument("<kinds...>").choices(["one", "two"]))
      .addOption(new Option("--offline").conflicts("refresh"))
      .addOption(new Option("--refresh").implies({ online: true }))
    root.addCommand(leaf)
    const contract = commandContract(findCommand(root, ["probe"]))
    expect(contract.inputSchema.properties.arguments.properties.kinds).toMatchObject({
      type: "array",
      items: { enum: ["one", "two"] },
    })
    expect(contract.validation.conflicts).toEqual([["offline", "refresh"]])
    expect(contract.validation.implications).toHaveLength(1)
    expect(() => findCommand(root, ["absent"])).toThrow("unknown command path")
    expect(resultSchemaFor(["messages", "list"]).coverage).toBe("declared-domain-fields")
    expect(resultSchemaFor(["stats", "messages", "show"]).coverage).toBe("declared")
    expect(resultSchemaFor(["tasks", "list"]).coverage).toBe("collection-with-open-items")
  })
})

it("refuses preview of denied source data and write paths before exposing targets", () => {
  const root = new Command("fixture")
  const stats = new Command("stats").addCommand(new Command("messages").addCommand(new Command("show")))
  root.addCommand(stats)
  const leaf = findCommand(root, ["stats", "messages", "show"])
  expect(() => preview(leaf, { messages: "deny" })).toThrow("messages")
  expect(() => preview(leaf, { "messages.stats": "deny" })).toThrow("config migrate")
  root.addCommand(new Command("messages").addCommand(new Command("send")))
  expect(() => preview(findCommand(root, ["messages", "send"]), { messages: "readonly" })).toThrow("does not permit")
})

it("honors the whole-command timeout environment and explicit flag precedence", async () => {
  const hung = await invoke(
    ["messages", "send", "synthetic", "--json"],
    { env: { ...process.env, FIXTURE_TIMEOUT: "5ms" } },
    async () => new Promise(() => {}),
  )
  expect(hung.result).toBe(9)
  expect(hung.stderr.join()).toContain("5ms")
  const overridden = await invoke(
    ["messages", "send", "synthetic", "--json", "--timeout", "100ms"],
    { env: { ...process.env, FIXTURE_TIMEOUT: "5ms" } },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      throw new CliError("not_found", "synthetic")
    },
  )
  expect(overridden.result).toBe(6)
})
