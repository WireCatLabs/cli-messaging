import { existsSync } from "node:fs"
import { CliError, configFilePath, loadConfigFile, resolvePaths, saveConfigFile } from "@leemour/cli-core"
import * as v from "valibot"
import { AI_DEFAULTS, AI_ENTRIES, type AISettings } from "../analysis/settings.js"
import {
  fromOldSettings,
  LEVELS,
  type Level,
  layerPermissions,
  PERMISSIONS,
  type Permission,
  type PermissionKey,
  RESOURCES,
} from "../sends/permissions.js"
import { type AppIdentity, envName } from "./app.js"
import { DEFAULT_PROFILE, usableProfileName } from "./profile.js"

const DEFAULT_LIMIT = 20
const DEFAULT_KEEP_RUNS_FOR_DAYS = 30
/** On by default: a limit that is off protects nobody from a loop. */
const DEFAULT_SENDS_PER_HOUR = 30

export const plain =
  (rule: string) =>
  (issue: v.BaseIssue<unknown>): string =>
    `${rule}, not ${issue.received}`
const wholeNumber = plain("has to be a whole number, 1 or more")
export const count = v.pipe(v.number(wholeNumber), v.integer(wholeNumber), v.minValue(1, wholeNumber))
export const flag = v.boolean(plain("has to be true or false"))
const permissionList = v.array(
  v.picklist(PERMISSIONS, (issue) => `has to be one of ${PERMISSIONS.join(", ")}, not ${issue.received}`),
  plain("has to be a list of actions, like send,reaction"),
)

const permissionLevels = v.record(
  v.pipe(
    v.string(),
    v.regex(
      new RegExp(`^(${RESOURCES.join("|")})(\\.[a-z][a-z-]*)*$`),
      (issue) => `${issue.input} is not a command path — it starts with one of ${RESOURCES.join(", ")}`,
    ),
  ),
  v.picklist(LEVELS, (issue) => `has to be one of ${LEVELS.join(", ")}, not ${issue.received}`),
  plain('has to be an object of command paths and levels, like {"messages.delete": "ask"}'),
)

/** valibot's own words ("Expected never but received …") mean nothing to someone editing a file. */
const objectMessage =
  (known: string[]): v.ErrorMessage<v.StrictObjectIssue> =>
  (issue) =>
    issue.expected === "never"
      ? `unknown setting — the known ones are ${known.join(", ")}`
      : "has to be an object, in braces"

/**
 * What every messenger CLI's profile can set. ⚠ Read through `strictObject`, so an unknown key is an
 * error: `object()` drops what it does not recognise, and a misspelled setting would run with the
 * default and never say why.
 *
 * **No field here can hold a secret.** No token, no phone number, no chat id: a schema with nowhere
 * to put one is stronger than a rule saying do not put one there.
 */
const SHARED_PROFILE_ENTRIES = {
  limit: v.optional(count),
  timeoutMs: v.optional(count),
  color: v.optional(flag),
  senderColors: v.optional(flag),
  record: v.optional(flag),
  keepRunsForDays: v.optional(count),
  readOnly: v.optional(flag),
  allow: v.optional(permissionList),
  permissions: v.optional(permissionLevels),
  sendsPerHour: v.optional(count),
  transcribeWith: v.optional(v.picklist(["auto", "messenger", "local"], plain("has to be auto, messenger or local"))),
  speechModel: v.optional(v.string(plain("has to be a model id from `models audio list`, in quotes"))),
  catchUpMarksRead: v.optional(flag),
  ...AI_ENTRIES,
}

/**
 * Only a bot reads these. `readOtherBots`: whether this bot may read the local copy of other bots on
 * this machine — every one, or those named — when a command asks for it.
 */
const BOT_ONLY_ENTRIES = {
  readOtherBots: v.optional(
    v.union(
      [flag, v.array(v.string(), plain("has to be a list of profile names"))],
      plain("has to be true, false or a list of profile names"),
    ),
  ),
}

