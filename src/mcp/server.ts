import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { toStandardJsonSchema } from "@valibot/to-json-schema"
import type { Command } from "commander"
import * as v from "valibot"
import { recalledAccount } from "../cli/messenger/accounts.js"
import { connected, type Messenger, type MessengerContext } from "../cli/messenger/context.js"
import { confirmer } from "./confirm.js"
import { instructions } from "./instructions.js"
import { registerPrompts } from "./prompts.js"
import { registerResources } from "./resources.js"
import { MessengerSession, type SessionOptions } from "./session.js"
import { answered, failed, READ, readTools, registerTools, sendTools } from "./tools.js"

export interface ServerOptions extends SessionOptions {
  allowSend: boolean
  confirmSend?: boolean
}

/**
 * A factory of servers over one session. `serveStdio` may build a probe instance and throw it away
 * before settling on the protocol era, so each call is a fresh server — and all of them share the
 * one connection, which is the thing that must not be opened twice.
 */
export const createServer = (
  command: Command,
  context: MessengerContext,
  messenger: Messenger,
  { allowSend, confirmSend = false, ...sessionOptions }: ServerOptions,
) => {
  const { app, provider } = messenger
  const name = messenger.name ?? app.command
  const { settings } = context
  const permitted = settings.allow
  // `allow` hides what the guard would refuse anyway, so an agent is not offered a tool that cannot work.
  const writes = Object.fromEntries(
    Object.entries(allowSend ? sendTools(messenger) : {}).filter(
      ([, one]) => !permitted || (one.permission !== undefined && permitted.includes(one.permission)),
    ),
  )
  const confirmed = confirmSend ? confirmer() : undefined
  const session = new MessengerSession(
    async (events) => connected(await messenger.connect(command, context, {}), messenger, context, events),
    (run, body) => context.run(body, { name: run }),
    sessionOptions,
  )

  const build = (): McpServer => {
    const server = new McpServer(
      { name: app.command, version: app.version },
      {
        instructions: instructions({
          command: app.command,
          name,
          profile: settings.profile,
          allowSend,
          confirmSend,
          permitted,
        }),
      },
    )
    registerTools(
      server,
      { ...readTools(messenger), ...writes },
      {
        command: app.command,
        session,
        withStore: context.withStore,
        defaults: { limit: settings.limit, guard: context.guard },
        confirmed,
      },
    )
    registerPrompts(server, { command: app.command, name })
    registerResources(server, session, {
      command: app.command,
      name,
      limit: settings.limit,
      recorded: () => recalledAccount(app, provider, settings.profile, context.env) !== undefined,
      withStore: context.withStore,
    })
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
            allow: permitted ?? "all",
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
  command: Command,
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
