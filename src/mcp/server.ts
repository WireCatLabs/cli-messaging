import { skillResource } from "@leemour/cli-core/skill"
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { toStandardJsonSchema } from "@valibot/to-json-schema"
import * as v from "valibot"
import { recalledAccount } from "../cli/messenger/accounts.js"
import { skipFlagFor } from "../cli/messenger/ask.js"
import { connected, type Messenger, type MessengerContext } from "../cli/messenger/context.js"
import { guardFor } from "../sends/guard.js"
import { levelFor } from "../sends/permissions.js"
import { confirmer } from "./confirm.js"
import { instructions } from "./instructions.js"
import { registerPrompts } from "./prompts.js"
import { registerResources } from "./resources.js"
import { MessengerSession, type SessionOptions } from "./session.js"
import { type AnyTool, answered, failed, READ, registerTools, toolKey } from "./tool.js"
import { deleteTools, markReadTools, readTools, sendTools } from "./tools.js"

export interface ServerOptions extends SessionOptions {
  /** Every write through the form, whatever its level. */
  confirmSend?: boolean
  /** No form for a write at level `ask` — the owner's yes, given when the server was started. */
  yes?: boolean
  /** The same for a deletion. */
  allowDangerous?: boolean
}

type Invocation = Parameters<Messenger["connect"]>[0]

/**
 * A factory of servers over one session. `serveStdio` may build a probe instance and throw it away
 * before settling on the protocol era, so each call is a fresh server — and all of them share the
 * one connection, which is the thing that must not be opened twice.
 */
export const createServer = (
  command: Invocation,
  context: MessengerContext,
  messenger: Messenger,
  { confirmSend = false, yes = false, allowDangerous = false, ...sessionOptions }: ServerOptions,
) => {
  const { app, provider } = messenger
  const name = messenger.name ?? app.command
  const { settings } = context
  const levelOf = (key: string | null | undefined) => (key ? levelFor(settings.permissions, key).level : "allow")
  // A tool the level would refuse is not offered: an agent is not handed a tool that cannot work.
  const offered = Object.fromEntries(
    Object.entries({
      ...readTools(messenger),
      ...sendTools(messenger),
      ...markReadTools(messenger),
      ...deleteTools(messenger),
    }).filter(([key, one]) => {
      const level = levelOf(toolKey(key, one))
      return level !== "deny" && (one.permission === undefined || level !== "readonly")
    }),
  )
  const writes = Object.fromEntries(Object.entries(offered).filter(([, one]) => one.permission !== undefined))
  const confirms = (key: string, one: AnyTool) => {
    if (confirmSend) return true
    const toolPath = toolKey(key, one)
    if (levelOf(toolPath) !== "ask") return false
    return !(skipFlagFor(toolPath ?? "") === "--allow-dangerous" ? allowDangerous : yes)
  }
  const confirmed = confirmer()
  // The form is the question here; the guard behind it has nothing left to ask.
  const guard = messenger.guard
    ? context.guard
    : guardFor(app, settings, context.renderer.warn, context.env, async () => {})
  const session = new MessengerSession(
    async (events) => connected(await messenger.connect(command, context, { events }), messenger, context, events),
    (run, body) => context.run(body, { name: run }),
    sessionOptions,
  )

  const skill = messenger.skill ? skillResource(app, messenger.skill) : undefined

  const build = (): McpServer => {
    const server = new McpServer(
      { name: app.command, version: app.version },
      {
        instructions: instructions({
          command: app.command,
          name,
          profile: settings.profile,
          writes: Object.keys(writes),
          confirmSend,
          ...(skill ? { skill: skill.instruction } : {}),
        }),
      },
    )
    registerTools(server, offered, {
      command: app.command,
      session,
      withStore: context.withStore,
      defaults: { limit: settings.limit, guard, settings, env: context.env },
      confirmed,
      confirms,
    })
    // The prompts and resources show messages, so a profile that may not read them gets neither.
    if (levelOf("messages") !== "deny") registerPrompts(server, { command: app.command, name })
    if (levelOf("messages") !== "deny")
      registerResources(server, session, {
        command: app.command,
        name,
        limit: settings.limit,
        recorded: () => recalledAccount(app, provider, settings.profile, context.env) !== undefined,
        withStore: context.withStore,
        messenger,
        guard,
      })
    if (skill) {
      const { uri, name: resource, title, description, mimeType, read } = skill
      server.registerResource(resource, uri, { title, description, mimeType }, read)
    }
    server.registerTool(
      `${app.command}_status`,
      {
        title: "This server's profile and login",
        description:
          "Which profile this server speaks for, which account it last logged in as here, and which writing tools " +
          "are on. Never connects, so it answers when the login is what is broken.",
        inputSchema: toStandardJsonSchema(v.object({})),
        annotations: { ...READ, idempotentHint: true },
      },
      async () => {
        try {
          return answered({
            profile: settings.profile,
            account: recalledAccount(app, provider, settings.profile, context.env)?.account ?? null,
            writes: Object.keys(writes).map((key) => `${app.command}_${key}`),
            confirmSend,
            permissions: settings.permissions,
            ...(messenger.diagnose ? { [messenger.provider]: await messenger.diagnose(command, context) } : {}),
          })
        } catch (error) {
          return failed(error)
        }
      },
    )
    return server
  }
  return { session, build }
}

/**
 * Serves until the client closes stdin or the process is told to stop, then closes the connection.
 * **Returning is what lets the process exit**: the transport lets go of stdin, and the session is
 * the only other thing that could hold it open.
 */
export const serveOverStdio = async (
  command: Invocation,
  context: MessengerContext,
  messenger: Messenger,
  options: ServerOptions,
): Promise<void> => {
  const { session, build } = createServer(command, context, messenger, options)
  const handle = serveStdio(build, { onerror: (error) => context.renderer.note(`mcp: ${error.message}`) })

  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve)
    process.stdin.once("close", resolve)
    process.once("SIGINT", resolve)
    process.once("SIGTERM", resolve)
  })

  await handle.close()
  await session.close()
}
