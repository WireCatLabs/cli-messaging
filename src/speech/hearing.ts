import { chmodSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths } from "@leemour/cli-core"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { Settings } from "../cli/settings.js"
import type { Message } from "../domain/models.js"
import { openCache } from "../store/open.js"
import { MODELS } from "./models.js"
import { type Choice, choose, hearLocally, hearOnline } from "./transcribe.js"

/** Telegram polls each voice message for up to a minute; a whole list gets this long, then says what is left. */
export const HEARING_BUDGET_MS = 120_000

export interface Voice {
  chatId: string
  messageId: string
}

export interface Hearing {
  /** By `keyOf`: the text of every voice message heard now or kept from before. */
  transcripts: Map<string, string>
  /** Voice messages still without text after `--transcribe`: out of time, pending, or refused. */
  unheard: Voice[]
  /** Why some were not heard — the first reason; the messages are still worth showing. */
  problem?: string
}

export const keyOf = ({ chatId, messageId }: Voice): string => `${chatId}/${messageId}`

/** Telegram says `voice`; MAX says `audio` with Ogg in it. */
export const isVoice = (message: Message): boolean =>
  message.attachments.some(({ kind, mime }) => kind === "voice" || mime === "audio/ogg")

export interface Kept {
  get(voice: Voice): string | undefined
  keep(voice: Voice, text: string, source: string): void
  close(): void
}

/**
 * Transcripts already heard, per profile, in the CLI's own cache — not the store: a transcript is
 * derived and can be heard again, and a development build's `<PREFIX>_CACHE_DIR` keeps it off the
 * owner's files. One profile is one account, so a chat and a message id are the key.
 */
export const openKept = async (messenger: Messenger, profile: string, env: NodeJS.ProcessEnv): Promise<Kept> => {
  const directory = resolvePaths({ appName: messenger.app.appName, prefix: messenger.app.envPrefix, env }).cache
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `transcripts-${profile}.db`)
  const database = await openCache(path)
  chmodSync(path, 0o600)
  database.exec(`CREATE TABLE IF NOT EXISTS transcripts (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    heard_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  )`)
  const { user_version: version } = database.prepare("PRAGMA user_version").get() as { user_version: number }
  if (version < 1) {
    // Local models heard these with a voice detector that dropped quiet speech; hear them again.
    database
      .prepare(`DELETE FROM transcripts WHERE source IN (${MODELS.map(() => "?").join(", ")})`)
      .run(...MODELS.map(({ id }) => id))
    database.exec("PRAGMA user_version = 1")
  }
  const read = database.prepare("SELECT text FROM transcripts WHERE chat_id = ? AND message_id = ?")
  const write = database.prepare(
    "INSERT OR REPLACE INTO transcripts (chat_id, message_id, text, source, heard_at) VALUES (?, ?, ?, ?, ?)",
  )
  return {
    get: ({ chatId, messageId }) => read.get(chatId, messageId)?.text as string | undefined,
    keep: ({ chatId, messageId }, text, source) => {
      // A pending or empty answer would stick for good; only a finished text is kept.
      if (text.trim() !== "") write.run(chatId, messageId, text, source, new Date().toISOString())
    },
    close: () => database.close(),
  }
}

/**
 * Kept transcripts always — they cost nothing; new ones only when `connect` is given (`--transcribe`).
 * The messenger is asked inside one connection; a local model runs after it closes, on the bytes
 * fetched in it. What could not be heard is in `unheard`, never a failure.
 */
export const hearVoices = async (
  messenger: Messenger,
  messages: readonly Message[],
  kept: Kept,
  transcribe?: {
    choice: Choice
    connect: <T>(work: (adapter: MessengerAdapter) => Promise<T>) => Promise<T>
    budgetMs?: number
  },
): Promise<Hearing> => {
  const transcripts = new Map<string, string>()
  const missing: Voice[] = []
  for (const message of messages.filter(isVoice)) {
    const voice = { chatId: message.chatId, messageId: message.id }
    const text = kept.get(voice)
    if (text === undefined) missing.push(voice)
    else transcripts.set(keyOf(voice), text)
  }
  if (!transcribe || missing.length === 0) return { transcripts, unheard: [] }

  const { choice, connect, budgetMs = HEARING_BUDGET_MS } = transcribe
  const deadline = Date.now() + budgetMs
  let problem: string | undefined
  const fetched = await connect(async (adapter) => {
    const answers: [Voice, Awaited<ReturnType<typeof hearOnline>>][] = []
    for (const voice of missing) {
      if (Date.now() >= deadline) break
      try {
        answers.push([voice, await hearOnline(messenger, adapter, voice.chatId, voice.messageId, choice)])
      } catch (error) {
        problem ??= error instanceof Error ? error.message : String(error)
      }
    }
    return answers
  })
  for (const [voice, answer] of fetched) {
    try {
      const heard = answer instanceof Uint8Array ? await hearLocally(answer, voice.messageId, choice) : answer
      if (heard.pending || heard.text.trim() === "") continue
      transcripts.set(keyOf(voice), heard.text)
      kept.keep(voice, heard.text, heard.model ?? heard.via)
    } catch (error) {
      problem ??= error instanceof Error ? error.message : String(error)
    }
  }
  const unheard = missing.filter((voice) => !transcripts.has(keyOf(voice)))
  return { transcripts, unheard, ...(problem === undefined ? {} : { problem }) }
}

/** A message with its transcript, when there is one; others pass through unchanged. */
export const withTranscript = <T extends Message>(message: T, hearing: Hearing): T & { transcript?: string } => {
  const transcript = hearing.transcripts.get(keyOf({ chatId: message.chatId, messageId: message.id }))
  return transcript === undefined ? message : { ...message, transcript }
}

/** How a person sees one: the text the messenger has, then what was heard. */
export const spoken = <T extends Message & { transcript?: string }>({ transcript, ...message }: T): Message =>
  transcript === undefined
    ? message
    : { ...message, text: [message.text, `🎤 ${transcript}`].filter(Boolean).join("\n") }

/** For an MCP tool: the same hearing, over the session's own connection. */
export const hearForTool = async (
  messenger: Messenger,
  adapter: MessengerAdapter,
  messages: readonly Message[],
  transcribe: boolean,
  { settings, env }: { settings: Pick<Settings, "configured" | "shared" | "profile">; env: NodeJS.ProcessEnv },
): Promise<Hearing | undefined> => {
  if (!messages.some(isVoice)) return undefined
  const kept = await openKept(messenger, settings.profile, env)
  try {
    return await hearVoices(
      messenger,
      messages,
      kept,
      transcribe ? { choice: choose(messenger, settings, {}, env), connect: (work) => work(adapter) } : undefined,
    )
  } finally {
    kept.close()
  }
}

/** Messages with their transcripts; `unheard` as well when `--transcribe` was asked for. */
export const heard = <T extends Message>(messages: readonly T[], hearing: Hearing | undefined): T[] =>
  hearing ? messages.map((message) => withTranscript(message, hearing)) : [...messages]
