import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { writeSecurely } from "@leemour/cli-core"
import { Command } from "commander"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { MIGRATIONS } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { storePath } from "../../store/path.js"
import { type BaseContext, baseContext, environmentOf, outputFor } from "../context.js"
import { listRuns, runsDirFor, runtime } from "../runs/run.js"
import { recalledAccount } from "./accounts.js"
import { type Messenger, messengerContext } from "./context.js"
import { buildReport, reportFileName } from "./report.js"

/**
 * The state this installation is in, read from disk and **never from the messenger unless
 * `--online`**. ⚠ It must answer when everything is broken, because that is when anybody runs it:
 * a configuration that will not load, a store written by a newer version, a keyring that will not
 * open — each is a field in the answer, never an exception.
 */
export const doctorCommand = (messenger: Messenger): Command => {
  const command = new Command("doctor")
    .description("the state this installation is in, without connecting unless --online")
    .option("--online", "also connect once and read the account; sends nothing")
    .action(async function (this: Command) {
      const { online } = this.opts<{ online?: boolean }>()
      const { report, renderer } = await diagnose(this, messenger)
      if (online && renderer) report.online = await onlineCheck(this, messenger, rememberedOf(report))
      ;(renderer ?? outputFor(this).renderer).result(report)
    })
  command.addCommand(reportCommand(messenger))
  return command
}

const INCLUDES = [
  "the version, the runtime and the operating system",
  "what `doctor` answers: paths with the home folder shown as ~, the store's schema and counts, the messenger's own checks",
  "the failed run — the newest, or the one named: each request's operation, duration and error code",
  "the last 20 send attempts: outcome and length",
  "every chat, message and account id replaced by a label that means nothing outside the file",
]
const EXCLUDES = ["message text", "chat titles", "names", "phone numbers", "the session", "the app credentials"]

const reportCommand = (messenger: Messenger): Command => {
  const { app } = messenger
  const report = new Command("report").description("what a problem report holds; writes nothing").action(function (
    this: Command,
  ) {
    const { renderer, format, streams } = outputFor(this)
    const create = `${app.command} doctor report create`
    if (format !== "pretty") {
      renderer.result({ includes: INCLUDES, excludes: EXCLUDES, create, ...(app.issues ? { sendTo: app.issues } : {}) })
      return
    }
    streams.data(
      [
        `A problem report is one file for the author of ${app.command}.`,
        "",
        "It holds:",
        ...INCLUDES.map((line) => `- ${line}`),
        "",
        `It never holds: ${EXCLUDES.join(", ")}.`,
        "",
        `Create one:          ${create}`,
        `About a given run:   ${create} --run <id>   (ids: ${app.command} runs list)`,
      ].join("\n"),
    )
  })

  report
    .command("create")
    .description("write a problem report to a file, and say where to send it")
    .option("--run <id>", "the run the report is about; the newest failed one if not given")
    .option("--output <file>", "where to write it; a new file in this directory if not given")
    .action(async function (this: Command) {
      const options = this.opts<{ run?: string; output?: string }>()
      const env = environmentOf(this).env ?? process.env
      const { report: doctor, renderer, profile } = await diagnose(this, messenger)
      const now = new Date()
      const built = buildReport({
        doctor,
        runsDir: runsDirFor(app, env),
        command: app.command,
        sends: profile ? new SendJournal(sendsPathFor(app, profile, env)).entries() : [],
        now,
        home: env.HOME ?? env.USERPROFILE,
        ...(options.run === undefined ? {} : { runId: options.run }),
      })
      const path = resolve(options.output ?? reportFileName(app.command, now))
      writeSecurely(path, `${JSON.stringify(built, null, 2)}\n`, 0o600)
      const out = renderer ?? outputFor(this).renderer
      out.result({ path, run: built.run?.metadata.runId ?? null, ...(app.issues ? { sendTo: app.issues } : {}) })
      if (!built.run) {
        out.note("no failed run is recorded — run the failing command again, and the failure is kept by itself")
      }
      out.note(
        `read it before sending: no message text, and ids are labels${app.issues ? ` — attach it to a new issue at ${app.issues}` : ""}`,
      )
    })

  return report
}

const rememberedOf = (report: Record<string, unknown>) =>
  (report.account as { remembered?: string | null } | undefined)?.remembered ?? undefined

/**
 * What `doctor` answers, as data. A configuration that will not load is a field, not an exception:
 * then there is no renderer from the settings, and the caller renders with the defaults.
 */
const diagnose = async (
  command: Command,
  messenger: Messenger,
): Promise<{ report: Record<string, unknown>; renderer?: BaseContext["renderer"]; profile?: string }> => {
  const { app, provider } = messenger
  const env = environmentOf(command).env ?? process.env
  const cli = {
    command: app.command,
    version: app.version,
    runtime: runtime(),
    platform: process.platform,
    arch: process.arch,
  }

  let context: BaseContext
  try {
    context = baseContext(command, messenger.resolveSettings)
  } catch (error) {
    return { report: { cli, config: { error: messageOf(error) } } }
  }
  const { settings, renderer } = context
  const { profile } = settings
  const account = recalledAccount(app, provider, profile, env)

  return {
    renderer,
    profile,
    report: {
      cli,
      profile,
      config: { path: settings.configPath, found: settings.configFound },
      account: { remembered: account?.account ?? null },
      store: await storeState(env),
      sends: sendsState(new SendJournal(sendsPathFor(app, profile, env))),
      runs: { directory: runsDirFor(app, env), kept: listRuns(runsDirFor(app, env)).length },
      [provider]: await (messenger.diagnose?.(command, context) ?? Promise.resolve({})).catch((error) => ({
        error: messageOf(error),
      })),
    },
  }
}

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
