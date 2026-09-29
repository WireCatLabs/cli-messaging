import { createWriteStream, mkdirSync } from "node:fs"
import { link, rm } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { CliError } from "@leemour/cli-core"
import type { Command } from "commander"
import { type Messenger, messengerContext } from "./context.js"
import { capability, type RemoteFile } from "./port.js"

export interface Saved {
  kind: string
  path: string
  bytes: number
}

/** `messages download`: every file of one message, into a folder, never over a file already there. */
export const downloadSubcommand = (messages: Command, messenger: Messenger): Command =>
  messages
    .command("download")
    .description("save a message's photos, files, videos and voice notes to a folder")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .option("--output <dir>", "where to save them; created if missing", ".")
    .action(async function (this: Command, chat: string, messageId: string) {
      const context = messengerContext(this, messenger)
      const { output } = this.opts<{ output: string }>()
      const id = messageId.trim()
      const saved = await context.withMessenger(async (connection) => {
        const { files, skipped } = await capability(connection, "download", "download attachments")(chat, id)
        if (skipped.length > 0) context.renderer.note(`not a file, not downloaded: ${skipped.join(", ")}`)
        if (files.length === 0) throw new CliError("not_found", `message ${id} has no file to download`)
        mkdirSync(output, { recursive: true })
        const done: Saved[] = []
        for (const [index, file] of files.entries()) done.push(await save(file, output, `${id}-${index + 1}`))
        return done
      })
      if (context.format === "pretty") context.streams.data(`${saved.map((one) => one.path).join("\n")}\n`)
      else if (context.format === "jsonl") context.renderer.stream(saved)
      else context.renderer.result({ items: saved })
    })

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
}

/** Telegram sends a photo with no name and no type; it is always a JPEG. */
const BY_KIND: Record<string, string> = { photo: "jpg" }

/**
 * A name another person chose cannot climb out of the folder, cannot be a dot file we would then
 * hide, and carries no control or direction character to rewrite the terminal or disguise its extension.
 */
export const safeName = (name: string | undefined): string | undefined => {
  const plain =
    name === undefined
      ? ""
      : basename(name.replaceAll("\\", "/"))
          .replace(/[\p{Cc}​-‏‪-‮⁦-⁩]/gu, "")
          .replace(/^\.+/, "")
  return plain === "" ? undefined : plain
}

/**
 * The bytes go to a temporary name first and are then hard-linked to the real one, which fails if the
 * name is taken — so an existing file survives, and an interrupted download leaves no half file under
 * the name somebody will open.
 */
export const save = async (file: RemoteFile, directory: string, fallbackName: string): Promise<Saved> => {
  const extension = EXTENSIONS[file.mime ?? ""] ?? BY_KIND[file.kind]
  const name = safeName(file.name) ?? (extension ? `${fallbackName}.${extension}` : fallbackName)
  const path = resolve(join(directory, name))
  const partial = join(directory, `.${name}.${process.pid}.part`)
  let bytes = 0
  const counting = new Transform({
    transform(chunk: Uint8Array, _encoding, done) {
      bytes += chunk.length
      done(null, chunk)
    },
  })
  try {
    await pipeline(Readable.from(file.bytes()), counting, createWriteStream(partial, { flags: "wx", mode: 0o600 }))
    await link(partial, path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") {
        throw new CliError("validation_error", `${path} already exists — nothing was overwritten; choose --output`)
      }
      throw error
    })
    return { kind: file.kind, path, bytes }
  } finally {
    await rm(partial, { force: true })
  }
}
