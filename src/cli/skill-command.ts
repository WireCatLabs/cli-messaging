import { readFileSync } from "node:fs"
import { Command } from "commander"
import type { AppIdentity } from "./app.js"
import { outputFor } from "./context.js"

/**
 * `skill show`, copied from max-cli. `skill` is the CLI's own SKILL.md, shipped beside `dist/` in
 * the package and in a checkout alike, so the skill printed is always this version's.
 */
export const skillCommand = (app: AppIdentity, skill: URL): Command => {
  const command = new Command("skill").description("the instructions an agent is given for this tool")

  command
    .command("show")
    .description(
      `print SKILL.md — redirect it into ~/.claude/skills/${app.appName}/SKILL.md for Claude Code, ` +
        `or ~/.agents/skills/${app.appName}/SKILL.md for Codex and Gemini CLI`,
    )
    .action(function (this: Command) {
      const { renderer, streams } = outputFor(this)
      const content = readFileSync(skill, "utf8").trimEnd()
      // The file itself even into a pipe: installing it *is* a redirect, and a redirect is where
      // every other command switches to JSON. Asked for by name, it is JSON like the rest.
      const { json, jsonl } = this.optsWithGlobals<{ json?: boolean; jsonl?: boolean }>()
      if (json || jsonl) renderer.result({ name: app.appName, content })
      else streams.data(content)
    })

  return command
}
