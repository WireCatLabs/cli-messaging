import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { type AnyTool, nameOf, READ, tool } from "../tool.js"

export const accountTools = (messenger: Messenger): Record<string, AnyTool> => {
  const name = nameOf(messenger)
  return {
    account_show: tool({
      title: "Who this is",
      description: `The ${name} account this server is logged in as.`,
      input: v.object({}),
      annotations: { ...READ, idempotentHint: true },
      online: (adapter) => adapter.me(),
    }),
  }
}
