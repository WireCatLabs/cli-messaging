import type { Id } from "../domain/models.js"
import {
  act,
  type CheckRow,
  type Finding,
  type Gathered,
  judge,
  type Moderator,
  nextPoint,
  someUndone,
} from "./check.js"
import { defaultRules, type ModerationRules } from "./rules.js"

/** A group never checked before is looked at this far back. */
export const FIRST_LOOK_MS = 24 * 3_600_000

/** Where a group's last check stopped; the personal account keeps it in the rules file, a bot beside its state. */
export interface SavedPoint {
  read(chatId: Id): string | undefined
  write(chatId: Id, at: string): void
}

export interface ModerateRun {
  chatId: Id
  title: string | null
  rules: ModerationRules
  point: SavedPoint
  /** Everything new since this time, ms. */
  gather: (since: number) => Promise<Gathered>
  moderator: Moderator
  /** The messenger's invite-link pattern, for the `invites` rule. */
  invites?: RegExp
  /** The program's word, for the command a row says to type by hand. */
  command: string
  /** In place of the personal commands a row names: a bot's own. */
  commandFor?: (chatId: Id, finding: Finding) => string
  /** ms; the saved point is neither read nor moved. */
  since?: number
  dryRun: boolean
  allowDangerous: boolean
  maxActions: number
  confirm?: (finding: Finding) => Promise<boolean | undefined>
}

/** Judges what is new in one group by its rules, acts as they allow, and moves the saved point. */
export const moderateWith = async (run: ModerateRun): Promise<{ chatId: Id; rows: CheckRow[]; notes: string[] }> => {
  const { chatId, title, rules, point, since, dryRun } = run
  const saved = rules.read(chatId)
  const groupRules = saved ?? defaultRules(title)
  const last = point.read(chatId)
  const from = since ?? (last === undefined ? Date.now() - FIRST_LOOK_MS : Date.parse(last))
  const found = await run.gather(from)
  const findings = judge({
    ...found,
    rules: groupRules,
    now: Date.now(),
    ...(run.invites ? { invites: run.invites } : {}),
  })
  const rows = await act(run.moderator, findings, {
    chatId,
    rules: groupRules,
    allowDangerous: run.allowDangerous,
    dryRun,
    maxActions: run.maxActions,
    command: run.command,
    ...(run.commandFor ? { commandFor: run.commandFor } : {}),
    ...(run.confirm ? { confirm: run.confirm } : {}),
  })

  const notes = [...(saved ? [] : [`${title ?? chatId} has no rules yet — the defaults only report`]), ...found.notes]
  const next = nextPoint(rows, found)
  if (since === undefined && !dryRun && next !== null) point.write(chatId, next)
  if (next !== found.until && someUndone(rows)) {
    notes.push("some actions are not done — the next check starts at the first of them")
  } else if (found.more) {
    notes.push("more history than one check reads — the next check goes on from here")
  }
  return { chatId, rows, notes }
}
