import { existsSync } from "node:fs"
import { CliError, configFilePath, loadConfigFile, resolvePaths, saveConfigFile } from "@leemour/cli-core"
import * as v from "valibot"
import { PERMISSIONS, type Permission } from "../sends/permissions.js"
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
  sendsPerHour: v.optional(count),
}

/** One program, one version: whether to look for a newer one is not a per-profile matter. */
const SHARED_DEFAULTS_ONLY = {
  updateCheck: v.optional(flag),
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

export interface Config {
  defaultProfile?: string
  defaults?: Scope
  profiles: Record<string, Scope>
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

export interface Settings {
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
  sendsPerHour: number
  updateCheck: boolean
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
  }
  const schema = v.strictObject(configEntries, objectMessage(Object.keys(configEntries)))
  const defaultsOnlyKeys = Object.keys(defaultsOnly)
  const allSettings = [...Object.keys(profileEntries), ...defaultsOnlyKeys]

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
    const configured = config.profiles[usableProfileName(profile.value)] ?? {}
    const shared = config.defaults ?? {}
    const scopes = { configured, shared }

    const limit = first<number>(
      [
        ["flag", flags.limit],
        ["config file", configured.limit as number | undefined],
        ["config defaults", shared.limit as number | undefined],
      ],
      DEFAULT_LIMIT,
    )
    const record = first<boolean>(
      [
        ["flag", flags.record],
        ["config file", configured.record as boolean | undefined],
        ["config defaults", shared.record as boolean | undefined],
      ],
      false,
    )
    const timeoutMs = fromFile<number | undefined>(scopes, "timeoutMs", undefined)
    const color = fromFile<boolean | undefined>(scopes, "color", undefined)
    const senderColors = fromFile(scopes, "senderColors", false)
    const keepRunsForDays = fromFile(scopes, "keepRunsForDays", DEFAULT_KEEP_RUNS_FOR_DAYS)
    const readOnly = fromFile(scopes, "readOnly", false)
    const allow = fromFile<readonly Permission[] | undefined>(scopes, "allow", undefined)
    const sendsPerHour = fromFile(scopes, "sendsPerHour", DEFAULT_SENDS_PER_HOUR)
    const updateCheck = first([["config defaults", shared.updateCheck as boolean | undefined]], true)
    const timeout = first<string | undefined>(
      [
        ["flag", flags.timeout],
        [TIMEOUT, given(env[TIMEOUT])],
      ],
      undefined,
    )

    const settings: Settings = {
      profile: usableProfileName(profile.value),
      json: flags.json === true,
      jsonl: flags.jsonl === true,
      quiet: flags.quiet === true,
      detail: Math.min(2, Math.max(0, flags.verbose ?? 0)) as 0 | 1 | 2,
      trace: flags.trace === true,
      offline: flags.offline === true,
      color: color.value,
      senderColors: senderColors.value,
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
      sendsPerHour: sendsPerHour.value,
      updateCheck: updateCheck.value,
      configPath,
      configFound: existsSync(configPath),
      configuredProfiles: Object.keys(config.profiles),
      sources: {
        profile: profile.from,
        limit: limit.from,
        timeoutMs: timeoutMs.from,
        commandTimeoutMs: timeout.from,
        color: color.from,
        senderColors: senderColors.from,
        record: record.from,
        keepRunsForDays: keepRunsForDays.from,
        readOnly: readOnly.from,
        allow: allow.from,
        sendsPerHour: sendsPerHour.from,
        updateCheck: updateCheck.from,
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
    Object.keys(readConfig(configPathFor(options)).profiles).sort()

  /** `config set` and `config unset`: checked by the same schema the reader uses, so it never writes a file the reader refuses. */
  const changeSetting = (
    path: string,
    { profile, setting, value }: { profile: string | undefined; setting: string; value: string | undefined },
  ): unknown => {
    if (!allSettings.includes(setting)) {
      throw new CliError("validation_error", `no setting called "${setting}" — one of: ${allSettings.join(", ")}`)
    }
    if (profile !== undefined && defaultsOnlyKeys.includes(setting)) {
      throw new CliError(
        "validation_error",
        `${setting} is one setting for the whole program, not per profile — add --defaults`,
      )
    }

    const config = readConfig(path)
    const scope: Scope = { ...(profile === undefined ? config.defaults : config.profiles[profile]) }
    if (value === undefined) delete scope[setting]
    else scope[setting] = parseValue(value)

    const changed: Config =
      profile === undefined
        ? { ...config, defaults: scope }
        : { ...config, profiles: { ...config.profiles, [profile]: scope } }
    if (profile === undefined && Object.keys(scope).length === 0) delete changed.defaults
    if (profile !== undefined && Object.keys(scope).length === 0) delete changed.profiles[profile]

    const checked = v.safeParse(schema, changed)
    if (!checked.success) {
      throw new CliError(
        "validation_error",
        `${setting} cannot be "${value}": ${checked.issues[0]?.message ?? "invalid"}`,
      )
    }
    saveConfigFile(path, checked.output)
    return scope[setting] ?? null
  }

  return { resolveSettings, configuredProfiles, changeSetting, allSettings, defaultsOnlyKeys, schema }
}

const DURATION = /^(\d+)(ms|s|m)$/
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000 }

/** Named by where it came from, so somebody who set the variable weeks ago is told which thing is wrong. */
export const parseDuration = (value: string, source: string): number => {
  const match = DURATION.exec(value.trim())
  if (!match?.[1] || !match[2]) {
    throw new CliError("validation_error", `${source} takes a duration with a unit — 30s, 2m or 500ms — not "${value}"`)
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
