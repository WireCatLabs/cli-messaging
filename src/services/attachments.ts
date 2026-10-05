import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import {
  type Engine,
  type Extraction,
  extractText,
  importEngine,
  type LoadEngine,
  MAX_FILE_BYTES,
} from "../attachments/extract.js"
import { formatLocator } from "../domain/locator.js"
import type { Id } from "../domain/models.js"
import type { AccountKey, FileAttachment, MessageStore } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./messages.js"

export type ExtractStatus = "extracted" | "needs-agent" | "unreadable" | "engine-missing" | "too-large" | "missing"

/** One file looked at. Never its text: the text stays in the local store. */
export interface ExtractItem {
  locator: string
  /** The attachment's place in the message, from 1. */
  attachment: number
  kind: string
  name: string | null
  status: ExtractStatus
  extractor?: string
  chars?: number
}

export interface ExtractRun {
  items: ExtractItem[]
  extracted: number
  needsAgent: number
  failed: number
  /** Read before, and the same size now. */
  unchanged: number
  /** No saved file, and no `--download`. */
  notDownloaded: number
  /** Video, voice, an archive: nothing to read. */
  unsupported: number
  /** Every file was looked at; `false` when `limit` or a stop cut the run short. */
  complete: boolean
  /** Packages a format needed and this machine lacks; those files are read on a later run. */
  enginesMissing: Engine[]
}

export interface ExtractOptions {
  chat?: string
  /** At most this many files read. */
  limit?: number
  /** Saves a message's files where none were saved, through `messages download`'s own code. */
  download?: (chatId: Id, messageId: Id) => Promise<void>
  onItem?: (item: ExtractItem) => void
  signal?: AbortSignal
  load?: LoadEngine
}

export interface AttachmentsService {
  /** Reads the text layer of saved files into the local store; prints and sends nothing. */
  extract(options?: ExtractOptions): Promise<ExtractRun>
}

const PAGE = 200

const outcome = async (
  file: FileAttachment,
  path: string,
  load: LoadEngine,
): Promise<{
  status: ExtractStatus | "unchanged" | "unsupported"
  extraction?: Extraction
  bytes?: number
  sha?: string
}> => {
  const size = await stat(path).then(
    (found) => (found.isFile() ? found.size : undefined),
    () => undefined,
  )
  if (size === undefined) return { status: "missing" }
  if (file.read?.origin === "extracted" && file.read.bytes === size) return { status: "unchanged" }
  if (size > MAX_FILE_BYTES) return { status: "too-large" }
  const bytes = new Uint8Array(await readFile(path))
  const extraction = await extractText(bytes, { kind: file.kind, name: file.name, mime: file.mime, path }, load)
  const sha = createHash("sha256").update(bytes).digest("hex")
  return { status: extraction.status, extraction, bytes: size, sha }
}

const keep = async (store: MessageStore, file: FileAttachment, extraction: Extraction, bytes: number, sha: string) => {
  const base = { origin: "extracted" as const, contentSha256: sha, bytes }
  if (extraction.status === "extracted") {
    await store.keepAttachmentText(file.pk, { ...base, text: extraction.text, extractor: extraction.extractor })
  } else if (extraction.status === "unreadable") {
    await store.keepAttachmentText(file.pk, {
      ...base,
      text: "",
      extractor: extraction.extractor,
      error: extraction.error,
    })
  } else if (extraction.status === "needs-agent" && extraction.extractor) {
    // Kept, so the next run does not parse the same scan again; an agent's text replaces it.
    await store.keepAttachmentText(file.pk, { ...base, text: "", extractor: extraction.extractor, error: "no_text" })
  }
}

export const attachmentsService = (deps: ServiceDeps): AttachmentsService => ({
  extract: async ({ chat, limit, download, onItem, signal, load = importEngine } = {}) => {
    const store = await deps.store()
    const account: AccountKey = await deps.account()
    const chatId = chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account)
    const run: ExtractRun = {
      items: [],
      extracted: 0,
      needsAgent: 0,
      failed: 0,
      unchanged: 0,
      notDownloaded: 0,
      unsupported: 0,
      complete: true,
      enginesMissing: [],
    }
    const fetched = new Set<string>()
    let read = 0
    let beforePk: number | undefined
    walk: for (;;) {
      const page = await store.fileAttachments(account, {
        ...(chatId === undefined ? {} : { chatId }),
        ...(beforePk === undefined ? {} : { beforePk }),
        limit: PAGE,
      })
      for (const file of page) {
        if (signal?.aborted || (limit !== undefined && read >= limit)) {
          run.complete = false
          break walk
        }
        beforePk = file.pk
        let path = file.localPath
        const message = `${file.chatId}/${file.messageId}`
        if (path === null && download && !fetched.has(message)) {
          fetched.add(message)
          await download(file.chatId, file.messageId)
          path = await store.localPathOf(file.pk)
        }
        if (path === null) {
          run.notDownloaded += 1
          continue
        }
        const { status, extraction, bytes, sha } = await outcome(file, path, load)
        if (status === "unchanged") {
          run.unchanged += 1
          continue
        }
        if (status === "unsupported") {
          run.unsupported += 1
          continue
        }
        if (extraction && bytes !== undefined && sha !== undefined) await keep(store, file, extraction, bytes, sha)
        if (status !== "missing" && status !== "too-large" && status !== "engine-missing") read += 1
        if (extraction?.status === "engine-missing" && !run.enginesMissing.includes(extraction.engine))
          run.enginesMissing.push(extraction.engine)
        if (status === "extracted") run.extracted += 1
        else if (status === "needs-agent") run.needsAgent += 1
        else if (status === "unreadable") run.failed += 1
        const item: ExtractItem = {
          locator: formatLocator({ ...account, chat: file.chatId, message: file.messageId }),
          attachment: file.position + 1,
          kind: file.kind,
          name: file.name,
          status,
          ...(extraction && "extractor" in extraction && extraction.extractor
            ? { extractor: extraction.extractor }
            : {}),
          ...(extraction?.status === "extracted" ? { chars: extraction.text.length } : {}),
        }
        run.items.push(item)
        onItem?.(item)
      }
      if (page.length < PAGE) break
    }
    return run
  },
})
