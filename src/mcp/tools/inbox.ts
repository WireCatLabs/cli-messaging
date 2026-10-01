import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { modelWith } from "../../cli/messenger/hearing-command.js"
import { momentOf } from "../../cli/messenger/inbox.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { heard, hearForTool } from "../../speech/hearing.js"
import { type AnyTool, READ, tool } from "../tool.js"

/** Per chat: unread across many chats at a hundred each would outgrow what a client keeps of one answer. */
const INBOX_LIMIT = 20

export const inboxTools = (messenger: Messenger): Record<string, AnyTool> => {
  return {
    inbox: tool({
      title: "What is new",
      description:
        "Other people's messages waiting for the owner, grouped by chat, in one call: the unread ones, or with " +
        `\`since\` everything after that point. Marks nothing read and moves no saved point — the owner's ` +
        `\`${messenger.app.command} inbox --new\` is unaffected. Muted and archived chats are left out unless they ` +
        "mention the owner or reply to them, or `all` is set. Returns { mode, chats: [{ id, title, messages, more }], " +
        "skipped, partial, quiet }, where quiet counts the chats left out. A voice message carries `transcript` once " +
        "heard; `transcribe` hears the rest.",
      input: v.object({
        since: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        all: v.optional(v.pipe(v.boolean(), v.description("muted and archived chats too"))),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100), v.description("at most this many per chat")),
        ),
        transcribe: v.optional(
          v.pipe(v.boolean(), v.description("turn voice messages not heard yet into text; can take minutes")),
        ),
        model: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description("which downloaded speech model hears them, with transcribe"),
          ),
        ),
      }),
      annotations: READ,
      online: async (adapter, args, defaults) => {
        const limit = args.limit ?? INBOX_LIMIT
        const inbox = await servicesFor(onlineDeps(messenger, adapter, defaults.guard)).inbox.read({
          ...(args.since === undefined ? {} : { since: momentOf(args.since, "since") }),
          limit,
          all: args.all === true,
        })
        const messages = inbox.chats.flatMap((chat) => chat.messages)
        const hearing = await hearForTool(
          messenger,
          adapter,
          messages,
          args.transcribe === true,
          defaults,
          modelWith(args.transcribe, args.model),
        )
        return {
          ...inbox,
          chats: inbox.chats.map((chat) => ({ ...chat, messages: heard(chat.messages, hearing) })),
          ...(args.transcribe ? { unheard: hearing?.unheard ?? [] } : {}),
        }
      },
    }),
  }
}
