import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { toMarkdown } from "../../render/markdown.js"
import { renderMessages } from "../../render/messages.js"
import { renderList } from "../paging.js"
import { fetchCommand, jobsCommand } from "./backfill-command.js"
import { type Messenger, messengerContext } from "./context.js"
import { momentOf } from "./inbox.js"
import { storeMaintenanceCommands } from "./store-maintenance-command.js"

/** `store`: the local store of messages — what it holds, filling it, reading it out, and looking after the file. */
export const storeCommand = (messenger: Messenger): Command => {
  const store = new Command("store")
    .description("the local store of messages")
    .addCommand(statusCommand(messenger))
    .addCommand(fetchCommand(messenger))
    .addCommand(jobsCommand(messenger))
    .addCommand(exportCommand(messenger))
  for (const command of storeMaintenanceCommands(messenger)) store.addCommand(command)
  return store
}

/**
 * What the local store holds, per chat — read from the store alone. Whether a fetch reached a
 * chat's very first message is not recorded, so it is not claimed: the stretches held are shown.
 */
const statusCommand = (messenger: Messenger): Command =>
  new Command("status")
    .description("per chat: messages stored, the oldest and newest, and the stretches held completely")
    .argument("[chat]", messenger.chatArgument)
    .action(async function (this: Command, chat: string | undefined) {
      const context = messengerContext(this, messenger)
      const rows = await context.withServices((services) => services.archive.status(chat))
      renderList(context.renderer, context.format, rows)
      if (rows.length === 0) context.renderer.note("the store holds no messages for this profile yet")
    })

/**
 * One chat's stored messages, oldest first — `--jsonl` for a file or a pipe, one message per line,
 * `--format markdown` for a transcript a person reads.
 */
const exportCommand = (messenger: Messenger): Command =>
  new Command("export")
    .description("a chat's stored messages as JSON lines, oldest first; never asks the messenger")
    .argument("<chat>", messenger.chatArgument)
    .option(
      "--format <format>",
      "jsonl (the default): one message per line; markdown: a transcript with a heading per day, replies and forwards quoted",
    )
    .option("--since <time>", "only from this ISO 8601 time, or 30m / 2h / 1d ago, on")
    .option("--output <file>", "write JSON lines, or the transcript, to this new file, readable only by you")
    .action(async function (this: Command, chat: string) {
      const { format, since, output } = this.opts<{ format?: string; since?: string; output?: string }>()
      if (format !== undefined && format !== "markdown" && format !== "jsonl") {
        throw new CliError("validation_error", `--format is jsonl or markdown, not "${format}"`)
      }
      const from = since === undefined ? undefined : new Date(momentOf(since)).toISOString()
      const context = messengerContext(this, messenger)
      const { title, messages } = await context.withServices((services) =>
        services.archive.export(chat, from === undefined ? {} : { since: from }),
      )
      if (output !== undefined) {
        const path = resolve(output)
        const body =
          format === "markdown"
            ? toMarkdown(title, messages)
            : messages.map((message) => `${JSON.stringify(message)}\n`).join("")
        try {
          writeFileSync(path, body, { flag: "wx", mode: 0o600 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new CliError("validation_error", `${path} exists — an export never overwrites a file`)
          throw error
        }
        context.renderer.result({ path, format: format ?? "jsonl", count: messages.length })
        return
      }
      if (format === "markdown") context.streams.data(toMarkdown(title, messages).replace(/\n$/, ""))
      else if (format === "jsonl" || context.format === "jsonl")
        for (const message of messages) context.streams.data(JSON.stringify(message))
      else if (context.format === "json") context.renderer.result({ items: messages })
      else
        context.streams.data(
          renderMessages(messages, {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
            locale: messenger.app.locale,
          }),
        )
      context.renderer.note(`${messages.length} messages`)
    })
