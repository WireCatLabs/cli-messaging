import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { link, rm } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { CliError } from "@leemour/cli-core"
import type { Command } from "commander"
import { NOT_FILES } from "../../domain/attachments.js"
import type { Id } from "../../domain/models.js"
import { FETCHING, keyOf } from "../../services/archive.js"
import { OFFLINE } from "../../services/deps.js"
import type { MessagesService } from "../../services/messages.js"
import { patiently } from "../../services/patience.js"
import { parseDuration } from "../settings.js"
import { type Fetching, type Messenger, type MessengerContext, messengerContext } from "./context.js"
import { stopOnSignal } from "./patience.js"
import type { RemoteFile } from "./port.js"

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
    .option("--output-dir <dir>", "where to save them; created if missing", ".")
    .option("--all", "every file of the chat, newest first; run it again to continue where it stopped")
    .option(
      "--pause <duration>",
      "with --all, a pause between pages, to stay under the provider's limits",
      messenger.fetching?.pause ?? FETCHING.pause,
    )
    .action(async function (this: Command, chat: string, messageId: string | undefined) {
      const context = messengerContext(this, messenger)
      const { outputDir: output, all, pause } = this.opts<{ outputDir: string; all?: boolean; pause: string }>()
      if (all && messageId !== undefined) {
        throw new CliError("validation_error", "--all saves the whole chat; leave out the message id")
      }
      if (all) {
        await downloadChat(this, context, messenger, chat, output, parseDuration(pause, "--pause"))
        return
      }
      if (messageId === undefined) throw new CliError("validation_error", "name a message id, or use --all")
      const id = messageId.trim()
      const saved = await context.withServices(async (services) => {
        const { files, skipped } = await services.messages.download(chat, id)
        if (skipped.length > 0) context.renderer.note(`not a file, not downloaded: ${skipped.join(", ")}`)
        if (files.length === 0) throw new CliError("not_found", `message ${id} has no file to download`)
        mkdirSync(output, { recursive: true })
        const done: Saved[] = []
        for (const [index, file] of files.entries()) done.push(await save(file, output, `${id}-${index + 1}`))
        await recordPaths(services.messages, chat, id, files, done, context.renderer.warn)
        return done
      })
      if (context.format === "pretty") context.streams.data(`${saved.map((one) => one.path).join("\n")}\n`)
      else if (context.format === "jsonl") context.renderer.stream(saved)
      else context.renderer.result({ items: saved })
    })

/**
 * The files are saved whatever happens here: a store that cannot take the paths costs only the later
 * `attachments extract`, so it warns and never fails the download.
 */
const recordPaths = async (
  messages: Pick<MessagesService, "keepDownloaded">,
  chat: string,
  message: Id,
  files: readonly RemoteFile[],
  saved: readonly Saved[],
  warn: (message: string) => void,
): Promise<number> => {
  const downloaded = saved.map((one, index) => ({
    kind: one.kind,
    path: one.path,
    ...(files[index]?.name === undefined ? {} : { name: files[index]?.name }),
    ...(files[index]?.position === undefined ? {} : { position: files[index]?.position }),
  }))
  try {
    return await messages.keepDownloaded(chat, message, downloaded)
  } catch (error) {
    warn(`not recorded in the local store where message ${message}'s files went: ${(error as Error).message}`)
    return 0
  }
}

/** The most messages a provider hands out per history request — Telegram's cap. */
const PAGE = 100

interface Stretch {
  from: number
  to: number
  /** By time only: the messages walked that were sent at `from`, and at `to` — others may share that moment. */
  atFrom?: Id[]
  atTo?: Id[]
}

type KeyedBy = "id" | "time"

interface Progress {
  by: KeyedBy
  done: Stretch[]
}

/**
 * Stretches of message keys already walked (`keyOf`), in a dot file beside the files — not in the
 * store, which this would need a migration for. Written after every message with a file, so a run cut
 * short by `--timeout` or Ctrl-C repeats at most the file it was in the middle of.
 */
