import { CliError } from "@leemour/cli-core"
import { capability, type ProfileChange } from "../cli/messenger/port.js"
import type { Account, AccountSession } from "../domain/models.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import type { ServiceDeps } from "./deps.js"
import { maskedAccount } from "./people.js"

/** The owner's own profile and logins. */
export interface AccountService {
  /** The account as it now stands, its phone masked as `account show` masks it. */
  update(change: ProfileChange): Promise<Operated<{ account: Account }>>
  /** Logs the owner out of every other device, the phone included. */
  endOtherSessions(): Promise<Operated<{ sessions: AccountSession[] }>>
}

export const accountService = (deps: ServiceDeps): AccountService => {
  const online = async (command: string) => {
    if (deps.offline) throw new CliError("validation_error", `\`${command}\` changes the account; not with --offline`)
    return deps.connection()
  }
  return {
    update: async (change) => {
      if (Object.values(change).every((value) => value === undefined)) {
        throw new CliError("validation_error", "nothing to change — give a name, a description or a photo")
      }
      if (change.firstName !== undefined && change.firstName.trim() === "") {
        throw new CliError("validation_error", "a first name cannot be empty")
      }
      const update = capability(await online("account update"), "updateProfile", "change the profile")
      const operationId = newOperationId()
      const account = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "profile" },
        () => update(change),
      )
      return { operationId, account: maskedAccount(account) }
    },

    endOtherSessions: async () => {
      const end = capability(await online("account sessions end"), "endOtherSessions", "end other sessions")
      const operationId = newOperationId()
      const sessions = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "sessions-end" },
        () => end(),
      )
      return { operationId, sessions }
    },
  }
}
