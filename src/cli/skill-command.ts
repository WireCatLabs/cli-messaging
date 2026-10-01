import { skillCommand as sharedSkillCommand } from "@leemour/cli-core/skill"
import type { Command } from "commander"
import type { AppIdentity } from "./app.js"
import { environmentOf, outputFor } from "./context.js"

/**
 * `skill show` and `skill install`. `skill` is the CLI's own SKILL.md, shipped beside `dist/` in the
 * package and in a checkout alike, so the skill printed is always this version's.
 */
export const skillCommand = (app: AppIdentity, skill: URL): Command =>
  sharedSkillCommand(app, skill, (command) => {
    const { env } = environmentOf(command)
    return { ...outputFor(command), ...(env ? { env } : {}) }
  })
