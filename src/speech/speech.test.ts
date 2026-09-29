import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@leemour/cli-core"
import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import { install, isInstalled, modelPath, vadPath } from "./install.js"
import { DEFAULT_ORDER, orderedModels, type SpeechModel, speechModel, VAD } from "./models.js"
import { SAMPLE_RATE, toModelRate } from "./recognize.js"
import { type Choice, choose, hearLocally, hearOnline } from "./transcribe.js"

vi.mock("./recognize.js", async (original) => ({
  ...(await original<typeof import("./recognize.js")>()),
  openRecognizer: () => ({
    recognize: (pcm: Float32Array) => `heard ${pcm.length > SAMPLE_RATE ? "speech" : "nothing"}`,
    free: () => {},
  }),
}))

const tone = new Uint8Array(readFileSync(new URL("../testing/fixtures/tone.ogg", import.meta.url)))
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

const tiny: SpeechModel = {
  id: "tiny",
  title: "tiny",
  languages: "none",
  featureDim: 64,
  files: [{ name: "model.onnx", url: "https://example.test/model.onnx", sha256: sha("weights"), bytes: 7 }],
  config: () => ({}),
}

const directoryWithVad = () => {
  const directory = mkdtempSync(join(tmpdir(), "models-"))
  writeFileSync(vadPath(directory), new Uint8Array(VAD.bytes))
  return directory
}

/** Every file of the model at its pinned size — what `isInstalled` checks. */
const installed = (model: SpeechModel) => {
  const directory = directoryWithVad()
  mkdirSync(join(directory, model.id))
  for (const file of model.files) writeFileSync(modelPath(directory, model)(file.name), new Uint8Array(file.bytes))
  return directory
}

const serving = (body: string) => async () => new Response(body)

describe("installing a speech model", () => {
  it("**refuses a file whose sha256 is not the pinned one**, and leaves nothing behind", async () => {
    const directory = directoryWithVad()

    await expect(install(tiny, directory, { fetch: serving("Weights") })).rejects.toThrow(/not the file/)

    expect(isInstalled(tiny, directory)).toBe(false)
    expect(readdirSync(join(directory, "tiny"))).toEqual([])
  })

  it("stops reading a file that runs past its pinned size", async () => {
    const directory = directoryWithVad()

    await expect(install(tiny, directory, { fetch: serving("weights and more") })).rejects.toThrow(/larger than/)
  })

  it("installs a file that matches, and does not fetch it twice", async () => {
    const directory = directoryWithVad()
    let fetched = 0
    const fetch = async () => {
      fetched++
      return new Response("weights")
    }

    await install(tiny, directory, { fetch })
    await install(tiny, directory, { fetch })

    expect(isInstalled(tiny, directory)).toBe(true)
    expect(fetched).toBe(1)
  })
})

describe("audio for the model", () => {
  it("averages 48 kHz down to 16 kHz behind half a second of silence", () => {
    const pcm = toModelRate(new Float32Array([0.3, 0.3, 0.3, 0.6, 0.6, 0.6]), 48_000)

    expect(pcm.length).toBe(SAMPLE_RATE / 2 + 2)
    expect([...pcm.subarray(SAMPLE_RATE / 2)].map((sample) => sample.toFixed(2))).toEqual(["0.30", "0.60"])
  })
})

describe("which model", () => {
  const messenger = (speechModels?: string[]) =>
    ({ app: { command: "chat" }, provider: "chat", speechModels }) as Messenger
  const none = { configured: {}, shared: {} }

  it("**puts Parakeet first unless the CLI names its own order**", () => {
    expect(orderedModels().map((model) => model.id)).toEqual(DEFAULT_ORDER)
    expect(orderedModels(["gigaam-v3"]).map((model) => model.id)).toEqual(["gigaam-v3", "parakeet-v3", "gigaam-v3-ctc"])
    expect(choose(messenger(), none, {}).model.id).toBe("parakeet-v3")
    expect(choose(messenger(["gigaam-v3"]), none, {}).model.id).toBe("gigaam-v3")
  })

  it("takes the flag over the profile, and the profile over the CLI's order", () => {
    const profile = { configured: { speechModel: "gigaam-v3-ctc", transcribeWith: "messenger" }, shared: {} }

    expect(choose(messenger(), profile, {})).toMatchObject({ with: "messenger", model: { id: "gigaam-v3-ctc" } })
    expect(choose(messenger(), profile, { model: "gigaam-v3" })).toMatchObject({
      with: "local",
      model: { id: "gigaam-v3" },
    })
    expect(choose(messenger(), none, { local: true }).with).toBe("local")
    expect(() => choose(messenger(), none, { model: "whisper" })).toThrow(/no speech model "whisper"/)
  })
})

describe("hearing a voice message", () => {
  const messenger = { app: { command: "chat" }, provider: "chat" } as Messenger
  const voice = {
    kind: "voice",
    mime: "audio/ogg",
    bytes: async function* () {
      yield tone
    },
  }
  const adapter = (transcribe?: MessengerAdapter["transcribe"]) =>
    ({ transcribe, download: async () => ({ files: [voice], skipped: [] }) }) as unknown as MessengerAdapter
  const choice = (overrides: Partial<Choice> = {}): Choice => ({
    with: "auto",
    model: speechModel("parakeet-v3"),
    directory: installed(speechModel("parakeet-v3")),
    ...overrides,
  })
  const refusing = async () => {
    throw new CliError("permission_error", "no Premium")
  }

  it("**asks the messenger first**, and says so", async () => {
    const heard = await hearOnline(
      messenger,
      adapter(async () => ({ text: "hi", pending: false })),
      "7",
      "5",
      choice(),
    )

    expect(heard).toEqual({ messageId: "5", text: "hi", pending: false, via: "chat" })
  })

  it("**falls back to the model on this machine when the messenger refuses the account**", async () => {
    const bytes = await hearOnline(messenger, adapter(refusing), "7", "5", choice())

    expect(bytes).toEqual(tone)
    expect(await hearLocally(bytes as Uint8Array, "5", choice())).toEqual({
      messageId: "5",
      text: "heard speech",
      pending: false,
      via: "local",
      model: "parakeet-v3",
    })
  })

  it("never asks the messenger with --local, and never falls back when told to use the messenger", async () => {
    let asked = false
    const counting = adapter(async () => {
      asked = true
      return { text: "", pending: false }
    })

    expect(await hearOnline(messenger, counting, "7", "5", choice({ with: "local" }))).toEqual(tone)
    expect(asked).toBe(false)
    await expect(hearOnline(messenger, adapter(refusing), "7", "5", choice({ with: "messenger" }))).rejects.toThrow(
      "no Premium",
    )
  })

  it("**names the download command instead of downloading** a missing model", async () => {
    await expect(
      hearOnline(messenger, adapter(refusing), "7", "5", choice({ directory: directoryWithVad() })),
    ).rejects.toThrow(/chat models audio download parakeet-v3/)
  })
})
