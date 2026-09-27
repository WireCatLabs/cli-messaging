import { EXIT_CODES, GENERIC_FAILURE } from "@leemour/cli-core"
import { describeOptions, describeProgram, flatten } from "@leemour/cli-core/commands"
import { Command } from "commander"
import type { AppIdentity } from "./app.js"
import { outputFor } from "./context.js"
import { rootOf } from "./profile.js"

/**
 * The major version of the JSON every command prints. The output types live in this package, so the
 * contract is this package's: raise it with a major version, when a field is removed or renamed.
 */
export const CONTRACT = 0

/**
 * The discovery surface an agent reads instead of `--help`. It opens no store, no session and no
 * settings file: which commands exist does not depend on whether this machine has logged in.
 */
export const commandsCommand = (app: AppIdentity): Command =>
  new Command("commands")
    .description("every command, option and exit code as JSON — what an agent reads instead of --help")
    .action(function (this: Command) {
      const root = rootOf(this)
      const { renderer, format } = outputFor(this)
      const commands = describeProgram(root)

      if (format === "pretty") {
        renderer.result(
          flatten(commands).map(({ usage, summary, description, mutates, state }) => ({
            command: usage,
            description: summary ?? description,
            writes: mutates ? "yes" : "",
            ...(state ? { state } : {}),
          })),
        )
        return
      }

      renderer.result({
        cli: app.command,
        version: app.version,
        contract: CONTRACT,
        description: root.description(),
        globalOptions: describeOptions(root),
        commands,
        exitCodes: { ok: 0, generic_failure: GENERIC_FAILURE, ...EXIT_CODES },
      })
    })
