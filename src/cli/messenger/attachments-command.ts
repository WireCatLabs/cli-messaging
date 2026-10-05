import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { engineHint } from "../../attachments/extract.js"
import type { ExtractItem, ExtractRun } from "../../services/attachments.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { downloadMessage } from "./download-command.js"
import { stopOnSignal } from "./patience.js"

const count = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}

const line = ({ status, locator, attachment, name, chars }: ExtractItem) =>
  `${status}  ${locator} #${attachment}${name ? `  ${name}` : ""}${chars === undefined ? "" : `  (${chars} characters)`}`

const summary = (run: ExtractRun) =>
  [
    `${run.extracted} extracted`,
    run.needsAgent ? `${run.needsAgent} for an agent to read (attachments text set)` : "",
    run.failed ? `${run.failed} unreadable` : "",
    run.unchanged ? `${run.unchanged} unchanged` : "",
    run.notDownloaded ? `${run.notDownloaded} not downloaded (--download)` : "",
    run.complete ? "" : "run it again to continue",
  ]
    .filter(Boolean)
    .join(", ")

const extractCommand = (messenger: Messenger): Command =>
  new Command("extract")
    .description(
      "read the text of downloaded files — plain text, Word, PDF with a text layer — into the local store, for content: in a search",
    )
    .option("--chat <chat>", `only this chat's files; ${messenger.chatArgument}`)
    .option("--download", "first save the files no download saved yet, from the messenger, into --output-dir")
    .option("--output-dir <dir>", "with --download, where to save them; created if missing")
    .option("--limit <n>", "read at most this many files; run it again to continue", count)
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "attachments.extract")
      const { chat, download, outputDir, limit } = this.opts<{
        chat?: string
        download?: boolean
        outputDir?: string
        limit?: number
      }>()
      if (download && outputDir === undefined)
        throw new CliError("validation_error", "--download saves the files first: name the folder with --output-dir")
      if (outputDir !== undefined && !download)
        throw new CliError("validation_error", "--output-dir is where --download saves; add --download")
      const stop = stopOnSignal(this)
      try {
        const run = await context.withServices((services) =>
          services.attachments.extract({
            ...(chat === undefined ? {} : { chat }),
            ...(limit === undefined ? {} : { limit }),
            ...(download && outputDir !== undefined
              ? {
                  download: async (chatId, messageId) => {
                    await downloadMessage(services.messages, chatId, messageId, outputDir, context.renderer.warn)
                  },
                }
              : {}),
            signal: stop.signal,
            onItem: (item) => {
              if (context.format === "pretty") context.streams.data(`${line(item)}\n`)
              else if (context.format === "jsonl") context.renderer.stream([item])
            },
          }),
        )
        for (const engine of run.enginesMissing) context.renderer.note(engineHint(engine, messenger.app.command))
        if (context.format === "json") context.renderer.result(run)
        else context.renderer.note(summary(run))
      } finally {
        stop.release()
      }
    })

/** Files of stored messages: what is in them, for `content:` in a search. Nothing here is sent. */
export const attachmentsCommand = (messenger: Messenger): Command =>
  new Command("attachments")
    .description("the files of stored messages: their text in the local store, for content: in a search")
    .addCommand(extractCommand(messenger))
