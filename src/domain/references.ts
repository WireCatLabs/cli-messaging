import { CliError, singleLine } from "@leemour/cli-core"
import { formatLocator, parseLocator } from "./locator.js"

/**
 * One typed form for every kind of thing a link, a tag or an argument can name. The prefix makes a
 * wrong kind fail loudly instead of matching another row. Parts that are ids of someone else's system
 * are percent-encoded, as in a message locator, so no id can add a part.
 */
export type Reference =
  | { type: "message"; provider: string; account: string; chat: string; message: string }
  | { type: "chat"; provider: string; account: string; chat: string }
  | { type: "contact"; provider: string; id: string }
  | { type: "note"; id: string }
  | { type: "person"; id: string }
  | { type: "entity"; id: string }
  | { type: "task"; id: string }

const parts = (rest: string, count: number, reference: string, shape: string) => {
  const split = rest.split("/")
  if (split.length !== count || split.some((part) => part === ""))
    throw new CliError("validation_error", `"${singleLine(reference)}" is not a reference — expected ${shape}`)
  return split.map(decodeURIComponent)
}

export const formatReference = (reference: Reference): string => {
  switch (reference.type) {
    case "message":
      return formatLocator(reference)
    case "chat":
      return `chat:${[reference.provider, reference.account, reference.chat].map(encodeURIComponent).join("/")}`
    case "contact":
      return `contact:${[reference.provider, reference.id].map(encodeURIComponent).join("/")}`
    default:
      return `${reference.type}:${reference.id}`
  }
}

export const parseReference = (text: string): Reference => {
  const reference = text.trim()
  const colon = reference.indexOf(":")
  const prefix = colon < 0 ? "" : reference.slice(0, colon)
  const rest = reference.slice(colon + 1)
  switch (prefix) {
    case "msg":
      return { type: "message", ...parseLocator(reference) }
    case "chat": {
      const [provider, account, chat] = parts(rest, 3, reference, "chat:<provider>/<account>/<chat>") as [
        string,
        string,
        string,
      ]
      return { type: "chat", provider, account, chat }
    }
    case "contact": {
      const [provider, id] = parts(rest, 2, reference, "contact:<provider>/<id>") as [string, string]
      return { type: "contact", provider, id }
    }
    case "note":
    case "person":
    case "entity":
    case "task":
      if (!rest.trim()) throw new CliError("validation_error", `"${singleLine(reference)}" names no ${prefix}`)
      return { type: prefix, id: rest }
    default:
      throw new CliError(
        "validation_error",
        `"${singleLine(reference)}" is not a reference — expected msg:, chat:, contact:, note:, person:, entity: or task:`,
      )
  }
}

/** The stored spelling of a reference, so two spellings of one thing compare equal. */
export const canonicalReference = (text: string): string => formatReference(parseReference(text))
