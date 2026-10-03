import { CliError } from "@leemour/cli-core"
import {
  fromOldSettings,
  LEVELS,
  type Level,
  levelFor,
  PERMISSIONS,
  type Permission,
  RESOURCES,
} from "../sends/permissions.js"
import type { Config, ProfileKind } from "./settings.js"

type Scope = Record<string, unknown>
type Levels = Record<string, Level>
const LEGACY = ["readOnly", "allow", "mcpTools"] as const
const KINDS: ProfileKind[] = ["personal", "bot"]

export interface PermissionMigration {
  config: Config
  changed: boolean
  changes: { scope: string; removed: string[]; permissions: Levels }[]
}

const scopes = (config: Config): Map<string, Scope> =>
  new Map([
    ...(config.defaults ? [["defaults", config.defaults] as const] : []),
    ...Object.entries(config.profiles).map(([name, scope]) => [`profiles.${name}`, scope] as const),
    ...KINDS.flatMap((kind) => [
      ...(config[kind]?.defaults ? [[`${kind}.defaults`, config[kind]?.defaults as Scope] as const] : []),
      ...Object.entries(config[kind]?.profiles ?? {}).map(
        ([name, scope]) => [`${kind}.profiles.${name}`, scope] as const,
      ),
    ]),
  ])
const levels = (scope: Scope | undefined): Levels => (scope?.permissions ?? {}) as Levels
const effective = (config: Config, kind: ProfileKind, profile?: string): Levels => {
  const layers = [
    config.defaults,
    config[kind]?.defaults,
    profile === undefined || !Object.hasOwn(config.profiles, profile) ? undefined : config.profiles[profile],
    profile === undefined || !Object.hasOwn(config[kind]?.profiles ?? {}, profile)
      ? undefined
      : config[kind]?.profiles?.[profile],
  ]
  const readOnly = layers.findLast((scope) => scope?.readOnly !== undefined)?.readOnly === true
  const allow = layers.findLast((scope) => scope?.allow !== undefined)?.allow as Permission[] | undefined
  return Object.assign(fromOldSettings(readOnly, allow, { bot: kind === "bot" }), ...layers.map(levels))
}

/** Input is a schema-validated configuration; legacy fields are checked before any transformation. */
export const migratePermissionConfig = (input: Config): PermissionMigration => {
  const before = scopes(input)
  for (const [name, scope] of before) {
    if (scope.readOnly !== undefined && typeof scope.readOnly !== "boolean")
      throw invalid(`${name}.readOnly must be true or false`)
    if (
      scope.allow !== undefined &&
      (!Array.isArray(scope.allow) || !scope.allow.every((word) => PERMISSIONS.includes(word)))
    )
      throw invalid(`${name}.allow must be a list of known actions`)
    if (
      scope.mcpTools !== undefined &&
      (!Array.isArray(scope.mcpTools) || !scope.mcpTools.every((word) => typeof word === "string"))
    )
      throw invalid(`${name}.mcpTools must be a list`)
    if (
      scope.permissions !== undefined &&
      (scope.permissions === null ||
        typeof scope.permissions !== "object" ||
        Array.isArray(scope.permissions) ||
        !Object.values(scope.permissions).every((level) => LEVELS.includes(level)))
    )
      throw invalid(`${name}.permissions must contain permission levels`)
  }
  if (![...before.values()].some((scope) => LEGACY.some((key) => Object.hasOwn(scope, key))))
    return { config: input, changed: false, changes: [] }
  const next = structuredClone(input)
  for (const scope of scopes(next).values()) for (const key of LEGACY) delete scope[key]
  const names = [
    ...new Set([...Object.keys(input.profiles), ...KINDS.flatMap((kind) => Object.keys(input[kind]?.profiles ?? {}))]),
  ].sort()
  const allMaps = KINDS.flatMap((kind) => [
    effective(input, kind),
    ...names.map((name) => effective(input, kind, name)),
  ])
  const keys = [...new Set([...RESOURCES, ...allMaps.flatMap((map) => Object.keys(map))])].sort(
    (a, b) => a.split(".").length - b.split(".").length || a.localeCompare(b),
  )
  const root = {
    ...effective({ profiles: {}, defaults: input.defaults }, "personal"),
    ...effective({ profiles: {}, defaults: input.defaults }, "bot"),
  }
  next.defaults ??= {}
  next.defaults.permissions = root
  const restore = (kind: ProfileKind, name?: string) => {
    const wanted = effective(input, kind, name)
    for (const key of keys.filter((key) =>
      kind === "bot" ? key === "bot" || key.startsWith("bot.") : key !== "bot" && !key.startsWith("bot."),
    )) {
      const target = levelFor(wanted, key).level
      if (levelFor(effective(next, kind, name), key).level === target) continue
      next[kind] ??= {}
      const section = next[kind]
      let scope: Scope
      if (name === undefined) {
        section.defaults ??= {}
        scope = section.defaults
      } else {
        scope = Object.hasOwn(section.profiles ?? {}, name) ? (section.profiles?.[name] ?? {}) : {}
        section.profiles = { ...section.profiles, [name]: scope }
      }
      scope.permissions = { ...levels(scope), [key]: target }
    }
  }
  // A replacement allow-list must not inherit a permitted child from translated broader defaults.
  for (const kind of KINDS) {
    restore(kind)
    for (const name of names) restore(kind, name)
  }
  const after = scopes(next)
  const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap((scope) => {
    const removed = LEGACY.filter((key) => Object.hasOwn(before.get(scope) ?? {}, key))
    const permissions = levels(after.get(scope))
    return removed.length > 0 || JSON.stringify(levels(before.get(scope))) !== JSON.stringify(permissions)
      ? [{ scope, removed, permissions }]
      : []
  })
  return { config: next, changed: true, changes }
}
const invalid = (message: string) => new CliError("configuration_error", message)

export const hasPermissionConfig = (input: Config): boolean =>
  [...scopes(input).values()].some((scope) => Object.hasOwn(scope, "permissions"))