const progressFile = (output: string, chatId: Id) => join(output, `.download-${chatId.replace(/[^\w-]/g, "_")}.json`)

/** A file from before `by` was written is keyed by id. One keyed the other way is set aside, not misread. */
const readProgress = (path: string, by: KeyedBy, note: (message: string) => void): Stretch[] => {
  if (!existsSync(path)) return []
  const { done, by: was = "id" } = JSON.parse(readFileSync(path, "utf8")) as Partial<Progress>
  if (was !== by) {
    note(`${path} counts messages by ${was}, this messenger by ${by} — starting from the newest again`)
    return []
  }
  return Array.isArray(done) ? done : []
}

const writeProgress = (path: string, chatId: Id, progress: Progress) => {
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ chat: chatId, ...progress })}\n`, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

const downloadChat = async (
  command: Command,
  context: MessengerContext,
  messenger: Messenger,
  chat: string,
  output: string,
  pauseMs: number,
) => {
  if (context.settings.offline) throw new CliError("validation_error", OFFLINE)
  const items: Saved[] = []
  const onSaved = (one: Saved) => {
    if (context.format === "pretty") context.streams.data(`${one.path}\n`)
    else if (context.format === "jsonl") context.renderer.stream([one])
    else items.push(one)
  }
  const stop = stopOnSignal(command)
  try {
    mkdirSync(output, { recursive: true })
    const result = await context.withServices((services) =>
      walkChat(services.messages, chat, {
        output,
        pauseMs,
        fetching: messenger.fetching ?? FETCHING,
        fromStore: messenger.history === "store",
        stop: stop.signal,
        note: context.renderer.note,
        warn: context.renderer.warn,
        onSaved,
      }),
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
  fetching: Fetching
  /** The history pages the local store, where walking past what is held costs no request. */
  fromStore: boolean
  stop: AbortSignal
  note: (message: string) => void
  warn: (message: string) => void
  onSaved: (one: Saved) => void
}

/** Both stretches as one, keeping by time the messages walked at its two ends. */
const joined = (a: Stretch, b: Stretch): Stretch => {
  const from = Math.min(a.from, b.from)
  const to = Math.max(a.to, b.to)
  if (a.atFrom === undefined && b.atFrom === undefined) return { from, to }
  const at = (moment: number) => [
    ...new Set(
      [a, b].flatMap((one) => [
        ...(one.from === moment ? (one.atFrom ?? []) : []),
        ...(one.to === moment ? (one.atTo ?? []) : []),
      ]),
    ),
  ]
  return { from, to, atFrom: at(from), atTo: at(to) }
}

/**
 * Newest to oldest, page by page, through the messages service — so a messenger whose history lives
 * in the local store pages the store, and only the files come from the messenger. A stretch an earlier
 * run walked is jumped over, and joins this run's, so the progress file stays a few stretches however
 * often the download is cut and resumed.
 *
 * By time, the messenger pages back from an ISO time (`Fetching.orderBy`), and messages share a moment:
 * a page is asked for up to and including the oldest moment seen, so none sent then is skipped, and
 * what this run already walked is passed over. A stretch's ends hold only the messages it names.
 */
const walkChat = async (
  messages: Pick<MessagesService, "list" | "download" | "keepDownloaded">,
  chat: string,
  { output, pauseMs, fetching, fromStore, stop, note, warn, onSaved }: ChatWalk,
) => {
  const by: KeyedBy = fetching.orderBy ?? "id"
  const keyed = keyOf(fetching)
  const pagesByTime = by === "time" && !fromStore
  const inside = ({ from, to, atFrom, atTo }: Stretch, key: number, id: Id) =>
    by === "time"
      ? (from < key && key < to) || (key === from && !!atFrom?.includes(id)) || (key === to && !!atTo?.includes(id))
      : from <= key && key <= to
  const point = (key: number, id: Id): Stretch =>
    by === "time" ? { from: key, to: key, atFrom: [id], atTo: [id] } : { from: key, to: key }
  let before: string | undefined
  let beforeMs = Number.POSITIVE_INFINITY
  let chatId: Id | undefined
  let path = ""
  let done: Stretch[] = []
  let run: Stretch | undefined
  let saved = 0
  let existing = 0
  let complete = false
  const remember = () => {
    if (chatId !== undefined) writeProgress(path, chatId, { by, done: run ? [...done, run] : done })
  }
  const backTo = (ms: number) => {
    beforeMs = ms
    before = new Date(ms).toISOString()
  }

  pages: while (!stop.aborted) {
    const page = await patiently(
      () => messages.list(chat, { limit: fromStore ? PAGE : fetching.page, ...(before ? { before } : {}) }),
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
      done = readProgress(path, by, note)
    }
    const newestFirst = page.items.toReversed().map((message) => ({ message, key: keyed(message) }))
    if (newestFirst.some(({ key }) => !Number.isSafeInteger(key))) {
      throw new CliError(
        "validation_error",
        by === "id"
          ? "this messenger's message ids are not whole numbers, so --all cannot resume"
          : "a message here has no send time, so --all cannot resume",
      )
    }
    let fresh = 0
    for (const { message, key } of newestFirst) {
      if (stop.aborted) break pages
      if (run && inside(run, key, message.id)) continue
      fresh += 1
      const known = done.find((one) => inside(one, key, message.id))
      if (known) {
        done = done.filter((one) => one !== known)
        run = run ? joined(run, known) : known
        remember()
        if (fromStore) continue
        if (pagesByTime) backTo(known.from + 1)
        else before = String(known.from)
        continue pages
      }
      if (message.attachments.some(({ kind }) => !NOT_FILES.has(kind))) {
        const { files } = await patiently(() => messages.download(chat, message.id), note, stop)
        const done: Saved[] = []
        for (const [index, file] of files.entries()) {
          const one = await patiently(
            () => save(file, output, `${message.id}-${index + 1}`, { unique: true }),
            note,
            stop,
          )
          if (one.existing) existing += 1
          else saved += 1
          done.push(one)
          onSaved(one)
        }
        await recordPaths(messages, message.chatId, message.id, files, done, warn)
        run = run ? joined(run, point(key, message.id)) : point(key, message.id)
        remember()
      } else run = run ? joined(run, point(key, message.id)) : point(key, message.id)
    }
    remember()
    if (!page.hasMore) {
      complete = true
      break
    }
    const oldest = newestFirst.at(-1)
    if (pagesByTime && oldest) {
      // A page of nothing new means one moment holds more than a page: step past it rather than loop.
      if (fresh > 0) backTo(oldest.key + 1)
      else backTo(Math.min(beforeMs - 1, oldest.key))
    } else before = oldest?.message.id
    note(`${saved} files so far, back to message ${oldest?.message.id}`)
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
  const own = safeName(file.name)
  const fileName = () => {
    const extension = EXTENSIONS[file.mime ?? ""] ?? BY_KIND[file.kind]
    return own ?? (extension ? `${fallbackName}.${extension}` : fallbackName)
  }
  const partial = join(directory, `.${fileName()}.${process.pid}.part`)
  let bytes = 0
  const counting = new Transform({
    transform(chunk: Uint8Array, _encoding, done) {
      bytes += chunk.length
      done(null, chunk)
    },
  })
  try {
    await pipeline(Readable.from(file.bytes()), counting, createWriteStream(partial, { flags: "wx", mode: 0o600 }))
    // Lazy HTTP downloads learn MIME while reading bytes.
    const name = fileName()
    const names = unique && own ? [name, `${fallbackName}-${own}`] : [name]
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
    throw new CliError("validation_error", `${path} already exists — nothing was overwritten; choose --output-dir`)
  } finally {
    await rm(partial, { force: true })
  }
}
