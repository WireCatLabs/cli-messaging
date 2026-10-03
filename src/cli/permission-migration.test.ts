import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, configFilePath, saveConfigFile } from "@leemour/cli-core"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { DEFAULT_PERMISSIONS, fromOldSettings, levelFor, PERMISSIONS, RESOURCES } from "../sends/permissions.js"
import { configCommand } from "./config-command.js"
import { migratePermissionConfig } from "./permission-migration.js"
import { run } from "./program.js"
import { type Config, settingsFor } from "./settings.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "test", version: "0" }
const configuration = settingsFor(app, {
  profile: { mcpTools: v.optional(v.array(v.string())), region: v.optional(v.string()) },
})
const fresh = () => {
  const configDirectory = join(mkdtempSync(join(tmpdir(), "permission-migrate-")), "config")
  return { path: configFilePath(configDirectory), env: { CHAT_CONFIG_DIR: configDirectory } }
}
const call = async (args: string[], env: NodeJS.ProcessEnv) => {
  const streams = captureStreams()
  const code = await run(
    args,
    { app, commands: () => [configCommand(app, configuration)] },
    { env, tty: false, streams },
  )
  return { code, data: JSON.parse(streams.stdout.join("\n") || "null"), error: streams.stderr.join("\n") }
}
const names = ["default", "new-user", "alice", "bob", "constructor"]
const keys = [
  ...new Set([
    ...RESOURCES.filter((key) => key !== "bot"),
    ...Object.keys(DEFAULT_PERMISSIONS).filter((key) => !key.startsWith("bot.")),
    ...Object.keys(fromOldSettings(false, [...PERMISSIONS])),
    "messages.list",
    "messages.send",
    "messages.edit",
    "chats.members.remove",
    "contacts.show",
  ]),
]
const snapshot = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    ["personal", "bot"].flatMap((kind) =>
      names.map((profile) => {
        const settings = configuration.resolveSettings({ profile }, { env, kind: kind as "personal" | "bot" })
        const relevant = kind === "bot" ? ["bot", ...keys.map((key) => `bot.${key}`), "bot.commands"] : keys
        return [`${kind}.${profile}`, relevant.map((key) => [key, levelFor(settings.permissions, key).level])]
      }),
    ),
  )

