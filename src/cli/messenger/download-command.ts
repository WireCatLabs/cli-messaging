import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { CliError } from "@leemour/cli-core"
import type { Command } from "commander"
import { NOT_FILES } from "../../domain/attachments.js"
import type { Id } from "../../domain/models.js"
import { FETCHING, keyOf } from "../../services/archive.js"
import { recordPaths, type Saved, save } from "../../services/file-download.js"

export { downloadMessage, type Saved, safeName, save } from "../../services/file-download.js"

import { OFFLINE } from "../../services/deps.js"
import type { MessagesService } from "../../services/messages.js"
import { patiently } from "../../services/patience.js"
import { parseDuration } from "../settings.js"
import { type Fetching, type Messenger, type MessengerContext, messengerContext, refuseLocalWrite } from "./context.js"
import { stopOnSignal } from "./patience.js"

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
    .option("--extract", "read text layers from the files this download maps into the local content index")
    .action(async function (this: Command, chat: string, messageId: string | undefined) {
      const context = messengerContext(this, messenger)
      const {
        outputDir: output,
        all,
        pause,
        extract,
      } = this.opts<{ outputDir: string; all?: boolean; pause: string; extract?: boolean }>()
      if (extract) refuseLocalWrite(context, messenger.app.command, "attachments.extract")
      if (all && messageId !== undefined) {
        throw new CliError("validation_error", "--all saves the whole chat; leave out the message id")
      }
      if (all) {
        await downloadChat(this, context, messenger, chat, output, parseDuration(pause, "--pause"), extract)
        return
      }
      if (messageId === undefined) throw new CliError("validation_error", "name a message id, or use --all")
      const id = messageId.trim()
      const result = await context.withServices(async (services) => {
        const { files, skipped } = await services.messages.download(chat, id)
        if (skipped.length > 0) context.renderer.note(`not a file, not downloaded: ${skipped.join(", ")}`)
        if (files.length === 0) throw new CliError("not_found", `message ${id} has no file to download`)
        mkdirSync(output, { recursive: true })
        const done: Saved[] = []
        for (const [index, file] of files.entries()) done.push(await save(file, output, `${id}-${index + 1}`))
        await recordPaths(services.messages, chat, id, files, done, context.renderer.warn)
        const extraction = extract
          ? await services.attachments.extract({ chat, message: id, paths: done.map((file) => file.path) })
          : undefined
        return { saved: done, extraction }
      })
      const { saved, extraction } = result
      if (extraction && context.format !== "json")
        context.renderer.note(`${extraction.extracted} extracted, ${extraction.failed} unreadable`)
      if (context.format === "pretty") context.streams.data(`${saved.map((one) => one.path).join("\n")}\n`)
      else if (context.format === "jsonl") context.renderer.stream(saved)
      else context.renderer.result({ items: saved, ...(extraction ? { extraction } : {}) })
    })

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
  extract = false,
) => {
  if (context.settings.offline) throw new CliError("validation_error", OFFLINE)
  const items: Saved[] = []
  const extraction = { extracted: 0, failed: 0, needsAgent: 0, complete: true }
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
        ...(extract
          ? {
              onDownloaded: async (id: string, paths: string[]) => {
                try {
                  const run = await services.attachments.extract({ chat, message: id, paths, signal: stop.signal })
                  extraction.extracted += run.extracted
                  extraction.failed += run.failed
                  extraction.needsAgent += run.needsAgent
                  extraction.complete &&= run.complete
                } catch {
                  extraction.failed += 1
                  extraction.complete = false
                }
              },
            }
          : {}),
      }),
    )
    if (context.format === "json") context.renderer.result({ items, ...result, ...(extract ? { extraction } : {}) })
    else {
      context.renderer.note(summary(result))
      if (extract) context.renderer.note(`${extraction.extracted} extracted, ${extraction.failed} unreadable`)
    }
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
  onDownloaded?: (message: Id, paths: string[]) => Promise<void>
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
  { output, pauseMs, fetching, fromStore, stop, note, warn, onSaved, onDownloaded }: ChatWalk,
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
        await onDownloaded?.(
          message.id,
          done.map((file) => file.path),
        )
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