/** One program, one version: whether to look for a newer one is not a per-profile matter. */
const SHARED_DEFAULTS_ONLY = {
  updateCheck: v.optional(flag),
  skillHint: v.optional(flag),
}

/**
 * **What one messenger adds to the file**, merged into the one strict schema — a field an adapter
 * reads but the schema did not know would be refused as unknown. Each entry must be optional.
 */
export interface SettingsExtension {
  profile?: v.ObjectEntries
  /** For the whole program only, never per profile. */
  defaults?: v.ObjectEntries
}

type Scope = Record<string, unknown>

/** Which side of a profile a command speaks for: `<tool> <profile> bot …` is the bot, every other command the account. */
export type ProfileKind = "personal" | "bot"

/** Every personal account, or every bot, and then one of them by name. */
interface KindSection {
  defaults?: Scope
  profiles?: Record<string, Scope>
}

export interface Config {
  defaultProfile?: string
  defaults?: Scope
  profiles: Record<string, Scope>
  personal?: KindSection
  bot?: KindSection
}

/** Whatever the command line carried. Everything is optional: absent means "not given here". */
export interface GlobalFlags {
  profile?: string
  json?: boolean
  jsonl?: boolean
  quiet?: boolean
  verbose?: number
  trace?: boolean
  limit?: number
  page?: number
  all?: boolean
  record?: boolean
  offline?: boolean
  /** Raw text from `--timeout`, parsed here so the unit rule lives in one place. */
  timeout?: string
}

/** `first word`, `flag`, `TG_PROFILE`, `config file`, `config defaults`, `default`… */
export type Source = string

export interface Settings extends AISettings {
  profile: string
  json: boolean
  jsonl: boolean
  quiet: boolean
  /** How much of what the model knows a human view shows: `-v`, `-vv`. */
  detail: 0 | 1 | 2
  trace: boolean
  offline: boolean
  /** Unset means "decide from the terminal", which is `resolveOutput`'s job, not this one's. */
  color: boolean | undefined
  senderColors: boolean
  /** `inbox` and `review` mark each chat they show read, as `--mark-read` does; the other side sees it. Off unless set. */
  catchUpMarksRead: boolean
  limit: number
  /** Which page, 1-based. Per invocation only — a page number in a file is a setting nobody wants twice. */
  page: number
  all: boolean
  /** One request's wait. Unset means the transport's own default. */
  timeoutMs: number | undefined
  /**
   * How long the **whole command** may take, or `undefined` for no bound. ⚠ Not `timeoutMs`: one
   * read is a connect, a login, a name to resolve and the request itself. They are spelled
   * differently on purpose — milliseconds in the file, a duration with a unit on the command line.
   */
  commandTimeoutMs: number | undefined
  record: boolean
  /** A failed run is kept even unrecorded, unless recording was turned off by name. */
  keepFailedRuns: boolean
  keepRunsForDays: number
  readOnly: boolean
  /** `undefined` is every action; a list is only those. */
  allow: readonly Permission[] | undefined
  /**
   * The levels the owner set — `readOnly` and `allow` folded in under what the file's `permissions`
   * says. The built-in defaults are not here: `levelFor` adds them, and they only ever tighten.
   */
  permissions: Readonly<Record<PermissionKey, Level>>
  /** Where each key of `permissions` came from. */
  permissionSources: Readonly<Record<PermissionKey, Source>>
  sendsPerHour: number
  /** The side these settings are for. */
  kind: ProfileKind
  /** A bot only: which other bots' local copy it may read when a command asks. Always `false` for the account. */
  readOtherBots: boolean | readonly string[]
  updateCheck: boolean
  /** Whether an agent is told, once a day, that `<cli> skill install` would give it this tool's guide. */
  skillHint: boolean
  configPath: string
  configFound: boolean
  /** Profiles the configuration file names, whether or not anyone has logged in to them. */
  configuredProfiles: string[]
  /** Where each value came from — `config show` prints it. */
  sources: Record<string, Source>
  /** This profile's entries and the shared defaults, for an adapter resolving its own fields with `first`. */
  configured: Scope
  shared: Scope
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  configDir?: string
  /** `personal` unless given. */
  kind?: ProfileKind
}

