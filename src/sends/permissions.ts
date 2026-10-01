import type { AccountAction, SendKind } from "./journal.js"

/**
 * What a profile may be allowed to do (max-cli `CLI-37`, `NEED-251`). One name per thing the owner would
 * recognise, so `sessions` — which logs the owner out of their phone — never rides along with
 * adding a contact. There is no `*`: "everything" is not setting `allow` at all, and a wildcard
 * would switch on `delete` without anyone naming it.
 */
export const PERMISSIONS = [
  "send",
  "forward",
  "reaction",
  "edit",
  "pin",
  "read",
  "delete",
  "groups",
  "contacts",
  "profile",
  "folders",
  "sessions",
] as const

export type Permission = (typeof PERMISSIONS)[number]

const ACCOUNT: Record<AccountAction, Permission> = {
  "contact-add": "contacts",
  "contact-remove": "contacts",
  "contact-import": "contacts",
  "contact-rename": "contacts",
  "contact-block": "contacts",
  "contact-unblock": "contacts",
  profile: "profile",
  "folder-create": "folders",
  "folder-update": "folders",
  "folder-delete": "folders",
  "sessions-end": "sessions",
}

export const permissionFor = (kind: SendKind, action?: string): Permission => {
  switch (kind) {
    case "message":
      return "send"
    case "chat":
      return "groups"
    case "account": {
      const permission = ACCOUNT[action as AccountAction]
      if (!permission) throw new Error(`an account change without a known action: ${action}`)
      return permission
    }
    default:
      return kind
  }
}

/** What a profile may do with one command path — the standard's "Permissions". */
export const LEVELS = ["deny", "readonly", "ask", "allow"] as const

export type Level = (typeof LEVELS)[number]

/** A command path, dotted: `messages`, `messages.delete`, `chats.members.remove`. */
export type PermissionKey = string

/** Only what cannot be undone asks; the tool is meant to work without questions (owner, NEED-460). */
export const DEFAULT_PERMISSIONS: Readonly<Record<PermissionKey, Level>> = {
  "messages.delete": "ask",
  "account.sessions.end": "ask",
  "bot.messages.delete": "ask",
}

/** The resources at the top of the command tree, which `readOnly` and `allow` turn read-only as a whole. */
export const RESOURCES = ["messages", "reactions", "polls", "topics", "chats", "contacts", "account", "bot"] as const

const OLD_WORDS: Record<Permission, PermissionKey[]> = {
  send: ["messages.send", "polls.create"],
  forward: ["messages.forward"],
  reaction: ["reactions", "polls.vote"],
  edit: ["messages.edit", "polls.close"],
  pin: ["messages.pin"],
  read: ["chats.mark-read"],
  delete: ["messages.delete"],
  groups: [
    "chats.create",
    "chats.update",
    "chats.join",
    "chats.leave",
    "chats.members",
    "chats.admins",
    "chats.link",
    "chats.requests",
    "chats.moderate",
  ],
  contacts: ["contacts"],
  profile: ["account.update"],
  folders: ["chats.folders"],
  sessions: ["account.sessions.end"],
}

/** The command path an old `allow` word stood for, as one key — what an MCP tool's `permission` is checked against. */
export const keyOfWord = (word: Permission): PermissionKey => OLD_WORDS[word][0] as PermissionKey

/** `readOnly` and `allow` as levels, so a file written before `permissions` keeps meaning what it meant. */
/**
 * A bot's old words meant its own writes: `profile` was its command menu, and `read` was taking
 * updates, which every level but `deny` allows now.
 */
const botKeysOf = (word: Permission): PermissionKey[] => {
  if (word === "profile") return ["bot.commands"]
  if (word === "read") return []
  return OLD_WORDS[word].map((key) => `bot.${key}`)
}

/** `bot` translates a bot's `readOnly` and `allow`, which only ever covered the bot. */
export const fromOldSettings = (
  readOnly: boolean,
  allow: readonly Permission[] | undefined,
  { bot = false }: { bot?: boolean } = {},
): Record<PermissionKey, Level> => {
  if (!readOnly && allow === undefined) return {}
  const levels: Record<PermissionKey, Level> = bot
    ? { bot: "readonly" }
    : Object.fromEntries(RESOURCES.filter((resource) => resource !== "bot").map((resource) => [resource, "readonly"]))
  if (readOnly) return levels
  // A deletion needed its flag whatever `allow` said, so it keeps asking.
  for (const word of allow ?? []) {
    for (const key of bot ? botKeysOf(word) : OLD_WORDS[word]) levels[key] = DEFAULT_PERMISSIONS[key] ?? "allow"
  }
  return levels
}

