import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = process.argv[2],
  repo = process.argv[3],
  require = createRequire(`${repo}/package.json`)
const { captureStreams, memoryKeyring } = await import(require.resolve("@leemour/cli-core"))
const { openStore } = await import(require.resolve("@leemour/cli-messaging/store"))
const { rememberAccount } = await import(require.resolve("@leemour/cli-messaging/cli"))
const temp = mkdtempSync(join(tmpdir(), `parity-deep-search-${cli}-`))
Object.assign(process.env, {
  MAX_CONFIG_DIR: join(temp, "max-config"),
  MAX_STATE_DIR: join(temp, "max-state"),
  MAX_CACHE_DIR: join(temp, "max-cache"),
  TG_CONFIG_DIR: join(temp, "tg-config"),
  TG_STATE_DIR: join(temp, "tg-state"),
  TG_CACHE_DIR: join(temp, "tg-cache"),
  CLI_COMMON_CACHE_DIR: join(temp, "common"),
  MESSAGING_STORE: join(temp, "messages.db"),
  MAX_NO_UPDATE_CHECK: "1",
  TG_NO_UPDATE_CHECK: "1",
})
const { run } = await import(`${repo}/dist/program.js`)
const app = await import(`${repo}/dist/app.js`)
const identity = app.MAX_APP ?? app.TG
const provider = cli === "max" ? "max" : "telegram"
let maxSession
let networkAttempts = 0
const refuseNetwork = () => {
  networkAttempts++
  throw new Error("audit cannot connect")
}
globalThis.fetch = refuseNetwork
rememberAccount(identity, "default", "500", process.env)
if (cli === "max") {
  const { SessionStore } = await import(`${repo}/dist/session/store.js`)
  const session = new SessionStore({ keyring: memoryKeyring(), env: process.env })
  maxSession = session
  session.writeState({ ...session.readState(), viewerId: "500" })
}
const recipes = JSON.parse(readFileSync(process.argv[4], "utf8"))
const db = await openStore({ path: process.env.MESSAGING_STORE })
const account = { provider, account: "500" }
await db.saveChats(
  account,
  recipes.chats.map((c) => ({ ...c, unreadCount: 0, lastMessageAt: null, participantsCount: null })),
)
for (const chat of recipes.chats)
  await db.saveMessages(
    account,
    chat.id,
    recipes.messages
      .filter((m) => m.chatId === chat.id)
      .map((m) => ({
        editedAt: null,
        outgoing: false,
        attachments: [],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
        ...m,
      })),
    { via: "history" },
  )
await db.close()
const results = []
const cases = [...recipes.recipes, ...recipes.negative].flatMap((recipe) => [
  { ...recipe, explicit: true },
  { ...recipe, explicit: false },
])
for (const recipe of cases) {
  const streams = captureStreams()
  const code = await run(
    [
      "messages",
      "search",
      recipe.query,
      ...(recipe.explicit ? ["--language", "lucene"] : []),
      "--timezone",
      "UTC",
      "--json",
      "--offline",
      "--no-record",
    ],
    {
      env: process.env,
      streams,
      tty: false,
      keyring: memoryKeyring(),
      ...(maxSession ? { store: () => maxSession, connection: refuseNetwork } : {}),
      adapter: () => {
        networkAttempts++
        throw Error("audit cannot connect")
      },
    },
  )
  const stdout = streams.stdout.join("\n")
  const stderr = streams.stderr.join("\n")
  if (recipe.ids) {
    assert.equal(code, 0, recipe.title + stderr)
    const a = JSON.parse(stdout)
    assert.deepEqual(a.items.map((x) => x.id).sort(), recipe.ids, recipe.title)
    assert.equal(a.query.language, "lucene-v1")
    assert.ok(a.coverage)
    results.push({
      query: recipe.query,
      mode: recipe.explicit ? "explicit" : "default",
      code,
      ids: a.items.map((x) => x.id).sort(),
      metadataKeys: Object.keys(a).sort(),
    })
  } else {
    assert.equal(code, 2, recipe.query)
    assert.ok(stderr.includes(recipe.reason), stderr)
    results.push({ query: recipe.query, mode: recipe.explicit ? "explicit" : "default", code, reason: recipe.reason })
  }
}
const reads = []
for (const argv of [
  ["chats", "list", "--limit", "2"],
  ["chats", "list", "--kind", "group"],
  ["chats", "show", "7"],
  ["messages", "list", "7", "--limit", "2"],
  ["messages", "show", "7", "101"],
  ["messages", "context", "7", "102", "--before-n", "1", "--after-n", "1"],
  ["messages", "list", "7", "--before-id", "105", "--limit", "2"],
  ["store", "check"],
]) {
  const streams = captureStreams()
  const code = await run([...argv, "--json", "--offline", "--no-record"], {
    env: process.env,
    streams,
    tty: false,
    keyring: memoryKeyring(),
    ...(maxSession ? { store: () => maxSession, connection: refuseNetwork } : {}),
    adapter: () => {
      networkAttempts++
      throw Error("audit cannot connect")
    },
  })
  assert.equal(code, 0, argv.join(" ") + streams.stderr.join(" "))
  reads.push({ argv, code, answer: JSON.parse(streams.stdout.join("\n")) })
}
assert.equal(networkAttempts, 0)
console.log(JSON.stringify({ cli, provider, results, reads, networkAttempts, temp }, null, 2))
