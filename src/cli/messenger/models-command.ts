import { Command } from "commander"
import {
  install,
  installedBytes,
  isInstalled,
  megabytes,
  modelPath,
  modelsDirectory,
  vadPath,
} from "../../speech/install.js"
import { orderedModels, speechModel, VAD } from "../../speech/models.js"
import { choose } from "../../speech/transcribe.js"
import { baseContext } from "../context.js"
import type { Messenger } from "./context.js"

/**
 * Models that run on this machine, by what they work on; `audio` is the speech models behind
 * `messages transcribe --local`. Nothing here talks to the messenger. The folder is shared by every
 * messenger CLI, so a model downloaded once serves them all.
 */
export const modelsCommand = (messenger: Messenger): Command => {
  const models = new Command("models").description("models that run on this machine")
  const audio = models.command("audio").description("speech models for transcribing voice messages")

  audio
    .command("list")
    .description("the speech models, most suitable first, which are downloaded, and which one is the default")
    .action(async function (this: Command) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        const directory = modelsDirectory(context.env)
        const chosen = choose(messenger, context.settings, {}, context.env).model.id
        const items = orderedModels(messenger.speechModels).map((model) => ({
          id: model.id,
          title: model.title,
          languages: model.languages,
          size: megabytes(installedBytes(model)),
          downloaded: isInstalled(model, directory),
          default: model.id === chosen,
        }))
        if (context.format === "pretty") {
          const line = (item: (typeof items)[number]) =>
            `${item.default ? "*" : " "} ${item.id.padEnd(14)} ${item.size.padStart(7)}  ${item.downloaded ? "downloaded" : "—".padEnd(10)}  ${item.languages}`
          context.streams.data(`${items.map(line).join("\n")}\n`)
        } else if (context.format === "jsonl") context.renderer.stream(items)
        else context.renderer.result({ items, directory })
      })
    })

  audio
    .command("download")
    .argument("<model>", "a model id from `models audio list`")
    .description("download a speech model once, checked against the sha256 this version expects")
    .action(async function (this: Command, id: string) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(
        async () => {
          const model = speechModel(id)
          const directory = modelsDirectory(context.env)
          if (!isInstalled(model, directory)) {
            context.renderer.note(
              `${model.id}: ${megabytes(installedBytes(model) + VAD.bytes)} from Hugging Face and GitHub`,
            )
            await install(model, directory, { progress: (line) => context.renderer.note(line) })
          }
          // Loading is the test — the files, the WebAssembly engine and the memory it needs — on a
          // second of silence, since no recording ships with the package.
          context.renderer.note(`${model.id}: loading it once to check it works`)
          const { openRecognizer, SAMPLE_RATE } = await import("../../speech/recognize.js")
          const recognizer = openRecognizer(model, modelPath(directory, model), vadPath(directory))
          try {
            recognizer.recognize(new Float32Array(SAMPLE_RATE))
          } finally {
            recognizer.free()
          }
          context.renderer.result({ id: model.id, downloaded: true, works: true, directory })
        },
        { unbounded: true },
      )
    })

  return models
}
