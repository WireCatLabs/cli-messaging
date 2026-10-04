import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CliError } from "@leemour/cli-core"
import type { Id, Message } from "../../domain/models.js"
import type { AccountKey } from "../../store/store.js"

const FORMAT = "cli-messaging-export"
const MANIFEST = "manifest.json"

export interface ExportedChat {
  title: string | null
  /** This machine's time the last run read up to; the next run takes what changed after it. */
  mark: string
  files: string[]
  messages: number
  deleted: number
}

export interface ExportManifest {
  format: typeof FORMAT
  version: 1
  provider: string
  account: Id
  chats: Record<Id, ExportedChat>
}

/**
 * The folder's manifest, or a fresh one where the folder is new or empty. A folder holding anything
 * else is refused, and so is one exported from another account: adding to it would mix two.
 */
export const openFolder = (dir: string, key: AccountKey): ExportManifest => {
  const fresh: ExportManifest = { format: FORMAT, version: 1, provider: key.provider, account: key.account, chats: {} }
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return fresh
  }
  const path = join(dir, MANIFEST)
  if (!existsSync(path)) {
    if (readdirSync(dir).length > 0) {
      throw new CliError("validation_error", `${dir} holds other files and no ${MANIFEST} — export into a new folder`)
    }
    return fresh
  }
  const found = JSON.parse(readFileSync(path, "utf8")) as Partial<ExportManifest>
  if (found.format !== FORMAT || found.version !== 1 || typeof found.chats !== "object" || found.chats === null) {
    throw new CliError("validation_error", `${path} is not an export manifest this version reads`)
  }
  if (found.provider !== key.provider || found.account !== key.account) {
    throw new CliError(
      "validation_error",
      `${dir} was exported from ${found.provider} account ${found.account}, not this one — export into a new folder`,
    )
  }
  return found as ExportManifest
}

const safe = (chatId: Id) => chatId.replace(/[^\w-]/g, "_")

/**
 * Messages first, oldest first, then one `{ id, deleted: true }` per deletion — never the deleted
 * text. Named by the run's mark: a file left by a run stopped before its manifest is not in the way.
 */
export const writeChanges = (
  dir: string,
  chatId: Id,
  mark: string,
  { messages, deleted }: { messages: Message[]; deleted: Id[] },
): string => {
  const name = `${safe(chatId)}-${mark.replace(/[^\dTZ]/g, "")}.jsonl`
  const lines = [
    ...messages.map((message) => JSON.stringify(message)),
    ...deleted.map((id) => JSON.stringify({ id, chatId, deleted: true })),
  ]
  try {
    writeFileSync(join(dir, name), `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError("validation_error", `${join(dir, name)} exists — two exports into one folder at once`)
    }
    throw error
  }
  return name
}

/** Written last and replaced whole, so a run stopped halfway leaves the previous manifest, and repeats. */
export const saveManifest = (dir: string, manifest: ExportManifest): void => {
  const next = join(dir, `.${MANIFEST}.next`)
  writeFileSync(next, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(next, join(dir, MANIFEST))
}
