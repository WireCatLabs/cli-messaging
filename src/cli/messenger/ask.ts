import { closeSync, openSync, readSync, writeSync } from "node:fs"
import { CliError } from "@leemour/cli-core"
import type { Command } from "commander"
import type { Asker } from "../../sends/guard.js"
import { environmentOf } from "../context.js"

/** Deleting has its own word for "yes": the flag a person has to mean, not a habit (max-cli `NEED-238`). */
export const skipFlagFor = (key: string): "--allow-dangerous" | "--yes" =>
  key === "messages.delete" ? "--allow-dangerous" : "--yes"

/**
 * Asks at the terminal, synchronously, because the guard's check is synchronous and runs inside the
 * write. Reads `/dev/tty` rather than stdin: stdin may be the text being sent.
 */
const fromTerminal = (question: string): string | null => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null
  let fd: number
  try {
    fd = openSync("/dev/tty", "r+")
  } catch {
    return null
  }
  try {
    writeSync(fd, question)
    const bytes: number[] = []
    const one = Buffer.alloc(1)
    while (readSync(fd, one, 0, 1, null) === 1 && one[0] !== 0x0a) bytes.push(one[0] as number)
    return Buffer.from(bytes).toString("utf8")
  } finally {
    closeSync(fd)
  }
}

const what = (key: string, { chatId, count, personIds, forEveryone }: Parameters<Asker>[1]) =>
  [
    key,
    forEveryone ? "for everyone" : undefined,
    count !== undefined ? `${count} ${count === 1 ? "item" : "items"}` : undefined,
    personIds?.length ? `${personIds.length} ${personIds.length === 1 ? "person" : "people"}` : undefined,
    chatId !== null ? `in chat ${chatId}` : undefined,
  ]
    .filter(Boolean)
    .join(", ")

/** For a command a person typed: the flag says yes, or the terminal asks, or nobody can — and it is refused. */
export const terminalAsker =
  (command: Command): Asker =>
  (key, request) => {
    const flag = skipFlagFor(key)
    const given = command.optsWithGlobals<{ yes?: boolean; allowDangerous?: boolean }>()
    if (flag === "--yes" ? given.yes === true : given.allowDangerous === true) return
    const answer = (environmentOf(command).answer ?? fromTerminal)(`${what(key, request)} — go ahead? [y/N] `)
    if (answer === null) {
      throw new CliError(
        "confirmation_required",
        `${key} asks before it acts (its permission level is ask), and nobody is at a terminal to answer — ` +
          `add ${flag} to go ahead`,
      )
    }
    if (!/^\s*y(es)?\s*$/i.test(answer)) throw new CliError("cancelled", `${key}: not done — the answer was no`)
  }
