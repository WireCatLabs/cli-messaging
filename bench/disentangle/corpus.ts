import type { LinkInput } from "../../src/conversations/link.ts"

/** `[HH:MM] <nick> text`, `[HH:MM] * nick action`, and `=== …` joins and quits, which have no sender. */
export function parse(name: string, text: string): LinkInput[] {
  const day = Date.parse(`${name.slice(0, 10)}T00:00:00Z`)
  let minutes = 0
  let dayOffset = 0
  return text.split("\n").slice(0, -1).map((line, index) => {
    const time = /^\[(\d\d):(\d\d)\] /.exec(line)
    if (time) {
      const now = Number(time[1]) * 60 + Number(time[2])
      if (now < minutes) dayOffset += 1
      minutes = now
    }
    const sender = /^\[\d\d:\d\d\] (?:<([^>]+)>|\* (\S+))/.exec(line)
    const body = line.replace(/^\[\d\d:\d\d\] (?:<[^>]+>|\* \S+) ?/, "")
    return {
      id: String(index),
      senderId: sender ? (sender[1] ?? sender[2] ?? null) : null,
      text: body,
      timestamp: new Date(day + (dayOffset * 1440 + minutes) * 60_000).toISOString(),
    }
  })
}