const ALLOWED = { level: "allow", key: null } as const

const ORDER: Record<Level, number> = { deny: 0, readonly: 1, ask: 2, allow: 3 }

const nearest = (levels: Readonly<Record<PermissionKey, Level>>, key: PermissionKey) => {
  for (let parts = key.split("."); parts.length > 0; parts = parts.slice(0, -1)) {
    const named = parts.join(".")
    const level = levels[named]
    if (level) return { level, key: named, depth: parts.length }
  }
  return undefined
}

/**
 * The most specific key the owner set wins. A built-in default (`DEFAULT_PERMISSIONS`) only ever
 * tightens: against a broader key of the owner's, the stricter of the two holds — so
 * `messages: readonly` still stops a deletion, and `messages: allow` does not drop its question.
 * A path nothing names is allowed.
 */
export const levelFor = (
  permissions: Readonly<Record<PermissionKey, Level>>,
  key: PermissionKey,
  defaults: Readonly<Record<PermissionKey, Level>> = DEFAULT_PERMISSIONS,
): { level: Level; key: PermissionKey | null } => {
  const own = nearest(permissions, key)
  const builtIn = nearest(defaults, key)
  if (!builtIn || (own && own.depth >= builtIn.depth)) return own ? { level: own.level, key: own.key } : ALLOWED
  if (!own || ORDER[builtIn.level] <= ORDER[own.level]) return { level: builtIn.level, key: builtIn.key }
  return { level: own.level, key: own.key }
}

const CHAT_KEYS: Partial<Record<string, PermissionKey>> = { settings: "chats.update" }

const ACCOUNT_KEYS: Record<AccountAction, PermissionKey> = {
  "contact-add": "contacts.add",
  "contact-remove": "contacts.remove",
  "contact-import": "contacts.import",
  "contact-rename": "contacts.rename",
  "contact-block": "contacts.block",
  "contact-unblock": "contacts.unblock",
  profile: "account.update",
  "folder-create": "chats.folders.create",
  "folder-update": "chats.folders.update",
  "folder-delete": "chats.folders.delete",
  "sessions-end": "account.sessions.end",
}

const KIND_KEYS: Record<Exclude<SendKind, "chat" | "account">, PermissionKey> = {
  message: "messages.send",
  forward: "messages.forward",
  edit: "messages.edit",
  pin: "messages.pin",
  reaction: "reactions",
  read: "chats.mark-read",
  delete: "messages.delete",
}

/** The command path a guarded write belongs to, when the caller did not name it. */
export const keyForWrite = (kind: SendKind, action?: string): PermissionKey => {
  if (kind === "chat") return CHAT_KEYS[action ?? ""] ?? `chats.${action ?? "update"}`
  if (kind === "account") {
    const key = ACCOUNT_KEYS[action as AccountAction]
    if (!key) throw new Error(`an account change without a known action: ${action}`)
    return key
  }
  return KIND_KEYS[kind]
}

/** Commands that look after the tool and its files and never show a message: no level stops them. */
const HOUSEKEEPING = new Set([
  "config",
  "session",
  "doctor",
  "commands",
  "complete",
  "upgrade",
  "skill",
  "models",
  "server",
  "runs",
  "sends",
  "recipients",
  "mcp",
])

/** Under `bot`: its token, its names, its lists and its MCP server. */
const BOT_HOUSEKEEPING = new Set(["auth", "list", "sends", "recipients", "mcp"])

const STORE_MAINTENANCE = new Set(["info", "check", "migrate", "backup", "restore"])

/** Commands outside `messages` that print what people wrote, so `deny messages` reaches them too. */
const SHOW_MESSAGES = new Set(["inbox", "review", "watch", "serve", "store"])

/**
 * The key a command path is checked against: `null` for housekeeping, which no level stops, and
 * `undefined` for a path this package does not know — a CLI's own command, which its CLI maps.
 */
export const keyForCommand = (path: readonly string[]): PermissionKey | null | undefined => {
  const [top, next] = path
  if (top === "bot") {
    if (next === undefined || BOT_HOUSEKEEPING.has(next)) return null
    const inner = keyForCommand(path.slice(1))
    return `bot.${inner ?? path.slice(1).join(".")}`
  }
  if (top === undefined || HOUSEKEEPING.has(top)) return null
  if (top === "store" && next !== undefined && STORE_MAINTENANCE.has(next)) return null
  if (SHOW_MESSAGES.has(top)) return "messages"
  if ((RESOURCES as readonly string[]).includes(top)) return path.join(".")
  return undefined
}
