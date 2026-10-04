import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths } from "@leemour/cli-core"
import * as v from "valibot"
import type { AppIdentity } from "../cli/app.js"

export const REPLY_ACTIONS = ["reply", "task"] as const
export const REPLY_MODELS = ["fill-only", "may-reword"] as const
/** Channels, saved messages and chats of unknown kind are never answered, so a rule cannot name them. */
export const REPLY_KINDS = ["dialog", "group"] as const
export const PLACEHOLDERS = ["firstName", "name"] as const
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const

export type Day = (typeof DAYS)[number]

const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/
const LIMIT = /^([1-9]\d*)\/([1-9]\d*)(m|h|d)$/
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Minutes after midnight, `[from, to)`; `to` below `from` crosses midnight. */
export interface Window {
  from: number
  to: number
}

/** At most `count` sends inside any `ms`. */
export interface Limit {
  count: number
  ms: number
}

const minutes = (hours: string | undefined, mins: string | undefined) => Number(hours) * 60 + Number(mins)

const window = v.pipe(
  v.string(),
  v.regex(WINDOW, 'a window is written "09:00-19:00", 24-hour'),
  v.transform((typed): Window => {
    const [, h1, m1, h2, m2] = WINDOW.exec(typed) as RegExpExecArray
    return { from: minutes(h1, m1), to: minutes(h2, m2) }
  }),
  v.check((one) => one.from !== one.to, "a window has to start and end at different times"),
)

const dayOf = (typed: string): number => DAYS.indexOf(typed as Day)

/** `mon-fri`, `sat,sun`, `fri-mon` across the week's end. */
const days = v.pipe(
  v.string(),
  v.transform((typed): Day[] | undefined => {
    const found = new Set<Day>()
    for (const part of typed.split(",").map((one) => one.trim().toLowerCase())) {
      const [first = "", last = first] = part.split("-")
      const from = dayOf(first)
      const to = dayOf(last)
      if (from < 0 || to < 0) return undefined
      for (let at = from; ; at = (at + 1) % 7) {
        found.add(DAYS[at] as Day)
        if (at === to) break
      }
    }
    return DAYS.filter((day) => found.has(day))
  }),
  v.check((one) => one !== undefined, `days are written "mon-fri" or "sat,sun", from ${DAYS.join(", ")}`),
  v.transform((one) => one as Day[]),
)

const knownZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const timezone = v.pipe(v.string(), v.check(knownZone, 'a time zone is written as "Europe/Madrid"'))

const limit = v.pipe(
  v.string(),
  v.regex(LIMIT, 'a limit is written "1/12h": this many replies in this long — m, h or d'),
  v.transform((typed): Limit => {
    const [, count, amount, unit] = LIMIT.exec(typed) as RegExpExecArray
    return { count: Number(count), ms: Number(amount) * (UNIT_MS[unit ?? ""] ?? 0) }
  }),
)

const ids = v.array(v.pipe(v.string(), v.minLength(1)))

const template = v.pipe(
  v.string(),
  v.minLength(1, "a reply template cannot be empty"),
  v.check(
    (text) => [...text.matchAll(/\{(\w*)\}/g)].every(([, name]) => PLACEHOLDERS.includes(name as never)),
    `a template fills only ${PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}`,
  ),
)

const rule = v.pipe(
  v.strictObject({
    id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, "a rule id is lower-case letters, digits and -")),
    on: v.boolean(),
    do: v.pipe(v.array(v.picklist(REPLY_ACTIONS)), v.minLength(1, "a rule has to do something: reply")),
    where: v.strictObject({ kinds: v.array(v.picklist(REPLY_KINDS)), chats: ids, notChats: ids }),
    when: v.strictObject({
      hours: v.nullable(v.strictObject({ outside: window, days, timezone })),
      words: v.array(v.pipe(v.string(), v.trim(), v.minLength(1))),
      question: v.boolean(),
      mentionsMe: v.boolean(),
      from: v.strictObject({ people: ids, notPeople: ids, contactsOnly: v.boolean() }),
    }),
    reply: v.strictObject({ template, model: v.picklist(REPLY_MODELS), asReply: v.boolean() }),
    limits: v.strictObject({ perChat: limit, perPerson: limit }),
  }),
  // NEED-582: a rule may open a task, but there is no tasks package to open it in yet.
  v.check((one) => !one.do.includes("task"), '"task" waits for the tasks package; only "reply" works now'),
)

export type ReplyRule = v.InferOutput<typeof rule>

const tester = v.strictObject({
  provider: v.optional(v.pipe(v.string(), v.minLength(1))),
  id: v.pipe(v.string(), v.minLength(1)),
})

export type Tester = v.InferOutput<typeof tester>

const file = v.pipe(
  // NEED-601: rules answer test accounts only, until the owner rules otherwise; no list, nobody.
  v.strictObject({ testers: v.optional(v.array(tester), []), rules: v.array(rule) }),
  v.check(
    ({ rules }) => new Set(rules.map((one) => one.id)).size === rules.length,
    "two rules share an id; each needs its own",
  ),
)

/**
 * Every key written out, so the file shows all there is to set, as moderation's does (max-cli
 * `NEED-314`). Off until the owner turns it on, and the limits are the tightest worth having.
 */
export const defaultRule = (id: string) => ({
  id,
  on: false,
  do: ["reply"],
  where: { kinds: ["dialog"], chats: [], notChats: [] },
  when: {
    hours: null,
    words: [],
    question: false,
    mentionsMe: false,
    from: { people: [], notPeople: [], contactsOnly: false },
  },
  reply: { template: "", model: "fill-only", asReply: true },
  limits: { perChat: "1/1d", perPerson: "1/1d" },
})

export const repliesPathFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).config, `${profile}.replies.json`)

export interface Replies {
  testers: Tester[]
  rules: ReplyRule[]
}

/** The owner's rules, in file order. No file is no rules; a file that does not check out refuses, naming the field. */
export const readReplyRules = (path: string): ReplyRule[] => readReplies(path).rules

export const readReplies = (path: string): Replies => {
  if (!existsSync(path)) return { testers: [], rules: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw broken(path, error instanceof Error ? error.message : String(error))
  }
  return parseReplies(parsed, path)
}

export const parseReplyRules = (parsed: unknown, path: string): ReplyRule[] => parseReplies(parsed, path).rules

export const parseReplies = (parsed: unknown, path: string): Replies => {
  const checked = v.safeParse(file, parsed)
  if (!checked.success) throw broken(path, checked.issues.map(problem).join("; "))
  return checked.output
}

export const isTester = (testers: readonly Tester[], provider: string, id: string | null): boolean =>
  id !== null && testers.some((one) => one.id === id && (one.provider === undefined || one.provider === provider))

const problem = (issue: v.BaseIssue<unknown>): string => {
  const at = v.getDotPath(issue) ?? "the file"
  if (issue.kind === "schema" && issue.expected === "never") return `${at} is not a field a rule has`
  if (issue.expected === "Object" && issue.received === "undefined") return `${at} is missing`
  return `${at}: ${issue.message}`
}

const broken = (path: string, why: string) =>
  new CliError("configuration_error", `the reply rules ${path} cannot be read (${why}) — fix the file`)
