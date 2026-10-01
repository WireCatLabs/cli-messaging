import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { link, rm } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { CliError } from "@leemour/cli-core"
import type { Command } from "commander"
import type { Id } from "../../domain/models.js"
import { patiently } from "../../services/patience.js"
import { parseDuration } from "../settings.js"
import { type Messenger, type MessengerContext, messengerContext } from "./context.js"
import { stopOnSignal } from "./patience.js"
import { capability, type MessengerAdapter, type RemoteFile } from "./port.js"

export interface Saved {
  kind: string
  path: string
  bytes: number
  /** Only with `--all`: the file was already there from an earlier run, and was left as it was. */
  existing?: true
}

/** `messages download`: every file of one message, or with `--all` of a whole chat, never over a file already there. */
export const downloadSubcommand = (messages: Command, messenger: Messenger): Command =>
  messages
    .command("download")
    .description("save a message's photos, files, videos and voice notes to a folder — or a whole chat's with --all")
    .argument("<chat>", messenger.chatArgument)
    .argument("[message]", "the message id; left out with --all")
    .option("--output <dir>", "where to save them; created if missing", ".")
    .option("--all", "every file of the chat, newest first; run it again to continue where it stopped")
    .option("--pause <duration>", "with --all, a pause between pages, to stay under the provider's limits", "1s")
    .action(async function (this: Command, chat: string, messageId: string | undefined) {
      const context = messengerContext(this, messenger)
      const { output, all, pause } = this.opts<{ output: string; all?: boolean; pause: string }>()
      if (all && messageId !== undefined) {
        throw new CliError("validation_error", "--all saves the whole chat; leave out the message id")
      }
      if (all) {
        await downloadChat(this, context, chat, output, parseDuration(pause, "--pause"))
        return
      }
      if (messageId === undefined) throw new CliError("validation_error", "name a message id, or use --all")
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

/** The most messages a provider hands out per history request — Telegram's cap. */
const PAGE = 100

/** Attachments that are never a file, so their messages cost no download request. */
const NOT_FILES = new Set(["webpage", "share", "poll", "location", "contact"])

interface Stretch {
  from: number
  to: number
}

/**
 * Stretches of message ids already walked, in a dot file beside the files — not in the store, which
 * this would need a migration for. Written after every message with a file, so a run cut short by
 * `--timeout` or Ctrl-C repeats at most the file it was in the middle of.
 */
const progressFile = (output: string, chatId: Id) => join(output, `.download-${chatId.replace(/[^\w-]/g, "_")}.json`)

const readProgress = (path: string): Stretch[] => {
  if (!existsSync(path)) return []
  const { done } = JSON.parse(readFileSync(path, "utf8")) as { done?: Stretch[] }
  return Array.isArray(done) ? done : []
}

const writeProgress = (path: string, chatId: Id, done: Stretch[]) => {
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ chat: chatId, done })}\n`, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

const downloadChat = async (
  command: Command,
  context: MessengerContext,
  chat: string,
  output: string,
  pauseMs: number,
) => {
  const items: Saved[] = []
  const onSaved = (one: Saved) => {
    if (context.format === "pretty") context.streams.data(`${one.path}\n`)
    else if (context.format === "jsonl") context.renderer.stream([one])
    else items.push(one)
  }
  const stop = stopOnSignal(command)
  try {
    mkdirSync(output, { recursive: true })
    const result = await context.withMessenger((connection) =>
      walkChat(connection, chat, { output, pauseMs, stop: stop.signal, note: context.renderer.note, onSaved }),
    )
    if (context.format === "json") context.renderer.result({ items, ...result })
    else context.renderer.note(summary(result))
  } finally {
    stop.release()
  }
}

const summary = ({ saved, existing, complete }: { saved: number; existing: number; complete: boolean }) =>
  `${saved} saved${existing > 0 ? `, ${existing} already there` : ""}${complete ? " — the whole chat" : " — run it again to continue"}`

interface ChatWalk {
  output: string
  pauseMs: number
  stop: AbortSignal
  note: (message: string) => void
  onSaved: (one: Saved) => void
}

/**
 * Newest to oldest, page by page. A stretch an earlier run walked is jumped over, and joins this run's,
 * so the progress file stays a few stretches however often the download is cut and resumed.
 */
const walkChat = async (
  connection: MessengerAdapter,
  chat: string,
  { output, pauseMs, stop, note, onSaved }: ChatWalk,
) => {
  const download = capability(connection, "download", "download attachments")
  let before: string | undefined
  let chatId: Id | undefined
  let path = ""
  let done: Stretch[] = []
  let run: Stretch | undefined
  let saved = 0
  let existing = 0
  let complete = false
  const remember = () => {
    if (chatId !== undefined) writeProgress(path, chatId, run ? [...done, run] : done)
  }

  pages: while (!stop.aborted) {
    const page = await patiently(
      () => connection.history(chat, { limit: PAGE, ...(before ? { before } : {}) }),
      note,
      stop,
    )
    const first = page.items[0]
    if (!first) {
      complete = true
      break
    }
    if (chatId === undefined) {
      chatId = first.chatId
      path = progressFile(output, chatId)
      done = readProgress(path)
    }
    const newestFirst = page.items.map((message) => ({ message, key: Number(message.id) }))
    if (newestFirst.some(({ key }) => !Number.isSafeInteger(key))) {
      throw new CliError("validation_error", "this messenger's message ids do not order a chat, so --all cannot resume")
    }
    newestFirst.sort((a, b) => b.key - a.key)
    for (const { message, key } of newestFirst) {
      if (stop.aborted) break pages
      const walked = done.find(({ from, to }) => from <= key && key <= to)
      if (walked) {
        done = done.filter((one) => one !== walked)
        run = { from: walked.from, to: Math.max(run?.to ?? walked.to, walked.to) }
        remember()
        before = String(walked.from)
        continue pages
      }
      if (message.attachments.some(({ kind }) => !NOT_FILES.has(kind))) {
        const { files } = await patiently(() => download(chat, message.id), note, stop)
        for (const [index, file] of files.entries()) {
          const one = await patiently(
            () => save(file, output, `${message.id}-${index + 1}`, { unique: true }),
            note,
            stop,
          )
          if (one.existing) existing += 1
          else saved += 1
          onSaved(one)
        }
        run = { from: key, to: run?.to ?? key }
        remember()
      } else run = { from: key, to: run?.to ?? key }
    }
    remember()
    if (!page.hasMore) {
      complete = true
      break
    }
    before = String(newestFirst.at(-1)?.key)
    note(`${saved} files so far, back to message ${before}`)
    await sleep(pauseMs, undefined, { signal: stop }).catch(() => {})
  }
  remember()
  return { chat: chatId ?? null, saved, existing, complete, ...(stop.aborted ? { stopped: true } : {}) }
}

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
 *
 * `unique` is for a whole chat, where two messages often carry the same file name: a taken name gets the
 * message's own prefix, and when that is taken too the file was saved by an earlier run and is `existing`.
 */
export const save = async (
  file: RemoteFile,
  directory: string,
  fallbackName: string,
  { unique = false }: { unique?: boolean } = {},
): Promise<Saved> => {
  const extension = EXTENSIONS[file.mime ?? ""] ?? BY_KIND[file.kind]
  const own = safeName(file.name)
  const name = own ?? (extension ? `${fallbackName}.${extension}` : fallbackName)
  const names = unique && own ? [name, `${fallbackName}-${own}`] : [name]
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
    for (const candidate of names) {
      const path = resolve(join(directory, candidate))
      const taken = await link(partial, path).then(
        () => false,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") return true
          throw error
        },
      )
      if (!taken) return { kind: file.kind, path, bytes }
    }
    const path = resolve(join(directory, names.at(-1) ?? name))
    if (unique) return { kind: file.kind, path, bytes, existing: true }
    throw new CliError("validation_error", `${path} already exists — nothing was overwritten; choose --output`)
  } finally {
    await rm(partial, { force: true })
  }
}
