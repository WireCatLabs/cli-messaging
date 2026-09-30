import { CliError } from "@leemour/cli-core"
import { newIn, unreadIn } from "../cli/messenger/inbox.js"
import { type ReviewOptions, reviewIn } from "../cli/messenger/review.js"
import type { Inbox, Review } from "../domain/models.js"
import type { ServiceDeps } from "./deps.js"

export interface InboxService {
  /** Other people's unread messages; with `since` (ms, parsed by the caller), what arrived after it instead. */
  read(options: { since?: number; limit: number; all?: boolean }): Promise<Inbox>
  /** Every message, both sides, in each chat that changed since a point. */
  review(options: ReviewOptions): Promise<Review>
}

export const inboxService = (deps: ServiceDeps): InboxService => ({
  read: async ({ since, limit, all = false }) => {
    if (deps.offline) {
      throw new CliError(
        "validation_error",
        "`inbox` asks the messenger what is new; with `--offline` there is nothing new",
      )
    }
    const connection = await deps.connection()
    return since === undefined ? unreadIn(connection, { limit, all }) : newIn(connection, { since, limit, all })
  },

  review: async (options) => {
    if (deps.offline) {
      throw new CliError("validation_error", "`review` asks the messenger what changed; with `--offline` nothing did")
    }
    return reviewIn(await deps.connection(), options)
  },
})
