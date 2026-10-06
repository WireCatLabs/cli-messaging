import type { Client } from "@modelcontextprotocol/client"
import { commandOf } from "../mcp/surface.js"

type Call = Parameters<Client["callTool"]>[0]
type Listed = { name: string; title?: string; inputSchema: unknown; annotations: { readOnlyHint: boolean } }

const SURFACE = ["tools_search", "read", "write"]

/**
 * A client that still speaks one tool per command — `chat_messages_list` — over the three the server
 * lists, so a test written against a command's own tool now drives `chat_read` / `chat_write`.
 */
export const commandsClient = <C extends Pick<Client, "callTool" | "listTools">>(client: C, app: string): C => {
  const text = async (call: Call) => {
    const result = await client.callTool(call)
    const [first] = result.content as { type: string; text: string }[]
    return JSON.parse(first?.text ?? "null")
  }
  const describe = async (command: string): Promise<Listed | undefined> => {
    const { items } = await text({ name: `${app}_tools_search`, arguments: { query: command } })
    const found = (items as { command: string; title: string; writes: boolean; arguments: unknown }[]).find(
      (item) => item.command === command,
    )
    return found
      ? {
          name: `${app}_${command.replaceAll(/[ -]/g, "_")}`,
          title: found.title,
          inputSchema: found.arguments,
          annotations: { readOnlyHint: !found.writes },
        }
      : undefined
  }
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "listTools")
        return async () => {
          const { items } = await text({ name: `${app}_tools_search`, arguments: {} })
          const tools = await Promise.all((items as { command: string }[]).map(({ command }) => describe(command)))
          return { tools: tools.filter(Boolean) }
        }
      if (property === "callTool")
        return async (call: Call, ...rest: unknown[]) => {
          const key = call.name.slice(app.length + 1)
          if (!call.name.startsWith(`${app}_`) || SURFACE.includes(key))
            return (target.callTool as (...args: unknown[]) => unknown)(call, ...rest)
          const command = commandOf(key)
          const found = await describe(command)
          return (target.callTool as (...args: unknown[]) => unknown)(
            {
              ...call,
              name: `${app}_${found?.annotations.readOnlyHint === false ? "write" : "read"}`,
              arguments: { command, arguments: call.arguments ?? {} },
            },
            ...rest,
          )
        }
      return Reflect.get(target, property, receiver)
    },
  })
}
