import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it, vi } from "vitest"
import { modelPath, modelsDirectory, vadPath } from "../../speech/install.js"
import { speechModel, VAD } from "../../speech/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { modelsCommand } from "./models-command.js"

let recognized = 0
vi.mock("../../speech/recognize.js", async (original) => ({
  ...(await original<typeof import("../../speech/recognize.js")>()),
  openRecognizer: () => ({
    recognize: () => {
      recognized++
      return ""
    },
    free: () => {},
  }),
}))

/** A sparse file at the pinned size — what `isInstalled` checks — without writing hundreds of MB. */
const sized = (path: string, bytes: number) => {
  writeFileSync(path, "")
  truncateSync(path, bytes)
}

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const call = async (argv: string[], speechModels?: string[], tty = false) => {
  const root = mkdtempSync(join(tmpdir(), "models-"))
  const env = {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    CLI_COMMON_CACHE_DIR: join(root, "cache"),
  }
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("models never connect")
    },
    chatArgument: "a chat",
    ...(speechModels ? { speechModels } : {}),
  }
  const place = (id: string) => {
    const model = speechModel(id)
    const directory = modelsDirectory(env)
    mkdirSync(join(directory, model.id), { recursive: true })
    sized(vadPath(directory), VAD.bytes)
    for (const file of model.files) sized(modelPath(directory, model)(file.name), file.bytes)
  }
  const go = async () => {
    const streams = captureStreams()
    const code = await run(argv, { app, commands: () => [modelsCommand(messenger)] }, { streams, tty, env })
    return { code, stdout: streams.stdout, stderr: streams.stderr }
  }
  return { go, place, env }
}

describe("models audio", () => {
  it("**checks a downloaded model works** by loading it, and fetches nothing it already has", async () => {
    const { go, place, env } = await call(["models", "audio", "download", "gigaam-v3-ctc", "--json"])
    place("gigaam-v3-ctc")

    const { code, stdout } = await go()

    expect(code).toBe(0)
    expect(JSON.parse(stdout[0] ?? "")).toEqual({
      id: "gigaam-v3-ctc",
      downloaded: true,
      works: true,
      directory: modelsDirectory(env),
    })
    expect(recognized).toBe(1)
  })

  it("refuses a model it does not know, naming the ones it does", async () => {
    const { go } = await call(["models", "audio", "download", "whisper"])
    const { code, stderr } = await go()

    expect(code).not.toBe(0)
    expect(stderr.join("")).toContain("parakeet-v3")
  })

  it("**lists the CLI's own order**, marking the downloaded ones and the default", async () => {
    const { go, place } = await call(["models", "audio", "list"], ["gigaam-v3"], true)
    place("gigaam-v3")

    const lines = (await go()).stdout.join("").trim().split("\n")

    expect(lines.map((line) => line.slice(0, 16).trim())).toEqual(["* gigaam-v3", "parakeet-v3", "gigaam-v3-ctc"])
    expect(lines[0]).toContain("downloaded")
  })
})