describe("permission configuration migration", () => {
  it.each(PERMISSIONS)("preserves every old %s allow word in both kinds and every layer", (word) => {
    const { path, env } = fresh()
    const input: Config = {
      defaultProfile: "alice",
      defaults: { allow: [word], region: "shared", mcpTools: ["groups"] },
      profiles: { alice: { allow: [] }, bob: { readOnly: false, allow: ["send"] } },
      personal: { defaults: { readOnly: false }, profiles: { bob: { allow: [word], region: "personal" } } },
      bot: { defaults: { allow: ["profile"] }, profiles: { alice: { allow: [word], readOnly: false } } },
    }
    saveConfigFile(path, input)
    const before = snapshot(env)
    const source = JSON.stringify(input)
    const result = migratePermissionConfig(input)
    expect(JSON.stringify(input)).toBe(source)
    saveConfigFile(path, result.config)
    expect(snapshot(env)).toEqual(before)
    expect(result.changed).toBe(true)
    expect(result.config.defaults?.region).toBe("shared")
    expect(result.config.personal?.profiles?.bob?.region).toBe("personal")
    expect(JSON.stringify(result.config)).not.toMatch(/"(readOnly|allow|mcpTools)":/)
    expect(migratePermissionConfig(result.config)).toMatchObject({ changed: false, changes: [] })
  })

  it("preserves readOnly resets, critical ask defaults and existing canonical overrides", () => {
    const { path, env } = fresh()
    const input: Config = {
      defaults: { readOnly: true, permissions: { "messages.send": "ask", "bot.commands": "allow" } },
      profiles: {
        alice: { readOnly: false },
        bob: { allow: ["delete"], readOnly: false },
        constructor: { readOnly: false, allow: [] },
      },
      personal: { profiles: { alice: { permissions: { "messages.send": "deny", "chats.join": "allow" } } } },
      bot: { defaults: { readOnly: false }, profiles: { bob: { readOnly: true } } },
    }
    saveConfigFile(path, input)
    const before = snapshot(env)
    const migrated = migratePermissionConfig(input)
    saveConfigFile(path, migrated.config)
    expect(snapshot(env)).toEqual(before)
    expect(migrated.config.personal?.profiles?.alice?.permissions).toMatchObject({
      "messages.send": "deny",
      "chats.join": "allow",
    })
    expect(Reflect.get(Object.prototype, "permissions")).toBeUndefined()
    expect(Reflect.get(Object, "permissions")).toBeUndefined()
  })

  it("does not let a replacement allow-list inherit a parent's permitted write", () => {
    const input: Config = { defaults: { allow: ["send"] }, profiles: { alice: { allow: ["reaction"] } } }
    const { path, env } = fresh()
    saveConfigFile(path, input)
    const before = snapshot(env)
    const migrated = migratePermissionConfig(input)
    saveConfigFile(path, migrated.config)
    expect(snapshot(env)).toEqual(before)
    const levels = configuration.resolveSettings({ profile: "alice" }, { env }).permissions
    expect(levelFor(levels, "messages.send").level).toBe("readonly")
    expect(levelFor(levels, "reactions").level).toBe("allow")
  })

  it("previews, applies once and then leaves the same file untouched", async () => {
    const { path, env } = fresh()
    saveConfigFile(path, { profiles: {}, defaults: { allow: ["send"], mcpTools: ["polls"], region: "eu" } })
    const original = readFileSync(path, "utf8")
    const dry = await call(["config", "migrate", "--dry-run", "--json"], env)
    expect(dry.code, dry.error).toBe(0)
    expect(dry.data).toMatchObject({ configFile: path, changed: true, dryRun: true, changes: expect.any(Array) })
    expect(readFileSync(path, "utf8")).toBe(original)
    const applied = await call(["config", "migrate", "--json"], env)
    expect(applied.code, applied.error).toBe(0)
    expect(applied.data).toMatchObject({ changed: true, dryRun: false })
    const written = readFileSync(path, "utf8")
    expect(JSON.parse(written).defaults.region).toBe("eu")
    expect((await call(["config", "migrate", "--json"], env)).data).toMatchObject({ changed: false, changes: [] })
    expect(readFileSync(path, "utf8")).toBe(written)
  })

  it("refuses locked writes while allowing a preview, and does not create a missing file", async () => {
    const { path, env } = fresh()
    const empty = await call(["config", "migrate", "--json"], env)
    expect(empty.code, empty.error).toBe(0)
    expect(empty.data.changed).toBe(false)
    expect(existsSync(path)).toBe(false)
    saveConfigFile(path, { profiles: {}, defaults: { readOnly: true } })
    const original = readFileSync(path, "utf8")
    const locked = { ...env, CHAT_PROFILE_LOCK: "alice" }
    const refused = await call(["config", "migrate", "--json"], locked)
    expect(refused.code).toBe(5)
    expect(readFileSync(path, "utf8")).toBe(original)
    expect((await call(["config", "migrate", "--dry-run", "--json"], locked)).code).toBe(0)
  })

  it.each([{ readOnly: "true" }, { allow: ["typo"] }, { mcpTools: "groups" }, { permissions: { messages: "typo" } }])(
    "refuses malformed legacy or canonical settings without changing the source",
    (defaults) => {
      const input: Config = { profiles: {}, defaults }
      const original = JSON.stringify(input)
      expect(() => migratePermissionConfig(input)).toThrow()
      expect(JSON.stringify(input)).toBe(original)
    },
  )
  it("refuses an invalid input file and an invalid transformed file without writing either", async () => {
    const { path, env } = fresh()
    saveConfigFile(path, { profiles: {}, defaults: { allow: ["typo"] } })
    const original = readFileSync(path, "utf8")
    expect((await call(["config", "migrate", "--json"], env)).code).not.toBe(0)
    expect(readFileSync(path, "utf8")).toBe(original)
    const restricted = settingsFor(app, { profile: { permissions: v.optional(v.never()) } })
    saveConfigFile(path, { profiles: {}, defaults: { readOnly: true } })
    const validLegacy = readFileSync(path, "utf8")
    const streams = captureStreams()
    const code = await run(
      ["config", "migrate", "--json"],
      { app, commands: () => [configCommand(app, restricted)] },
      { env, tty: false, streams },
    )
    expect(code).not.toBe(0)
    expect(streams.stdout).toEqual([])
    expect(readFileSync(path, "utf8")).toBe(validLegacy)
  })
  it.each(["readOnly", "allow", "mcpTools"])(
    "refuses legacy %s edits after migration, including a false-only legacy file",
    async (setting) => {
      const { path, env } = fresh()
      saveConfigFile(path, { profiles: {}, defaults: { readOnly: false } })
      expect((await call(["config", "migrate", "--json"], env)).code).toBe(0)
      const migrated = readFileSync(path, "utf8")
      const edit = await call(["config", "set", setting, setting === "readOnly" ? "true" : "send", "--json"], env)
      expect(edit.code).toBe(2)
      expect(edit.error).toContain("legacy setting")
      expect((await call(["config", "unset", setting, "--json"], env)).code).toBe(2)
      expect(readFileSync(path, "utf8")).toBe(migrated)
    },
  )
})
