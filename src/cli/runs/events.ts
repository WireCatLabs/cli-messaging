/**
 * One operation against the messenger, as both sinks see it: `--trace` renders it, a recorded run
 * writes it as a line of JSON.
 *
 * ⚠ **Nothing here may carry content.** An operation name, an id, a count, a duration and an error
 * code are safe. A chat title, a name, a message body, a phone number or a token are not — not
 * truncated and not hashed. The adapter builds `ids` and `counts` from fields it names, never by
 * copying a request, and never from what the person typed: a typed chat is often a title.
 */
export interface RequestEvent {
  event: "request" | "response"
  /** Ours, not the messenger's: `messages.send`. */
  operation: string
  ids?: Record<string, string>
  /** How many things, per field: `{ messages: 3 }`. */
  counts?: Record<string, number>
  durationMs?: number
  outcome?: "ok" | "error"
  /** cli-core's code — `timeout`, `provider_error`. Never the message: a messenger quotes our payload. */
  errorCode?: string
  /** The messenger's own name for a refusal, when it is shaped like one (`providerErrorKey`). */
  providerError?: string
}

/** Something the client noticed and went on without. A code, never the sentence. */
export interface WarningEvent {
  event: "warning"
  code: string
  operation?: string
}

export type DiagnosticEvent = RequestEvent | WarningEvent

export type EventSink = (event: DiagnosticEvent) => void

/** `FLOOD_WAIT`, `PEER_ID_INVALID`, `login.token` — or nothing. A sentence is dropped, not trimmed. */
export const providerErrorKey = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value) ? value : undefined

/**
 * The line a person reads. `→` is what we asked, `←` what came back.
 *
 * ```text
 * → messages.list    chat 777
 * ← messages.list    chat 777  118ms  3 messages
 * ```
 */
export const renderEvent = (event: DiagnosticEvent): string => {
  if (event.event === "warning") return `${MARK.warning} ${(event.operation ?? "").padEnd(16)} ${event.code}`

  const parts: string[] = []
  if (event.ids) for (const [name, value] of Object.entries(event.ids)) parts.push(`${name} ${value}`)
  if (event.durationMs !== undefined) parts.push(`${event.durationMs}ms`)
  if (event.counts) for (const [field, count] of Object.entries(event.counts)) parts.push(`${count} ${field}`)
  if (event.errorCode) parts.push(event.errorCode)
  if (event.providerError) parts.push(event.providerError)

  return `${MARK[event.event]} ${event.operation.padEnd(16)} ${parts.join("  ")}`.trimEnd()
}

const MARK = { request: "→", response: "←", warning: "!" } as const
