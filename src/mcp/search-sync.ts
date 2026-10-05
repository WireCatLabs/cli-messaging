import * as v from "valibot"
import type { Messenger } from "../cli/messenger/context.js"
import { servicesFor, storedDeps } from "../services/index.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import type { Connect, Defaults } from "./tool.js"

export const syncInputs = {
  sync_first: v.optional(v.pipe(v.boolean(), v.description("first fetch new messages within the bounds"))),
  max_chats: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  sync_time: v.optional(v.pipe(v.string(), v.description("fetch time budget, default 30s"))),
  max_messages: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000))),
}

export const searchServices = (
  messenger: Messenger,
  store: MessageStore,
  account: AccountKey,
  defaults: Defaults,
  connect?: Connect,
) =>
  servicesFor({
    ...storedDeps(messenger, store, account, defaults.guard),
    offline: false,
    history: defaults.history,
    profile: defaults.settings.profile,
    env: defaults.env,
    embedders: defaults.embedders,
    ...(connect ? { withConnection: connect } : {}),
  })
