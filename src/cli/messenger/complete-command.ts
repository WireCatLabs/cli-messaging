import { existsSync } from "node:fs"
import { script } from "@bomb.sh/tab"
import { CliError, singleLine } from "@leemour/cli-core"
import { describeOptions, describeProgram } from "@leemour/cli-core/commands"
import { type CompletionSources, formatSuggestions, type Suggestion, suggest } from "@leemour/cli-core/completion"
import { Command } from "commander"
import { storePath } from "../../store/path.js"
import { type AccountKey, type MessageStore, openStore } from "../../store/store.js"
import { envName } from "../app.js"
import { environmentOf, outputFor } from "../context.js"
import { commandWords, DEFAULT_PROFILE, liftProfile, rootOf, usableProfileName } from "../profile.js"
import type { Configuration } from "../settings.js"
import { recalledAccount } from "./accounts.js"
import type { Messenger } from "./context.js"

const SHELLS = ["zsh", "bash", "fish", "powershell"]

/**
 * `tg complete zsh` prints the script a shell sources; the script then runs `tg complete -- <words>`
 * on every Tab, and this answers from the command registry.
 *
 * ⚠ **A Tab never connects and never creates anything.** Names come from the message store if it
 * exists — no store, no names — and nothing goes to stderr: a shell shows whatever it is given.
 */
export const completeCommand = (messenger: Messenger, config: Configuration): Command =>
  new Command("complete")
    .description(`shell completion: \`${messenger.app.command} complete zsh\` prints the script to source`)
    .argument("[words...]")
    .allowUnknownOption()
    .helpOption(false)
    .action(async function (this: Command, words: string[]) {
      const { app } = messenger
      const root = rootOf(this)
      const { streams } = outputFor(this)
      const env = environmentOf(this).env ?? process.env

      // Commander drops the `--` from the operands, so only the raw words tell a request from a shell name.
      const raw = (root as Command & { rawArgs: string[] }).rawArgs
      if (!raw.includes("--")) {
        const [shell] = words
        if (!shell || !SHELLS.includes(shell)) {
          throw new CliError("validation_error", `name a shell: ${app.command} complete ${SHELLS.join(" | ")}`)
        }
        // tab writes the script through console.log; stdout is where a `source <(…)` reads it.
        script(shell as "zsh", app.command, app.command)
        return
      }

      // The last word is still being typed, so it is never taken for a profile: `mess` is on its way to `messages`.
      const { profile, rest } =
        words.length > 1 ? liftProfile(words, commandWords(root)) : { profile: undefined, rest: words }
      const lock = env[envName(app, "PROFILE_LOCK")]
      const wanted = profile ?? lock ?? env[envName(app, "PROFILE")] ?? DEFAULT_PROFILE
      const account = readable(wanted, lock) ? recalledAccount(app, messenger.provider, wanted, env) : undefined
      const store = account && existsSync(storePath(env)) ? await openStore({ env }).catch(() => undefined) : undefined
      try {
        const suggestions = suggest({
          commands: describeProgram(root),
          globalOptions: describeOptions(root),
          words: rest.length > 0 ? rest : [""],
          sources: sourcesFrom(store, account, profile === undefined, () => profileNames(config, env)),
        })
        streams.data(formatSuggestions(suggestions))
      } finally {
        store?.close()
      }
    })

/** A half-typed or odd first word, or another profile than a locked one, gets no names rather than an error. */
const readable = (profile: string, lock: string | undefined): boolean => {
  if (lock && profile !== lock) return false
  try {
    usableProfileName(profile)
    return true
  } catch {
    return false
  }
}

const sourcesFrom = (
  store: MessageStore | undefined,
  account: AccountKey | undefined,
  atTheStart: boolean,
  profiles: () => string[],
): CompletionSources => {
  const chats = () => (store && account ? chatSuggestions(store, account) : [])
  const people = () => (store && account ? chatSuggestions(store, account, "dialog") : [])
  return {
    arguments: { chat: chats, person: people },
    options: { chat: chats },
    ...(atTheStart ? { firstWord: profiles } : {}),
  }
}

/**
 * **Ids only, never a title as the word.** bash's `compgen -W` expands `$(…)` in every word it is
 * given, and a title is whatever somebody else typed — so the id is the word, and the title rides
 * along as a description, on one line: bash splits the answer on newlines.
 */
const chatSuggestions = (store: MessageStore, account: AccountKey, kind?: string): Suggestion[] =>
  store
    .chats(account, { limit: 500 })
    .items.filter((chat) => kind === undefined || chat.kind === kind)
    .map((chat) => ({ value: chat.id, description: singleLine(chat.title ?? "") }))

const profileNames = (config: Configuration, env: NodeJS.ProcessEnv): string[] => {
  try {
    return config.configuredProfiles({ env })
  } catch {
    return []
  }
}
