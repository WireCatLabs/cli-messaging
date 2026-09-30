// Tunes the same-sender rule on the IRC dev split: its window in messages and minutes, and whether it
// or the mention rule wins when both fire. Link F is computed as graph-eval.py does. Choose on dev,
// then report test once with run.sh.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type LinkInput, linkMessages } from "../../src/conversations/link.ts"
import { parse } from "./corpus.ts"

const data = process.env.DISENTANGLE_DATA
if (!data) throw new Error("set DISENTANGLE_DATA")
const split = process.argv[2] ?? "dev"

const gold = new Set<string>()
for (const line of readFileSync(join(data, "data", `gold.${split}.graphs.txt`), "utf8").trim().split("\n")) {
  const [file, rest = ""] = line.split(":")
  const nums = rest.trim().split(/\s+/).filter((n) => n !== "-").map(Number)
  const source = Math.max(...nums)
  const others = nums.filter((n, index) => !(n === source && index === nums.indexOf(source)))
  for (const target of others.length ? others : [source]) gold.add(`${file}:${source}:${target}`)
}

const files = readdirSync(join(data, "data", split))
  .filter((name) => name.endsWith(".ascii.txt"))
  .map((file) => {
    const name = file.replace(".ascii.txt", "")
    const messages = parse(name, readFileSync(join(data, "data", split, file), "utf8"))
    const handles = new Map(messages.flatMap(({ senderId }) => (senderId ? [[senderId.toLowerCase(), senderId] as const] : [])))
    return { name, messages, mentions: linkMessages(messages, { handles }).links.filter((l) => l.kind === "mention") }
  })

const sameSender = (messages: LinkInput[], within: number, ms: number) => {
  const parents = new Map<string, string>()
  messages.forEach((message, index) => {
    for (let back = index - 1; back >= Math.max(0, index - within); back--) {
      const candidate = messages[back]
      if (!candidate || candidate.senderId !== message.senderId || message.senderId === null) continue
      if (Date.parse(message.timestamp) - Date.parse(candidate.timestamp) <= ms) parents.set(message.id, candidate.id)
      break
    }
  })
  return parents
}

const rows: string[] = []
for (const within of [1, 2, 3, 5, 10, 20, 50]) {
  for (const minutes of [1, 2, 5, 10, 30]) {
    for (const first of ["mention", "same-sender"] as const) {
      let matched = 0
      let auto = 0
      for (const { name, messages, mentions } of files) {
        const bySender = sameSender(messages, within, minutes * 60_000)
        const byMention = new Map<string, string>()
        for (const link of mentions) if (!byMention.has(link.messageId)) byMention.set(link.messageId, link.parentId)
        for (const { id } of messages) {
          if (Number(id) < 1000) continue
          const parent =
            first === "mention" ? (byMention.get(id) ?? bySender.get(id)) : (bySender.get(id) ?? byMention.get(id))
          auto++
          if (gold.has(`${name}:${id}:${parent ?? id}`)) matched++
        }
      }
      const p = matched / auto
      const r = matched / gold.size
      rows.push(`${((200 * p * r) / (p + r)).toFixed(1)}  within ${within}, ${minutes} min, ${first} first`)
    }
  }
}
console.log(rows.sort().reverse().slice(0, 8).join("\n"))