/** The first candidate that is set, and which layer it came from. */
export const first = <T>(candidates: [Source, T | undefined][], fallback: T): { value: T; from: Source } => {
  for (const [from, value] of candidates) if (value !== undefined) return { value, from }
  return { value: fallback, from: "default" }
}

/** A value of an adapter's own field, from the profile, then the shared defaults, then the built-in one. */
export const fromFile = <T>(settings: Pick<Settings, "configured" | "shared">, key: string, fallback: T) =>
  first<T>(
    [
      ["config file", settings.configured[key] as T | undefined],
      ["config defaults", settings.shared[key] as T | undefined],
    ],
    fallback,
  )

/**
 * Everything one CLI needs to read and change its configuration, built once for its identity and
 * its extension. **Flag → environment → config file → built-in default**, decided here and only
 * here; a command that re-derived the order would disagree with the others.
 */
export const settingsFor = (app: AppIdentity, extension: SettingsExtension = {}) => {
  const profileEntries = { ...SHARED_PROFILE_ENTRIES, ...extension.profile }
  const defaultsOnly = { ...SHARED_DEFAULTS_ONLY, ...extension.defaults }
  const defaultsEntries = { ...profileEntries, ...defaultsOnly }
  const strictOf = (entries: v.ObjectEntries) => v.strictObject(entries, objectMessage(Object.keys(entries)))
  const kindSection = (entries: v.ObjectEntries) =>
    v.strictObject(
      {
        defaults: v.optional(strictOf(entries)),
        profiles: v.optional(v.record(v.string(), strictOf(entries), "has to be an object of profiles, by name")),
      },
      objectMessage(["defaults", "profiles"]),
    )
  const configEntries = {
    defaultProfile: v.optional(v.string(plain("has to be a profile name, in quotes"))),
    defaults: v.optional(v.strictObject(defaultsEntries, objectMessage(Object.keys(defaultsEntries)))),
    profiles: v.optional(
      v.record(
        v.string(),
        v.strictObject(profileEntries, objectMessage(Object.keys(profileEntries))),
        "has to be an object of profiles, by name",
      ),
      {},
    ),
    personal: v.optional(kindSection(profileEntries)),
    bot: v.optional(kindSection({ ...profileEntries, ...BOT_ONLY_ENTRIES })),
  }
  const schema = v.strictObject(configEntries, objectMessage(Object.keys(configEntries)))
  const defaultsOnlyKeys = Object.keys(defaultsOnly)
  const botOnlyKeys = Object.keys(BOT_ONLY_ENTRIES)
  const allSettings = [...Object.keys(profileEntries), ...botOnlyKeys, ...defaultsOnlyKeys]

  const PROFILE = envName(app, "PROFILE")
  const PROFILE_LOCK = envName(app, "PROFILE_LOCK")
  const TIMEOUT = envName(app, "TIMEOUT")

  const configPathFor = ({ env = process.env, configDir }: ResolveOptions) =>
    configFilePath(configDir ?? resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).config)

  const readConfig = (path: string): Config => {
    try {
      return loadConfigFile(path, schema, () => ({ profiles: {} })) as Config
    } catch (error) {
      throw new CliError("configuration_error", error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * A lock pins a process to one profile: the owner sets it where an agent runs, and a first word
   * or `<PREFIX>_PROFILE` naming any other profile is refused rather than obeyed. What the agent
   * could otherwise do is pick the profile with fewer guards.
   */
  const locked = (profile: { value: string; from: Source }, lock: string | undefined) => {
    if (lock === undefined) return profile
    usableProfileName(lock)
    if (profile.value === lock) return profile
    if (profile.from === "first word" || profile.from === PROFILE) {
      throw new CliError(
        "permission_error",
        `this process is locked to profile ${lock} (${PROFILE_LOCK}) — profile ${profile.value} is refused`,
      )
    }
    return { value: lock, from: PROFILE_LOCK }
  }

  const resolveSettings = (flags: GlobalFlags = {}, options: ResolveOptions = {}): Settings => {
    const env = options.env ?? process.env
    const configPath = configPathFor(options)
    const config = readConfig(configPath)

    const profile = locked(
      first(
        [
          ["first word", flags.profile],
          [PROFILE, given(env[PROFILE])],
          ["config file", config.defaultProfile],
        ],
        DEFAULT_PROFILE,
      ),
      given(env[PROFILE_LOCK]),
    )
    const kind = options.kind ?? "personal"
    const name = usableProfileName(profile.value)
    const configured = config.profiles[name] ?? {}
    const shared = config.defaults ?? {}
    const section = config[kind]
    // The most specific entry wins: this profile's personal or bot entry, the profile, every
    // personal account or every bot, everyone. Naming one account says more than naming them all.
    const layers: [Source, Scope | undefined][] = [
      [`config file: ${kind}.profiles.${name}`, section?.profiles?.[name]],
      ["config file", configured],
      [`config file: ${kind}.defaults`, section?.defaults],
      ["config defaults", shared],
    ]
    const fromLayers = <T>(key: string, fallback: T, only = layers) =>
      first<T>(
        only.map(([from, scope]): [Source, T | undefined] => [from, scope?.[key] as T | undefined]),
        fallback,
      )
    const kindLayers = layers.filter(([from]) => from.startsWith(`config file: ${kind}.`))

    const limit = flags.limit === undefined ? fromLayers("limit", DEFAULT_LIMIT) : { value: flags.limit, from: "flag" }
    const record = flags.record === undefined ? fromLayers("record", false) : { value: flags.record, from: "flag" }
    const timeoutMs = fromLayers<number | undefined>("timeoutMs", undefined)
    const color = fromLayers<boolean | undefined>("color", undefined)
    const senderColors = fromLayers("senderColors", false)
    const catchUpMarksRead = fromLayers("catchUpMarksRead", false)
    const keepRunsForDays = fromLayers("keepRunsForDays", DEFAULT_KEEP_RUNS_FOR_DAYS)
    const readOnly = fromLayers("readOnly", false)
    const allow = fromLayers<readonly Permission[] | undefined>("allow", undefined)
    // A bot has no hourly limit unless the bot section gives it one: a bot that answers people is
    // expected to send a lot, and a limit there is the owner's choice, not the tool's.
    const sendsPerHour =
      kind === "bot"
        ? fromLayers("sendsPerHour", Number.POSITIVE_INFINITY, kindLayers)
        : fromLayers("sendsPerHour", DEFAULT_SENDS_PER_HOUR)
    const readOtherBots =
      kind === "bot"
        ? fromLayers<boolean | readonly string[]>("readOtherBots", false, kindLayers)
        : { value: false, from: "default" }
    // The old settings sit in the layer they were written in, under that layer's own `permissions`.
    const old = readOnly.value ? { label: "readOnly", from: readOnly.from } : { label: "allow", from: allow.from }
    const oldLevels = fromOldSettings(readOnly.value, allow.value, { bot: kind === "bot" })
    const permissions = layerPermissions(
      layers.flatMap(([from, scope]): [Source, Record<PermissionKey, Level> | undefined][] => [
        [from, scope?.permissions as Record<PermissionKey, Level> | undefined],
        ...(from === old.from ? [[old.label, oldLevels] as [Source, Record<PermissionKey, Level>]] : []),
      ]),
    )
    const updateCheck = first([["config defaults", shared.updateCheck as boolean | undefined]], true)
    const skillHint = first([["config defaults", shared.skillHint as boolean | undefined]], true)
    const timeout = first<string | undefined>(
      [
        ["flag", flags.timeout],
        [TIMEOUT, given(env[TIMEOUT])],
      ],
      undefined,
    )

    const ai = Object.fromEntries(
      Object.entries(AI_ENTRIES).map(([key, schema]) => {
        const variable = envName(app, key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase())
        const raw = given(env[variable])
        const value = first<unknown>(
          [
            [variable, raw === undefined ? undefined : key === "embeddingDims" ? Number(raw) : raw],
            ...layers.map(([from, scope]): [Source, unknown] => [from, scope?.[key]]),
          ],
          AI_DEFAULTS[key as keyof AISettings],
        )
        const checked = v.safeParse(schema, value.value)
        if (!checked.success) throw new CliError("configuration_error", `${key} from ${value.from} is invalid`)
        return [key, { value: checked.output, from: value.from }]
      }),
    )
    const settings: Settings = {
      ...Object.fromEntries(Object.entries(ai).map(([key, item]) => [key, item.value])),
      profile: usableProfileName(profile.value),
      json: flags.json === true,
      jsonl: flags.jsonl === true,
      quiet: flags.quiet === true,
      detail: Math.min(2, Math.max(0, flags.verbose ?? 0)) as 0 | 1 | 2,
      trace: flags.trace === true,
      offline: flags.offline === true,
      color: color.value,
      senderColors: senderColors.value,
      catchUpMarksRead: catchUpMarksRead.value,
      limit: limit.value,
      page: flags.page ?? 1,
      all: flags.all === true,
      timeoutMs: timeoutMs.value,
      commandTimeoutMs:
        timeout.value === undefined
          ? undefined
          : parseDuration(timeout.value, timeout.from === TIMEOUT ? TIMEOUT : "--timeout"),
      record: record.value,
      keepFailedRuns: record.value || record.from === "default",
      keepRunsForDays: keepRunsForDays.value,
      readOnly: readOnly.value,
      allow: allow.value,
      permissions: permissions.levels,
      permissionSources: permissions.sources,
      sendsPerHour: sendsPerHour.value,
      kind,
      readOtherBots: readOtherBots.value,
      updateCheck: updateCheck.value,
      skillHint: skillHint.value,
      configPath,
      configFound: existsSync(configPath),
      configuredProfiles: namedProfiles(config),
      sources: {
        ...Object.fromEntries(Object.entries(ai).map(([key, item]) => [key, item.from])),
        profile: profile.from,
        limit: limit.from,
        timeoutMs: timeoutMs.from,
        commandTimeoutMs: timeout.from,
        color: color.from,
        senderColors: senderColors.from,
        catchUpMarksRead: catchUpMarksRead.from,
        record: record.from,
        keepRunsForDays: keepRunsForDays.from,
        readOnly: readOnly.from,
        allow: allow.from,
        sendsPerHour: sendsPerHour.from,
        readOtherBots: readOtherBots.from,
        updateCheck: updateCheck.from,
        skillHint: skillHint.from,
      },
      configured,
      shared,
    }

    // The file was checked by the schema; a flag was not, and `--limit abc` is `NaN` by the time it
    // gets here, which slices an array to nothing without complaining.
    if (!Number.isInteger(settings.limit) || settings.limit < 1) {
      throw new CliError("validation_error", `--limit takes a whole number from 1 upwards, not ${flags.limit}`)
    }
    if (!Number.isInteger(settings.page) || settings.page < 1) {
      throw new CliError("validation_error", `--page takes a whole number from 1 upwards, not ${flags.page}`)
    }
    // Refused rather than resolved: one of the two would silently win.
    if (settings.all && flags.page !== undefined) {
      throw new CliError("validation_error", "--all and --page ask for different things; use one or the other")
    }
    return settings
  }

  const configuredProfiles = (options: ResolveOptions = {}): string[] =>
    namedProfiles(readConfig(configPathFor(options)))

  /** `config set` and `config unset`: checked by the same schema the reader uses, so it never writes a file the reader refuses. */
  const changeSetting = (
    path: string,
    {
      profile,
      setting,
      value,
      kind,
    }: { profile: string | undefined; setting: string; value: string | undefined; kind?: ProfileKind | undefined },
  ): unknown => {
    const [name = setting, ...rest] = setting.split(".")
    const level = name === "permissions" && rest.length > 0 ? rest.join(".") : undefined
    if (!allSettings.includes(setting) && level === undefined) {
      throw new CliError("validation_error", `no setting called "${setting}" — one of: ${allSettings.join(", ")}`)
    }
    if (profile !== undefined && defaultsOnlyKeys.includes(setting)) {
      throw new CliError(
        "validation_error",
        `${setting} is one setting for the whole program, not per profile — add --defaults`,
      )
    }
    if (kind !== undefined && defaultsOnlyKeys.includes(setting)) {
      throw new CliError("validation_error", `${setting} is one setting for the whole program, not per side`)
    }
    if (kind !== "bot" && botOnlyKeys.includes(setting)) {
      throw new CliError("validation_error", `${setting} is a bot's setting — add --bot`)
    }

    const config = readConfig(path)
    const section = kind === undefined ? undefined : (config[kind] ?? {})
    const current =
      section === undefined
        ? profile === undefined
          ? config.defaults
          : config.profiles[profile]
        : profile === undefined
          ? section.defaults
          : section.profiles?.[profile]
    const scope: Scope = { ...current }
    if (level !== undefined) {
      const levels = { ...(scope.permissions as Record<PermissionKey, string> | undefined) }
      if (value === undefined) delete levels[level]
      else levels[level] = value.trim()
      if (Object.keys(levels).length > 0) scope.permissions = levels
      else delete scope.permissions
    } else if (value === undefined) delete scope[setting]
    else scope[setting] = parseValue(value)

    const empty = Object.keys(scope).length === 0
    let changed: Config
    if (kind === undefined || section === undefined) {
      changed =
        profile === undefined
          ? { ...config, defaults: scope }
          : { ...config, profiles: { ...config.profiles, [profile]: scope } }
      if (profile === undefined && empty) delete changed.defaults
      if (profile !== undefined && empty) delete changed.profiles[profile]
    } else {
      const next: KindSection =
        profile === undefined
          ? { ...section, defaults: scope }
          : { ...section, profiles: { ...section.profiles, [profile]: scope } }
      if (profile === undefined && empty) delete next.defaults
      if (profile !== undefined && empty && next.profiles) delete next.profiles[profile]
      if (next.profiles && Object.keys(next.profiles).length === 0) delete next.profiles
      changed = { ...config, [kind]: next }
      if (Object.keys(next).length === 0) delete changed[kind]
    }

    const checked = v.safeParse(schema, changed)
    if (!checked.success) {
      throw new CliError(
        "validation_error",
        `${setting} cannot be "${value}": ${checked.issues[0]?.message ?? "invalid"}`,
      )
    }
    saveConfigFile(path, checked.output)
    return level === undefined ? (scope[setting] ?? null) : ((scope.permissions as Scope | undefined)?.[level] ?? null)
  }

  return { resolveSettings, configuredProfiles, changeSetting, allSettings, defaultsOnlyKeys, schema }
}

/** Every profile the file names, in any section. */
const namedProfiles = (config: Config): string[] =>
  [
    ...new Set([
      ...Object.keys(config.profiles),
      ...Object.keys(config.personal?.profiles ?? {}),
      ...Object.keys(config.bot?.profiles ?? {}),
    ]),
  ].sort()

const DURATION = /^(\d+)(ms|s|m|h|d)$/
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Named by where it came from, so somebody who set the variable weeks ago is told which thing is wrong. */
export const parseDuration = (value: string, source: string): number => {
  const match = DURATION.exec(value.trim())
  if (!match?.[1] || !match[2]) {
    throw new CliError(
      "validation_error",
      `${source} takes a duration with a unit — 500ms, 30s, 2m, 4h or 1d — not "${value}"`,
    )
  }
  const ms = Number(match[1]) * (UNIT_MS[match[2]] ?? 0)
  if (ms <= 0) throw new CliError("validation_error", `${source} has to be more than zero, and "${value}" is not`)
  return ms
}

/** A list is written `a,b` on the command line and kept as an array; everything else is JSON or a string. */
const parseValue = (value: string): unknown => {
  const trimmed = value.trim()
  if (/^[^[{"]/.test(trimmed) && trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  }
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const given = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

/** What `settingsFor` hands a CLI — named, so a CLI can export it without naming the schema library's types. */
export type Configuration = ReturnType<typeof settingsFor>
