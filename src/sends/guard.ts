import { randomUUID } from "node:crypto"
import { CliError } from "@leemour/cli-core"
import type { AppIdentity } from "../cli/app.js"
import type { Settings } from "../cli/settings.js"
import type { Id } from "../domain/models.js"
import {
  type AccountAction,
  type ChatAction,
  type SendEntry,
  SendJournal,
  type SendKind,
  sendsPathFor,
} from "./journal.js"
import { type Permission, permissionFor } from "./permissions.js"
import { RecipientList, recipientsPathFor } from "./recipients.js"

const HOUR_MS = 60 * 60 * 1000

/** One write, as the guard is asked about it. `personIds` are checked and never journaled. */
export interface GuardRequest {
  /** `null` for a chat that does not exist yet — joining or creating one — or for the account itself: no list can name either. */
  chatId: Id | null
  kind?: SendKind
  action?: ChatAction | AccountAction
  /** Messages a deletion names, or people a chat change adds. */
  count?: number
  sendId?: string
  operationId?: string
  scheduledFor?: string
  notify?: boolean
  personIds?: Id[]
}

/** What `MaxClient.messages.send` asks before it sends, and tells after — on every outcome. */
export interface SendGuard {
  /**
   * Refuses, or lets the write through. One that counts toward the limit is also given a place in
   * the journal under a lock, unless `reserve` is false — over a background server, the server holds it.
   */
  check(request: GuardRequest, options?: { reserve?: boolean }): void
  record(entry: Omit<SendEntry, "at" | "profile">): void
}

export interface SendGuardOptions {
  profile: string
  /** The program's word, for the hints that say what to type: `tg`, `max`. */
  command?: string
  readOnly: boolean
  /** Named in the refusal, so the owner can find what decided it. */
  readOnlyFrom: string
  /** `undefined` allows every action; a list only those (`CLI-37`). */
  allow?: readonly Permission[]
  allowFrom?: string
  sendsPerHour: number
  journal: SendJournal
  recipients: RecipientList
  warn: (message: string) => void
  now?: () => Date
}

type Counted = Pick<SendEntry, "kind" | "action" | "notify" | "count" | "people">

/**
 * What puts something in front of somebody (max-cli `NEED-168`, widened by `NEED-282`). A message, a
 * forward, an edit, a pin that notifies, a new group and people added to one all do. A reaction,
 * a quiet pin or a change of title wakes nobody. A deletion wakes nobody either, but many at once
 * is what a ban for automation looks like.
 */
const countsTowardLimit = ({ kind = "message", action, notify }: Counted) =>
  kind === "message" ||
  kind === "forward" ||
  kind === "edit" ||
  kind === "delete" ||
  (kind === "pin" && notify === true) ||
  action === "create" ||
  action === "members.add"

/** Each deleted message, and each person added to a group, counts as one. */
const weightOf = ({ kind, action, count, people }: Counted): number =>
  kind === "delete"
    ? (count ?? 1)
    : action === "create" || action === "members.add"
      ? Math.max(1, people ?? count ?? 1)
      : 1

/** A scheduled message counts in the hour the provider sends it. */
const timeOf = (entry: Pick<SendEntry, "at" | "scheduledFor">): number => Date.parse(entry.scheduledFor ?? entry.at)

/**
 * These stop a model that was talked into sending by a message it read. They do **not** stop an
 * agent that edits the configuration itself — that needs a boundary outside this process
 * (`docs/security.md`).
 */
