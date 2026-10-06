import { CliError } from "@leemour/cli-core"
import type { McpServer, ServerContext } from "@modelcontextprotocol/server"
import { toJsonSchema, toStandardJsonSchema } from "@valibot/to-json-schema"
import * as v from "valibot"
import {
  type AnyTool,
  answered,
  entryRunner,
  failed,
  inputOf,
  READ,
  type Registration,
  syncAllowedFor,
  UNTRUSTED,
  WRITE,
} from "./tool.js"

const MATCHES = 8

/** `chats_mark_read` is `chats mark-read`: the one verb with a hyphen. */
export const commandOf = (key: string): string => key.replaceAll("_", " ").replace("mark read", "mark-read")

const keyOf = (command: string): string =>
  command
    .trim()
    .toLowerCase()
    .split(/[\s_-]+/)
    .join("_")

const writes = (definition: AnyTool): boolean => definition.annotations.readOnlyHint !== true

const haystack = (command: string, definition: AnyTool): string =>
  [command, definition.title, definition.description, ...Object.keys(definition.input.entries)].join(" ").toLowerCase()

/** Every query word must appear; a word in the command itself ranks first. No word lists everything. */
export const search = (
  tools: Record<string, AnyTool>,
  query: string,
): { key: string; command: string; definition: AnyTool }[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return Object.entries(tools)
    .map(([key, definition]) => ({ key, command: commandOf(key), definition }))
    .filter(({ command, definition }) => words.every((word) => haystack(command, definition).includes(word)))
    .map((entry) => ({ entry, rank: words.filter((word) => entry.command.includes(word)).length }))
    .sort((a, b) => b.rank - a.rank || a.entry.command.localeCompare(b.entry.command))
    .map(({ entry }) => entry)
}

const nearest = (tools: Record<string, AnyTool>, key: string): string[] => {
  const words = key.split("_")
  return Object.keys(tools)
    .map((one) => ({ one, shared: words.filter((word) => one.split("_").includes(word)).length }))
    .filter(({ shared }) => shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 3)
    .map(({ one }) => commandOf(one))
}

/**
 * **Three tools in place of one per command** (CLI-74, NEED-766): search the commands, then run one
 * with `read` or `write`. A command keeps its CLI path and the arguments its own tool took, and runs
 * through the same runner, so its answer does not change. The list never changes during a
 * connection; what a profile may not use is neither found nor run.
 */
export const registerSurface = (server: McpServer, tools: Record<string, AnyTool>, registration: Registration) => {
  const { command: app, defaults } = registration
  const run = entryRunner(registration)
  const described = (key: string, definition: AnyTool) => ({
    command: commandOf(key),
    title: definition.title,
    description: definition.description,
    writes: writes(definition),
    arguments: toJsonSchema(inputOf(definition, syncAllowedFor(key, defaults))),
  })

  server.registerTool(
    `${app}_tools_search`,
    {
      title: "Find a command",
      description:
        `Find the ${app} command for a task — "unread", "send message", "chat members" — before calling ` +
        `${app}_read or ${app}_write with it. Each match gives its command, whether it writes, and its arguments. ` +
        "With no words, lists every command and title, without arguments.",
      inputSchema: toStandardJsonSchema(
        v.strictObject({ query: v.optional(v.pipe(v.string(), v.description("words that describe the task"))) }),
      ),
      annotations: { ...READ, openWorldHint: false, idempotentHint: true },
    },
    async ({ query }: { query?: string }) => {
      const found = search(tools, query ?? "")
      return answered(
        query?.trim()
          ? {
              items: found.slice(0, MATCHES).map(({ key, definition }) => described(key, definition)),
              more: found.length > MATCHES,
            }
          : {
              items: found.map(({ command, definition }) => ({
                command,
                title: definition.title,
                writes: writes(definition),
              })),
            },
      )
    },
  )

  const runner =
    (writing: boolean) =>
    async (
      { command, arguments: given }: { command: string; arguments?: Record<string, unknown> },
      ctx: ServerContext,
    ) => {
      try {
        const key = keyOf(command)
        const definition = tools[key]
        if (!definition) {
          const near = nearest(tools, key)
          throw new CliError(
            "validation_error",
            `no command "${command}" here${near.length ? ` — did you mean ${near.map((one) => `"${one}"`).join(", ")}?` : ""}; ${app}_tools_search finds one`,
          )
        }
        if (writes(definition) !== writing)
          throw new CliError(
            "validation_error",
            `"${commandOf(key)}" ${writing ? "only reads" : "writes"}: call it with ${app}_${writing ? "read" : "write"}`,
          )
        const input = inputOf(definition, syncAllowedFor(key, defaults))
        const parsed = v.safeParse(input, given ?? {})
        if (!parsed.success)
          throw new CliError("validation_error", `${commandOf(key)}: ${v.summarize(parsed.issues)}`, {
            arguments: toJsonSchema(input),
          })
        return await run(key, definition, parsed.output, ctx)
      } catch (error) {
        return failed(error)
      }
    }

  const call = v.strictObject({
    command: v.pipe(
      v.string(),
      v.minLength(1),
      v.description(`a command ${app}_tools_search returned: "messages list"`),
    ),
    arguments: v.optional(v.pipe(v.record(v.string(), v.unknown()), v.description("that command's arguments"))),
  })
  server.registerTool(
    `${app}_read`,
    {
      title: "Run a reading command",
      description: `Run one ${app} command that only reads, with the arguments ${app}_tools_search showed. ${UNTRUSTED}`,
      inputSchema: toStandardJsonSchema(call),
      annotations: READ,
    },
    runner(false),
  )
  if (Object.values(tools).some(writes))
    server.registerTool(
      `${app}_write`,
      {
        title: "Run a writing command",
        description: `Run one ${app} command that changes something — sends, edits, deletes, joins — with the arguments ${app}_tools_search showed.`,
        inputSchema: toStandardJsonSchema(call),
        annotations: WRITE,
      },
      runner(true),
    )
}
