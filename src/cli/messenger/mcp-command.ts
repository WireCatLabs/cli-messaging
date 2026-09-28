import { realpathSync } from "node:fs"
import { CliError } from "@leemour/cli-core"
import { installerOf } from "@leemour/cli-core/update"
import { Command } from "commander"
import { type AppIdentity, envName } from "../app.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { type Messenger, messengerContext } from "./context.js"

/** Where the running CLI really lives; a test hands in its own. */
export interface McpEnvironment extends BaseEnvironment {
  mcp?: { scriptPath?: string; execPath?: string }
}

export interface McpFlags {
  allowSend?: boolean
  confirmSend?: boolean
}

const withFlags = (command: Command): Command =>
  command
    .option("--allow-send", "offer the send tool; without it the server can only read")
    .option("--confirm-send", "show the owner every send in a form from the server first")

const checked = (flags: McpFlags): McpFlags => {
  if (flags.confirmSend && !flags.allowSend) {
    throw new CliError("validation_error", "`--confirm-send` confirms sends, and without `--allow-send` there are none")
  }
  return flags
}

export const mcpCommand = (messenger: Messenger): Command => {
  const { app } = messenger
  const command = withFlags(
    new Command("mcp").description(
      `serve this profile to an agent over MCP, on stdin and stdout — \`claude mcp add ${app.command} -- ${app.command} mcp\``,
    ),
  ).action(async function (this: Command) {
    const { allowSend, confirmSend } = checked(this.opts<McpFlags>())
    // Loaded here, not at the top: every other command would otherwise pay for the SDK.
    const { serveOverStdio } = await import("../../mcp/server.js")
    await serveOverStdio(this, messengerContext(this, messenger), messenger, {
      allowSend: allowSend === true,
      confirmSend: confirmSend === true,
    })
  })

  command.addCommand(
    withFlags(
      new Command("config").description(
        "print the mcpServers entry for Claude Desktop, Cursor and others, with full paths; writes nothing",
      ),
    ).action(async function (this: Command) {
      const flags = checked(this.optsWithGlobals<McpFlags>())
      const { renderer, settings, format, streams, env } = messengerContext(this, messenger)
      const given = environmentOf<McpEnvironment>(this).mcp ?? {}
      const entry = serverEntry(app, {
        profile: settings.profile,
        flags,
        execPath: given.execPath ?? process.execPath,
        scriptPath: given.scriptPath ?? realpathSync(process.argv[1] ?? ""),
        env,
      })
      // Pasted into a file, so a person gets the same JSON a script does, only indented.
      if (format === "pretty") streams.data(JSON.stringify(entry.config, null, 2))
      else renderer.result(entry.config)
      if (entry.warning) renderer.note(entry.warning)
    }),
  )
  return command
}

const VERSION_MANAGER = /[\\/](\.nvm|nvm|\.fnm|fnm|fnm_multishells|\.volta|volta|\.asdf|mise)[\\/]/i

/**
 * `node` and the script by full path, on every platform: a client started from the desktop does
 * not see the PATH a terminal has, and on Windows the command is a `.cmd` file that a client which
 * starts programs without a shell cannot run. The directories are copied when set — they choose the
 * keyring entry and the store, so a server without them would answer "no session" or search another
 * store. So is `XDG_RUNTIME_DIR`: the keyring is reached through it, and an MCP client that starts
 * servers with a trimmed environment leaves it out (measured 2026-09-28). Credentials are never copied.
 */
export const serverEntry = (
  app: AppIdentity,
  {
    profile,
    flags = {},
    execPath,
    scriptPath,
    env,
  }: { profile: string; flags?: McpFlags; execPath: string; scriptPath: string; env: NodeJS.ProcessEnv },
): { config: { mcpServers: Record<string, object> }; warning?: string } => {
  if (installerOf(scriptPath) === "npx") {
    throw new CliError(
      "validation_error",
      `this ${app.command} runs from npx's cache, which gets cleared, and the path would stop working — ` +
        `install it globally, then run \`${app.command} mcp config\` again`,
    )
  }
  const names = [
    ...["CONFIG_DIR", "STATE_DIR", "CACHE_DIR"].map((name) => envName(app, name)),
    "MESSAGING_STORE",
    "XDG_RUNTIME_DIR",
  ]
  const directories = Object.fromEntries(names.flatMap((name) => (env[name] ? [[name, env[name]]] : [])))
  const server = {
    type: "stdio",
    command: execPath,
    args: [
      scriptPath,
      ...(profile === "default" ? [] : [profile]),
      "mcp",
      ...(flags.allowSend ? ["--allow-send"] : []),
      ...(flags.confirmSend ? ["--confirm-send"] : []),
    ],
    ...(Object.keys(directories).length > 0 ? { env: directories } : {}),
  }
  return {
    config: { mcpServers: { [profile === "default" ? app.command : `${app.command}-${profile}`]: server } },
    ...(VERSION_MANAGER.test(execPath)
      ? { warning: `${execPath} belongs to one Node version — after switching or upgrading Node, run this again` }
      : {}),
  }
}
