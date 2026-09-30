import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { CliError, pathsAreOverridden, resolvePaths } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { type AppIdentity, envName } from "./app.js"
import { baseContext } from "./context.js"
import { type Configuration, fromFile, type Settings } from "./settings.js"

/**
 * The settings in force and where each came from, and changing them. Printed whole: no field the
 * configuration accepts can hold a secret — the schema has nowhere to put one.
 */
export const configCommand = (app: AppIdentity, config: Configuration): Command => {
  const command = new Command("config").description("the settings in force, and where each one came from")

  command
    .command("show")
    .description("the profile, the profiles that exist, and each setting with where it came from")
    .action(function (this: Command) {
      const { settings, renderer, env } = baseContext(this, config.resolveSettings)
      const overridden = pathsAreOverridden({ appName: app.appName, prefix: app.envPrefix, env })

      renderer.result({
        profile: settings.profile,
        profileFrom: settings.sources.profile,
        profiles: [...new Set([...settings.configuredProfiles, ...profilesWithAccounts(app, env)])].sort(),
        configFile: settings.configPath,
        configFound: settings.configFound,
        pathsOverridden: overridden,
        settings: [...config.allSettings, "commandTimeoutMs"].map((setting) => sourced(settings, setting)),
      })

      if (overridden) {
        renderer.note(
          `${envName(app, "CONFIG_DIR")}, ${envName(app, "STATE_DIR")} or ${envName(app, "CACHE_DIR")} is set — ` +
            "a profile's keyring entry is not the usual one, so a session made without them reads as none",
        )
      }
    })

  for (const action of ["set", "unset"] as const) {
    const sub = annotate(command.command(action), { mutates: true })
      .argument("<setting>", `one of: ${config.allSettings.join(", ")}`)
      .option("--defaults", "change what every profile gets, rather than this profile")
    if (action === "set")
      sub
        .argument("<value>", "a number, true or false, or for allow a list like send,reaction")
        .description("save a setting to the configuration file")
    else sub.description("remove a setting from the configuration file")

    sub.action(function (this: Command, setting: string, given: unknown) {
      const { settings, renderer, env } = baseContext(this, config.resolveSettings)
      const defaults = this.opts<{ defaults?: boolean }>().defaults === true
      const lock = envName(app, "PROFILE_LOCK")
      if (defaults && env[lock]) {
        // The defaults are every other profile's settings too.
        throw new CliError(
          "permission_error",
          `this process is locked to profile ${settings.profile} (${lock}) — --defaults changes every profile`,
        )
      }
      const saved = config.changeSetting(settings.configPath, {
        profile: defaults ? undefined : settings.profile,
        setting,
        value: action === "set" ? String(given) : undefined,
      })
      renderer.result({
        configFile: settings.configPath,
        scope: defaults ? "defaults" : `profiles.${settings.profile}`,
        setting,
        value: saved,
      })
    })
  }

  return command
}

/** A shared setting from what was resolved; a messenger's own from the file, where it lives. */
const sourced = (settings: Settings, setting: string) => {
  if (setting in settings.sources) {
    const value = (settings as unknown as Record<string, unknown>)[setting]
    // No list is every action, and `null` would read as none.
    return { setting, value: setting === "allow" ? (value ?? "all") : (value ?? null), from: settings.sources[setting] }
  }
  const { value, from } = fromFile<unknown>(settings, setting, UNLISTED_DEFAULTS[setting] ?? null)
  return { setting, value, from }
}

/** Settings read where they are used rather than in `resolveSettings`, and what an unset one means there. */
const UNLISTED_DEFAULTS: Record<string, unknown> = { transcribeWith: "auto" }

/** Profiles somebody has logged in to, whether or not the configuration file names them. */
const profilesWithAccounts = (app: AppIdentity, env: NodeJS.ProcessEnv): string[] => {
  const dir = join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "accounts")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
}
