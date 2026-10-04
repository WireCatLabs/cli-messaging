import { Command } from "commander"
import { DRY_RUN_DAYS, dryRun } from "../../replies/dry-run.js"
import { readReplyRules, repliesPathFor } from "../../replies/rules.js"
import { momentOf } from "../../services/moment.js"
import { type Messenger, messengerContext } from "./context.js"

/** `replies`: rules that answer messages for the owner. Only `test` so far, and it sends nothing (`NEED-601`). */
export const repliesCommand = (messenger: Messenger): Command => {
  const replies = new Command("replies").description(
    "rules that answer messages for you, kept in a file of this profile",
  )

  replies
    .command("test")
    .description(
      "what the rules would have answered in the stored messages, to whom and why — sends nothing, " +
        "changes nothing, never connects",
    )
    .argument("[rule]", "only this rule, by its id; every rule in file order if not given")
    .option("--since-time <time>", `from this ISO 8601 time, or 2h / 1d ago; ${DRY_RUN_DAYS}d ago if not given`)
    .action(async function (this: Command, rule: string | undefined) {
      const { sinceTime } = this.opts<{ sinceTime?: string }>()
      const context = messengerContext(this, messenger)
      const { settings, renderer, format, streams, env } = context
      const since = momentOf(sinceTime ?? `${DRY_RUN_DAYS}d`, "--since-time")
      const path = repliesPathFor(messenger.app, settings.profile, env)
      const rules = readReplyRules(path)
      if (rules.length === 0) {
        renderer.note(`no reply rules yet — they live in ${path}`)
      }
      const found = await context.withStore(
        (store, account) => dryRun(store, account, rules, { since, ...(rule === undefined ? {} : { only: rule }) }),
        { name: "replies test" },
      )
      if (found.botUnknown > 0) {
        renderer.note(`${found.botUnknown} sender(s) not known as bot or person; taken as people`)
      }
      renderer.note(`only what this machine has stored from ${found.since} to ${found.until} was read`)
      if (format !== "pretty") {
        renderer.result(found)
        return
      }
      const lines = found.rules.flatMap(({ id, would, skipped }) => [
        `${id}: would answer ${would.length}`,
        ...would.map(
          (one) =>
            `  ${one.at}  ${one.chatTitle ?? one.chatId} → ${one.to.name ?? one.to.id}: ${JSON.stringify(one.text)}`,
        ),
        ...Object.entries(skipped)
          .sort(([, a], [, b]) => b - a)
          .map(([why, count]) => `  passed over ${count}: ${why}`),
      ])
      streams.data(`${lines.join("\n")}\n`)
    })

  return replies
}