export const sendGuard = ({
  profile,
  command = "tg",
  readOnly,
  readOnlyFrom,
  allow,
  allowFrom = "default",
  sendsPerHour,
  journal,
  recipients,
  warn,
  now = () => new Date(),
}: SendGuardOptions): SendGuard => {
  let reservation: string | undefined

  const permitted = ({ chatId, kind = "message", action, personIds }: GuardRequest) => {
    if (readOnly) {
      throw new CliError(
        "permission_error",
        `profile ${profile} is read-only (readOnly, from the ${readOnlyFrom}) — it cannot send, react, change chats or change the account`,
      )
    }

    const permission = permissionFor(kind, action)
    if (allow && !allow.includes(permission)) {
      const fix =
        allowFrom === "config defaults"
          ? `${command} config set --defaults allow`
          : `${command} ${profile} config set allow`
      throw new CliError(
        "permission_error",
        `profile ${profile} does not allow ${permission} (allow: ${allow.join(", ") || "nothing"} — from the ${allowFrom}); ` +
          `to allow it: ${fix} ${[...allow, permission].join(",")}`,
        { permission },
      )
    }

    const allowed = recipients.read()
    if (chatId !== null && allowed && !allowed.some((chat) => chat.id === chatId)) {
      throw new CliError(
        "confirmation_required",
        `chat ${chatId} is not on the recipient list of profile ${profile} — ` +
          `the owner adds it with \`${command} ${profile} recipients add ${chatId}\``,
        { chatId },
      )
    }
    // Adding somebody to a group writes to them as surely as a message does.
    const strangers = allowed ? (personIds ?? []).filter((id) => !allowed.some((chat) => chat.partnerId === id)) : []
    if (strangers.length > 0) {
      throw new CliError(
        "confirmation_required",
        `${strangers.join(", ")} ${strangers.length === 1 ? "is" : "are"} not on the recipient list of profile ${profile} — ` +
          `the owner adds the one-to-one chat with each person (\`${command} ${profile} recipients add <chat>\`); ` +
          "a chat added to the list earlier is added again to be recognised",
        { personIds: strangers },
      )
    }
  }

  const withinLimit = (request: GuardRequest, entries: SendEntry[]) => {
    const { chatId, sendId } = request
    const asked = { ...request, people: request.personIds?.length ?? request.count }
    const count = weightOf(asked)
    if (count > sendsPerHour) {
      throw new CliError(
        "rate_limited",
        `${count} at once is more than the hourly limit of profile ${profile} (sendsPerHour ${sendsPerHour}) — ` +
          "do fewer at a time",
      )
    }

    const at = request.scheduledFor ? Date.parse(request.scheduledFor) : now().getTime()
    const counted = entries
      .filter(countsTowardLimit)
      .filter(
        (entry) => entry.outcome === "sent" || entry.outcome === "outcome_unknown" || entry.outcome === "reserved",
      )
      .filter((entry) => Math.abs(timeOf(entry) - at) < HOUR_MS)
    // A retry of a send whose outcome was unknown repeats its send id in the same chat, and the
    // provider delivers one message for both. Only that: an id that was sent, or another chat, is a new send.
    const unsure = (entry: SendEntry) => entry.outcome === "outcome_unknown"
    const same = (a: SendEntry, b: { chatId: Id | null; sendId?: string }) =>
      a.sendId !== undefined && a.sendId === b.sendId && a.chatId === b.chatId
    const last = [...counted].reverse().find((entry) => same(entry, { chatId, sendId }))
    if (sendId !== undefined && last && unsure(last)) return false
    const recent = counted
      .filter((entry, index) => !(unsure(entry) && counted.slice(index + 1).some((later) => same(later, entry))))
      .map((entry) => ({ time: timeOf(entry), weight: weightOf(entry) }))
      .sort((a, b) => a.time - b.time)
    const used = recent.reduce((sum, { weight }) => sum + weight, 0)
    if (used + count > sendsPerHour) {
      // The limit may have been lowered below what the last hour already holds: it opens when
      // enough of it has aged out, not when the oldest has.
      let freed = 0
      const opening = recent.find(({ weight }) => {
        freed += weight
        return used - freed + count <= sendsPerHour
      })
      const nextMs = (opening?.time ?? 0) + HOUR_MS
      const next = new Date(nextMs).toISOString()
      throw new CliError(
        "rate_limited",
        `profile ${profile} has sent ${used} messages in the hour around ${new Date(at).toISOString()}, and its limit is ` +
          `${sendsPerHour} (sendsPerHour) — the next send is possible at ${next}`,
        { retryAfterMs: nextMs - now().getTime(), retryAt: next },
      )
    }
    return true
  }

  return {
    check: (request, { reserve = true } = {}) => {
      permitted(request)
      const asked = { ...request, people: request.personIds?.length ?? request.count }
      if (!countsTowardLimit(asked)) return
      if (!reserve) {
        withinLimit(request, journal.entries())
        return
      }
      journal.locked(() => {
        if (!withinLimit(request, journal.entries())) return
        const id = randomUUID()
        const { chatId, kind, action, sendId, operationId, scheduledFor, notify } = request
        journal.append({
          at: now().toISOString(),
          profile,
          chatId,
          outcome: "reserved",
          reservation: id,
          ...(kind ? { kind } : {}),
          ...(action ? { action } : {}),
          ...(asked.people === undefined ? {} : kind === "delete" ? { count: asked.people } : { people: asked.people }),
          ...(sendId === undefined ? {} : { sendId }),
          ...(operationId === undefined ? {} : { operationId }),
          ...(scheduledFor ? { scheduledFor } : {}),
          ...(notify === undefined ? {} : { notify }),
        })
        reservation = id
      })
    },

    // After a send, a failure to write here must not become the command's answer: the message is
    // already with a person, and an error would invite the caller to send it again.
    record: (entry) => {
      const { personIds: _, ...kept } = entry as typeof entry & { personIds?: Id[] }
      const settles = entry.outcome === "refused" ? undefined : reservation
      reservation = undefined
      try {
        journal.append({ at: now().toISOString(), profile, ...kept, ...(settles ? { reservation: settles } : {}) })
      } catch (error) {
        warn(`this send is not in the send journal: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/**
 * The guard a profile's configuration asks for — the command's, and a background server's for every
 * write it forwards. Built per request there, so `config set readOnly true` needs no restart.
 */
export const guardFor = (
  app: AppIdentity,
  settings: Settings,
  warn: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): SendGuard =>
  sendGuard({
    profile: settings.profile,
    command: app.command,
    readOnly: settings.readOnly,
    readOnlyFrom: settings.sources.readOnly ?? "default",
    ...(settings.allow ? { allow: settings.allow, allowFrom: settings.sources.allow ?? "default" } : {}),
    sendsPerHour: settings.sendsPerHour,
    journal: new SendJournal(sendsPathFor(app, settings.profile, env)),
    recipients: new RecipientList(recipientsPathFor(app, settings.profile, env), app.command),
    warn,
  })

/**
 * Over a background server, the server journals what it forwards, with the outcome it saw; the command
 * writes only the refusals of its own check, which never reached the server.
 */
export const sharedJournal = (guard: SendGuard, wire: { readonly journals: boolean } | undefined): SendGuard =>
  wire
    ? {
        // The check comes before the connection, when `journals` cannot tell yet; the server
        // reserves under its own lock, and a command that falls back to its own socket goes unreserved.
        check: (request) => guard.check(request, { reserve: false }),
        record: (entry) => {
          if (entry.outcome === "refused" || !wire.journals) guard.record(entry)
        },
      }
    : guard
