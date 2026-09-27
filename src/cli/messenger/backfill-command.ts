import { setTimeout as sleep } from "node:timers/promises"
import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import type { Id } from "../../domain/models.js"
import { type AccountKey, type MessageStore, openStore, type Range } from "../../store/store.js"
import { isCliFailure } from "../failures.js"
import { parseDuration } from "../settings.js"
import { type Messenger, messengerContext } from "./context.js"
import type { MessengerAdapter } from "./port.js"

/** The most messages a provider hands out per history request — Telegram's cap. */
const PAGE = 100
/** Waits longer than this are not sat out: the run stops, and the next one resumes. */
const LONGEST_WAIT_MS = 5 * 60 * 1000

/**
 * A chat's history into the store, newest to oldest, **resumable**: after every page the stretch it
 * covered is recorded, so a stop — Ctrl-C, `--timeout`, `--max`, a long FloodWait — loses nothing,
 * and the next run jumps over what is already held. Needs numeric message ids, which order the chat.
 */
export const backfillCommand = (messenger: Messenger): Command =>
  new Command("backfill")
    .description("fetch a chat's history into the local store, newest first; run it again to continue")
    .argument("<chat>", messenger.chatArgument)
    .option("--max <n>", "at most this many messages in this run", wholeNumber, 1000)
    .option("--pace <duration>", "pause between pages, to stay under the provider's limits", "1s")
    .action(async function (this: Command, chat: string) {
      const { max, pace } = this.opts<{ max: number; pace: string }>()
      const pauseMs = parseDuration(pace, "--pace")
      const context = messengerContext(this, messenger)
      const result = await context.withMessenger(async (connection) => {
        const self = connection.self()
        if (self === null) throw new CliError("authentication_error", "not logged in — nothing to backfill for")
        const store = await openStore({ env: context.env })
        try {
          return await walk(connection, store, { provider: messenger.provider, account: self }, chat, {
            max,
            pauseMs,
            note: context.renderer.note,
          })
        } finally {
          store.close()
        }
      })
      context.renderer.result(result)
    })

interface Walk {
  max: number
  pauseMs: number
  note: (message: string) => void
}

const walk = async (
  connection: MessengerAdapter,
  store: MessageStore,
  account: AccountKey,
  chat: string,
  { max, pauseMs, note }: Walk,
) => {
  let before: string | undefined
  let chatId: Id | undefined
  let top: number | undefined
  let fetched = 0
  let reachedStart = false

  while (fetched < max) {
    const page = await patiently(() => connection.history(chat, { limit: PAGE, ...(before ? { before } : {}) }), note)
    const first = page.items[0]
    if (!first) {
      reachedStart = true
      break
    }
    chatId ??= first.chatId
    const keys = page.items.map((message) => Number(message.id))
    if (keys.some((key) => !Number.isSafeInteger(key))) {
      throw new CliError("validation_error", "this messenger's message ids do not order a chat, so it cannot backfill")
    }
    const low = Math.min(...keys)
    top ??= Math.max(...keys)
    fetched += page.items.length
    // This run's pages are contiguous, so everything from `low` to its first message is held.
    const held: Range = store.markRange(account, chatId, low, top)
    if (!page.hasMore) {
      reachedStart = true
      break
    }
    before = String(held.from)
    note(`${fetched} messages so far, back to ${held.from}`)
    await sleep(pauseMs)
  }

  const ranges = chatId === undefined ? [] : store.ranges(account, chatId)
  return {
    chat: chatId ?? null,
    fetched,
    complete: reachedStart && ranges.length === 1,
    ranges,
  }
}

/** Sits out a provider's "wait N seconds" when it is short, a few times; a long one ends the run. */
const patiently = async <T>(request: () => Promise<T>, note: (message: string) => void): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request()
    } catch (error) {
      const wait = isCliFailure(error) && error.code === "rate_limited" ? Number(error.details?.retryAfterMs) : NaN
      if (!Number.isFinite(wait) || wait > LONGEST_WAIT_MS || attempt >= 3) throw error
      note(`asked to wait ${Math.ceil(wait / 1000)} s — waiting, then going on`)
      await sleep(wait)
    }
  }
}

const wholeNumber = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}
