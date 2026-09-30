// Scores the conversation rules on the hand-labelled IRC corpus (Kummerfeld et al., ACL 2019).
// DISENTANGLE_DATA is a clone of github.com/jkkummerfeld/irc-disentanglement; see run.sh.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Link, type LinkInput, linkMessages } from "../../src/conversations/link.ts"

const data = process.env.DISENTANGLE_DATA
if (!data) throw new Error("set DISENTANGLE_DATA to a clone of irc-disentanglement (run.sh does it)")
const split = process.argv[2] ?? "test"
const out = join(data, "out", split)
mkdirSync(out, { recursive: true })

/** The corpus annotates lines from 1000 on; earlier lines are context. */
const FIRST_ANNOTATED = 1000

type Parents = Map<string, string | null>
const variants: Record<string, Parents[]> = {
  previous: [],
  rules: [],
  mention: [],
  "same-sender": [],
  "rules+previous": [],
}
const names: string[] = []

for (const file of readdirSync(join(data, "data", split)).filter((name) => name.endsWith(".ascii.txt")).sort()) {
  const name = file.replace(".ascii.txt", "")
  const messages = parse(name, readFileSync(join(data, "data", split, file), "utf8"))
  const handles = new Map(
    messages.flatMap(({ senderId }) => (senderId ? [[senderId.toLowerCase(), senderId] as const] : [])),
  )
  const { parents, links } = linkMessages(messages, { handles })
  names.push(name)
  variants.previous?.push(
    new Map(messages.map(({ id, senderId }, index) => [id, index === 0 || senderId === null ? null : String(index - 1)])),
  )
  variants.rules?.push(parents)
  variants.mention?.push(chosen(messages, links, "mention"))
  variants["same-sender"]?.push(chosen(messages, links, "same_sender"))
  variants["rules+previous"]?.push(
    new Map(
      messages.map(({ id, senderId }, index) => [
        id,
        parents.get(id) ?? (index === 0 || senderId === null ? null : String(index - 1)),
      ]),
    ),
  )
}

for (const [variant, perFile] of Object.entries(variants)) {
  const graphs: string[] = []
  const clusters: string[] = []
  perFile.forEach((parents, index) => {
    const name = names[index]
    const conversation = new Map<string, string>()
    for (const [id, parent] of parents) {
      conversation.set(id, parent === null ? id : (conversation.get(parent) ?? id))
      if (Number(id) >= FIRST_ANNOTATED) graphs.push(`${name}:${id} ${parent ?? id} -`)
    }
    const groups = new Map<string, string[]>()
    for (const [id, root] of conversation) if (Number(id) >= FIRST_ANNOTATED) groups.set(root, [...(groups.get(root) ?? []), id])
    for (const ids of groups.values()) clusters.push(`${name}:${ids.join(" ")}`)
  })
  writeFileSync(join(out, `${variant}.graphs.txt`), `${graphs.join("\n")}\n`)
  writeFileSync(join(out, `${variant}.clusters.txt`), `${clusters.join("\n")}\n`)
}
console.log(Object.keys(variants).join(" "))

/** `[HH:MM] <nick> text`, `[HH:MM] * nick action`, and `=== …` joins and quits, which have no sender. */
function parse(name: string, text: string): LinkInput[] {
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

function chosen(messages: LinkInput[], links: Link[], kind: Link["kind"]): Parents {
  const parents: Parents = new Map()
  for (const { id } of messages) parents.set(id, null)
  for (const link of links) if (link.kind === kind && parents.get(link.messageId) === null) parents.set(link.messageId, link.parentId)
  return parents
}
