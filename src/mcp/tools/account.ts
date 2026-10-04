import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../cli/messenger/port.js"
import { maskedAccount } from "../../services/people.js"
import { type AnyTool, nameOf, READ, tool } from "../tool.js"

export const accountTools = (messenger: Messenger): Record<string, AnyTool> => {
  const name = nameOf(messenger)
  return {
    account_show: tool({
      title: "Who this is",
      description: `The ${name} account this server is logged in as.`,
      input: v.object({}),
      annotations: { ...READ, idempotentHint: true },
      // An agent has no reason to hold the owner's number (max-cli NEED-209).
      online: async (adapter) => maskedAccount(await adapter.me()),
    }),

    account_sessions: tool({
      title: "Where the owner is logged in",
      description:
        `Every device and app logged in to the owner's ${name} account: { items: [{ current, client, device, ` +
        "location, lastActiveAt, createdAt? }] }. Reads only; nothing is ended.",
      input: v.object({}),
      annotations: READ,
      key: "account.sessions.list",
      online: async (adapter) => ({ items: await capability(adapter, "sessions", "list the account's sessions")() }),
    }),
  }
}
