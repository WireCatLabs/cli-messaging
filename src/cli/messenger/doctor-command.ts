import { existsSync } from "node:fs"
import { Command } from "commander"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { MIGRATIONS } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { storePath } from "../../store/path.js"
import { type BaseContext, baseContext, environmentOf, outputFor } from "../context.js"
import { listRuns, runsDirFor, runtime } from "../runs/run.js"
import { recalledAccount } from "./accounts.js"
import { type Messenger, messengerContext } from "./context.js"

/**
 * The state this installation is in, read from disk and **never from the messenger unless
 * `--online`**. ⚠ It must answer when everything is broken, because that is when anybody runs it:
 * a configuration that will not load, a store written by a newer version, a keyring that will not
 * open — each is a field in the answer, never an exception.
 */
export const doctorCommand = (messenger: Messenger): Command =>
  new Command("doctor")
    .description("the state this installation is in, without connecting unless --online")
    .option("--online", "also connect once and read the account; sends nothing")
    .action(async function (this: Command) {
      const { online } = this.opts<{ online?: boolean }>()
      const { app, provider } = messenger
      const env = environmentOf(this).env ?? process.env
      const cli = {
        command: app.command,
        version: app.version,
        runtime: runtime(),
        platform: process.platform,
        arch: process.arch,
      }

      let context: BaseContext
      try {
        context = baseContext(this, messenger.resolveSettings)
      } catch (error) {
        outputFor(this).renderer.result({ cli, config: { error: messageOf(error) } })
        return
      }
      const { settings, renderer } = context
      const { profile } = settings
      const account = recalledAccount(app, provider, profile, env)

      const report: Record<string, unknown> = {
        cli,
        profile,
        config: { path: settings.configPath, found: settings.configFound },
        account: { remembered: account?.account ?? null },
        store: await storeState(env),
        sends: sendsState(new SendJournal(sendsPathFor(app, profile, env))),
        runs: { directory: runsDirFor(app, env), kept: listRuns(runsDirFor(app, env)).length },
        [provider]: await (messenger.diagnose?.(this, context) ?? Promise.resolve({})).catch((error) => ({
          error: messageOf(error),
        })),
      }

      if (online) report.online = await onlineCheck(this, messenger, account?.account)
      renderer.result(report)
    })

/** Read without migrating: a doctor that upgraded the file would change what it was asked to look at. */
const storeState = async (env: NodeJS.ProcessEnv) => {
  const path = storePath(env)
  if (!existsSync(path)) return { path, exists: false }
  try {
    const database = await openCache(path)
    try {
      const schema = database
        .prepare("SELECT version, min_compatible FROM schema_migrations ORDER BY version DESC LIMIT 1")
        .get()
      const speaks = MIGRATIONS.at(-1)?.version ?? 0
      const version = Number(schema?.version ?? 0)
      const count = (table: string) => Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0)
      return {
        path,
        exists: true,
        schema: version,
        speaks,
        writable: version <= speaks || Number(schema?.min_compatible ?? 0) <= speaks,
        ...(version > 0 ? { chats: count("chats"), messages: count("messages") } : {}),
      }
    } finally {
      database.close()
    }
  } catch (error) {
    return { path, exists: true, error: messageOf(error) }
  }
}

const sendsState = (journal: SendJournal) => {
  const entries = journal.entries()
  const hourAgo = Date.now() - 60 * 60 * 1000
  return {
    attempts: entries.length,
    lastHour: entries.filter((entry) => Date.parse(entry.at) > hourAgo).length,
  }
}

const onlineCheck = async (command: Command, messenger: Messenger, remembered: string | undefined) => {
  const started = Date.now()
  try {
    const me = await messengerContext(command, messenger).withMessenger((connection) => connection.me())
    return {
      ok: true,
      account: me.id,
      ...(remembered === undefined ? {} : { matchesRemembered: me.id === remembered }),
      durationMs: Date.now() - started,
    }
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    return {
      ok: false,
      errorCode: typeof code === "string" ? code : "generic_failure",
      durationMs: Date.now() - started,
    }
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
