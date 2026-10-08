import { CliError } from "@leemour/cli-core"
import { formatLocator, parseLocator } from "../../domain/locator.js"
import { normalizeTag } from "../../domain/tags.js"
import type { AccountKey } from "../store.js"
import { ulid } from "../ulid.js"
import type { StoreContext } from "./open.js"
import {
  addTags as addNativeTags,
  targetPk as nativeTargetPk,
  removeTags as removeNativeTags,
  type TagTarget,
} from "./tags.js"

export type KnowledgeTarget =
  | { type: "message"; locator: string }
  | { type: "chat"; id: string }
  | { type: "contact"; id: string }
  | { type: "person"; id: string }
  | { type: "task"; id: string }
  | { type: "entity"; id: string }

export interface Annotation {
  id: string
  target: KnowledgeTarget
  targetState: "available" | "deleted" | "unavailable"
  text: string
  revision: number
  authoredBy: "owner"
  createdAt: string
  updatedAt: string
}

export interface KnowledgeEntity {
  id: string
  kind: "organization" | "family" | "project" | "group"
  name: string
  createdAt: string
}

export interface KnowledgeRelation {
  id: string
  from: string
  to: string
  kind: "member-of" | "related-to" | "assigned-to"
  role: string | null
  evidence: string | null
  confirmed: boolean
  provenance: string | null
  confidenceCategory: "owner-confirmed" | "weak"
  createdAt: string
}

export interface Reminder {
  id: string
  task: string
  dueAt: string
  timezone: string
  state: "pending" | "leased" | "delivered" | "cancelled"
  revision: number
  receipt: string | null
}

export interface KnowledgeStore {
  taskIds(
    key: AccountKey,
    options?: { state?: "open" | "done" | "dismissed"; limit?: number; offset?: number; sources?: string[] },
  ): Promise<{ items: string[]; hasMore: boolean }>
  addAnnotation(key: AccountKey, target: KnowledgeTarget, text: string): Promise<Annotation>
  annotations(
    key: AccountKey,
    options?: { target?: KnowledgeTarget; search?: string; limit?: number; offset?: number },
  ): Promise<{ items: Annotation[]; hasMore: boolean }>
  annotation(key: AccountKey, id: string): Promise<Annotation>
  editAnnotation(key: AccountKey, id: string, text: string, revision: number): Promise<Annotation>
  removeAnnotation(key: AccountKey, id: string): Promise<{ id: string; removed: true }>
  tags(key: AccountKey, target: KnowledgeTarget): Promise<string[]>
  addTags(key: AccountKey, target: KnowledgeTarget, tags: string[]): Promise<string[]>
  removeTags(key: AccountKey, target: KnowledgeTarget, tags: string[]): Promise<string[]>
  labelled(
    key: AccountKey,
    options?: { tag?: string; limit?: number; offset?: number },
  ): Promise<{
    items: { target: KnowledgeTarget; tags: string[]; targetState: Annotation["targetState"] }[]
    hasMore: boolean
  }>
  addEntity(key: AccountKey, kind: KnowledgeEntity["kind"], name: string): Promise<KnowledgeEntity>
  entities(key: AccountKey): Promise<KnowledgeEntity[]>
  relate(
    key: AccountKey,
    input: {
      from: string
      to: string
      kind: KnowledgeRelation["kind"]
      role?: string
      evidence?: string
      confirmed?: boolean
      provenance?: string
    },
  ): Promise<KnowledgeRelation>
  relations(key: AccountKey, reference?: string): Promise<KnowledgeRelation[]>
  removeRelation(key: AccountKey, id: string): Promise<{ id: string; removed: true }>
  confirmRelation(key: AccountKey, id: string): Promise<KnowledgeRelation>
  schedule(key: AccountKey, task: string, dueAt: string, timezone: string): Promise<Reminder>
  reminders(key: AccountKey): Promise<Reminder[]>
  cancelReminder(key: AccountKey, id: string): Promise<Reminder>
  snoozeReminder(key: AccountKey, id: string, dueAt: string, revision: number): Promise<Reminder>
  claimReminders(key: AccountKey, options?: { limit?: number; leaseMs?: number }): Promise<Reminder[]>
  acknowledgeReminder(key: AccountKey, id: string, receipt: string): Promise<Reminder>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => new Date(Number(value)).toISOString()
const bounded = (limit = 100, offset = 0) => {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 100_000
  )
    throw new CliError("validation_error", "limit takes 1–500 and offset takes 0–100000")
  return { limit, offset }
}
const textOf = (text: string, max = 100_000) => {
  const value = text.trim()
  if (!value || value.length > max) throw new CliError("validation_error", `text takes 1–${max} characters`)
  return value
}

export const knowledgeStoreOver = (context: StoreContext): KnowledgeStore => {
  const { database, now } = context
  const account = (key: AccountKey) => {
    const row = database
      .prepare("SELECT pk FROM accounts WHERE provider=? AND native_id=?")
      .get(key.provider, key.account)
    if (!row) throw new CliError("not_found", "the account is not in the local store")
    return Number(row.pk)
  }
  const taskAccount = (key: AccountKey) => `${key.provider}:${key.account}`
  const state = (key: AccountKey, target: KnowledgeTarget): Annotation["targetState"] => {
    if (!["message", "chat", "contact", "person", "task", "entity"].includes(target.type))
      throw new CliError("validation_error", "unknown knowledge target")
    const pk = account(key)
    if (target.type === "message") {
      const source = parseLocator(target.locator)
      if (source.provider !== key.provider || source.account !== key.account)
        throw new CliError("validation_error", "the locator belongs to another account")
      const row = database
        .prepare(
          "SELECT m.deleted_at FROM messages m JOIN chats c ON c.pk=m.chat_pk WHERE c.account_pk=? AND c.native_id=? AND m.native_id=?",
        )
        .get(pk, source.chat, source.message)
      return !row ? "unavailable" : row.deleted_at == null ? "available" : "deleted"
    }
    if (!target.id.trim()) throw new CliError("validation_error", "target id must not be empty")
    const row =
      target.type === "chat"
        ? database.prepare("SELECT pk FROM chats WHERE account_pk=? AND native_id=?").get(pk, target.id)
        : target.type === "contact"
          ? database
              .prepare(
                "SELECT i.pk FROM identities i JOIN account_identities ai ON ai.identity_pk=i.pk WHERE ai.account_pk=? AND i.provider=? AND i.native_id=?",
              )
              .get(pk, key.provider, target.id)
          : target.type === "person"
            ? database
                .prepare(
                  "SELECT p.pk FROM persons p JOIN identity_links il ON il.person_pk=p.pk JOIN account_identities ai ON ai.identity_pk=il.identity_pk WHERE ai.account_pk=? AND p.uid=?",
                )
                .get(pk, target.id)
            : target.type === "task"
              ? database.prepare("SELECT id FROM tasks WHERE account=? AND id=?").get(taskAccount(key), target.id)
              : database.prepare("SELECT uid FROM knowledge_entities WHERE account_pk=? AND uid=?").get(pk, target.id)
    return row ? "available" : "unavailable"
  }
  const targetPk = (key: AccountKey, target: KnowledgeTarget, create: boolean) => {
    const pk = account(key)
    const reference = target.type === "message" ? formatLocator(parseLocator(target.locator)) : target.id
    if (create) {
      if (state(key, target) !== "available") throw new CliError("not_found", "the target is unavailable or deleted")
      database
        .prepare(
          "INSERT INTO knowledge_targets (account_pk,type,reference,created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(pk, target.type, reference, now())
    }
    const row = database
      .prepare("SELECT pk FROM knowledge_targets WHERE account_pk=? AND type=? AND reference=?")
      .get(pk, target.type, reference)
    return row ? Number(row.pk) : undefined
  }
  const targetOf = (row: Row): KnowledgeTarget =>
    row.type === "message"
      ? { type: "message", locator: String(row.reference) }
      : { type: row.type as Exclude<KnowledgeTarget["type"], "message">, id: String(row.reference) }
  const nativeTarget = (target: KnowledgeTarget): TagTarget | undefined => {
    if (target.type === "message") {
      const locator = parseLocator(target.locator)
      return { type: "message", chatId: locator.chat, messageId: locator.message }
    }
    if (target.type === "chat") return { type: "chat", chatId: target.id }
    if (target.type === "contact") return { type: "contact", personId: target.id }
    return undefined
  }
  const annotationOf = (key: AccountKey, row: Row): Annotation => {
    const target = targetOf(row)
    return {
      id: String(row.uid),
      target,
      targetState: state(key, target),
      text: String(row.text),
      revision: Number(row.revision),
      authoredBy: "owner",
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }
  }
  const annotation = (key: AccountKey, id: string): Annotation => {
    const row = database
      .prepare(
        "SELECT a.*,t.type,t.reference FROM annotations a JOIN knowledge_targets t ON t.pk=a.target_pk WHERE a.target_type='source' AND a.account_pk=? AND a.uid=? UNION ALL SELECT a.*, 'contact' AS type,i.native_id AS reference FROM annotations a JOIN identities i ON i.pk=a.target_pk JOIN account_identities ai ON ai.identity_pk=i.pk AND ai.account_pk=a.account_pk WHERE a.target_type='contact' AND a.account_pk=? AND a.uid=?",
      )
      .get(account(key), id, account(key), id)
    if (!row) throw new CliError("not_found", "no annotation with that id in this account")
    return annotationOf(key, row)
  }
  const entityOf = (row: Row): KnowledgeEntity => ({
    id: String(row.uid),
    kind: row.kind as KnowledgeEntity["kind"],
    name: String(row.name),
    createdAt: iso(row.created_at),
  })
  const relationOf = (row: Row): KnowledgeRelation => ({
    id: String(row.uid),
    from: String(row.from_ref),
    to: String(row.to_ref),
    kind: row.kind as KnowledgeRelation["kind"],
    role: row.role == null ? null : String(row.role),
    evidence: row.evidence == null ? null : String(row.evidence),
    confirmed: Number(row.confirmed) === 1,
    provenance: row.provenance == null ? null : String(row.provenance),
    confidenceCategory: Number(row.confirmed) === 1 ? "owner-confirmed" : "weak",
    createdAt: iso(row.created_at),
  })
  const reminderOf = (row: Row): Reminder => ({
    id: String(row.uid),
    task: String(row.task_id),
    dueAt: iso(row.due_at),
    timezone: String(row.timezone),
    state: row.state as Reminder["state"],
    revision: Number(row.revision),
    receipt: row.receipt == null ? null : String(row.receipt),
  })
  const reminder = (key: AccountKey, id: string) => {
    const row = database.prepare("SELECT * FROM knowledge_reminders WHERE account_pk=? AND uid=?").get(account(key), id)
    if (!row) throw new CliError("not_found", "no reminder with that id in this account")
    return reminderOf(row)
  }
  const due = (value: string) => {
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
      throw new CliError("validation_error", "due time needs an ISO timestamp with an explicit UTC offset")
    return Date.parse(value)
  }
  const openTask = (key: AccountKey, id: string) => {
    const row = database.prepare("SELECT state FROM tasks WHERE account=? AND id=?").get(taskAccount(key), id)
    if (row?.state !== "open")
      throw new CliError("validation_error", "a reminder requires an open task in this account")
  }
  const requiredReference = (key: AccountKey, reference: string, globalPerson = false) => {
    const [prefix, ...rest] = reference.split(":")
    if (
      globalPerson &&
      prefix === "person" &&
      database.prepare("SELECT uid FROM persons WHERE uid=?").get(rest.join(":"))
    )
      return
    if (
      (prefix !== "person" && prefix !== "entity" && prefix !== "task") ||
      state(key, { type: prefix, id: rest.join(":") }) !== "available"
    )
      throw new CliError("not_found", "reference needs a stored person:<uid> or entity:<uid> in this account")
  }
  return {
    taskIds: async (key, options = {}) => {
      const { limit, offset } = bounded(options.limit, options.offset)
      if (options.state !== undefined && !["open", "done", "dismissed"].includes(options.state))
        throw new CliError("validation_error", "unknown task state")
      if (options.sources && options.sources.length > 2000)
        throw new CliError("validation_error", "select at most 2000 task sources")
      if (options.sources?.length === 0) return { items: [], hasMore: false }
      account(key)
      const rows = database
        .prepare(
          `SELECT id FROM tasks WHERE account=? AND (? IS NULL OR state=?) ${options.sources ? `AND source IN (${options.sources.map(() => "?").join(",")})` : ""} ORDER BY created_at,id LIMIT ? OFFSET ?`,
        )
        .all(
          taskAccount(key),
          options.state ?? null,
          options.state ?? null,
          ...(options.sources ?? []),
          limit + 1,
          offset,
        )
      return { items: rows.slice(0, limit).map((row) => String(row.id)), hasMore: rows.length > limit }
    },
    addAnnotation: async (key, target, text) => {
      const body = textOf(text)
      const pk = targetPk(key, target, true)
      const at = now(),
        id = ulid(at)
      database
        .prepare(
          "INSERT INTO annotations (uid,account_pk,target_type,target_pk,text,revision,created_at,updated_at,authored_by) VALUES (?,?,'source',?,?,1,?,?,'owner')",
        )
        .run(id, account(key), pk as number, body, at, at)
      return annotation(key, id)
    },
    annotations: async (key, options = {}) => {
      const { limit, offset } = bounded(options.limit, options.offset)
      const target = options.target
      if (target) state(key, target)
      const reference = target?.type === "message" ? formatLocator(parseLocator(target.locator)) : target?.id
      const rows = database
        .prepare(
          "SELECT * FROM (SELECT a.*,t.type,t.reference FROM annotations a JOIN knowledge_targets t ON t.pk=a.target_pk WHERE a.target_type='source' AND a.account_pk=? UNION ALL SELECT a.*,'contact' AS type,i.native_id AS reference FROM annotations a JOIN identities i ON i.pk=a.target_pk JOIN account_identities ai ON ai.identity_pk=i.pk AND ai.account_pk=a.account_pk WHERE a.target_type='contact' AND a.account_pk=?) WHERE (? IS NULL OR (type=? AND reference=?)) AND (? IS NULL OR instr(lower(text),lower(?))>0) ORDER BY created_at DESC,uid DESC LIMIT ? OFFSET ?",
        )
        .all(
          account(key),
          account(key),
          target?.type ?? null,
          target?.type ?? null,
          reference ?? null,
          options.search ?? null,
          options.search ?? null,
          limit + 1,
          offset,
        )
      return { items: rows.slice(0, limit).map((row) => annotationOf(key, row)), hasMore: rows.length > limit }
    },
    annotation: async (key, id) => annotation(key, id),
    editAnnotation: async (key, id, text, revision) => {
      annotation(key, id)
      const changed = database
        .prepare(
          "UPDATE annotations SET text=?,revision=revision+1,updated_at=? WHERE account_pk=? AND uid=? AND target_type IN ('source','contact') AND revision=?",
        )
        .run(textOf(text), now(), account(key), id, revision).changes
      if (!changed)
        throw new CliError("validation_error", "annotation changed; read the current revision before editing")
      return annotation(key, id)
    },
    removeAnnotation: async (key, id) => {
      annotation(key, id)
      database
        .prepare("DELETE FROM annotations WHERE account_pk=? AND uid=? AND target_type IN ('source','contact')")
        .run(account(key), id)
      return { id, removed: true }
    },
    tags: async (key, target) => {
      const native = nativeTarget(target)
      if (native) {
        if (state(key, target) !== "available") return []
        return database
          .prepare("SELECT tag FROM tags WHERE taggable_type=? AND taggable_pk=? ORDER BY tag")
          .all(native.type, nativeTargetPk(context, key, native))
          .map((row) => String(row.tag))
      }
      const pk = targetPk(key, target, false)
      return pk === undefined
        ? []
        : database
            .prepare("SELECT tag FROM tags WHERE taggable_type='knowledge' AND taggable_pk=? ORDER BY tag")
            .all(pk)
            .map((row) => String(row.tag))
    },
    addTags: async (key, target, tags) => {
      const native = nativeTarget(target)
      if (native) {
        if (state(key, target) !== "available") throw new CliError("not_found", "target is unavailable or deleted")
        return addNativeTags(context, nativeTargetPk(context, key, native), native.type, [
          ...new Set(tags.map(normalizeTag)),
        ])
      }
      const labels = [...new Set(tags.map(normalizeTag))],
        pk = targetPk(key, target, true)
      return labels.filter(
        (tag) =>
          database
            .prepare(
              "INSERT INTO tags (taggable_type,taggable_pk,tag,created_at,manual) VALUES ('knowledge',?,?,?,1) ON CONFLICT DO NOTHING",
            )
            .run(pk as number, tag, now()).changes > 0,
      )
    },
    removeTags: async (key, target, tags) => {
      const native = nativeTarget(target)
      if (native) {
        if (state(key, target) !== "available") return []
        return removeNativeTags(context, nativeTargetPk(context, key, native), native.type, [
          ...new Set(tags.map(normalizeTag)),
        ])
      }
      const labels = [...new Set(tags.map(normalizeTag))],
        pk = targetPk(key, target, false)
      return pk === undefined
        ? []
        : labels.filter(
            (tag) =>
              database
                .prepare("DELETE FROM tags WHERE taggable_type='knowledge' AND taggable_pk=? AND tag=?")
                .run(pk, tag).changes > 0,
          )
    },
    labelled: async (key, options = {}) => {
      const { limit, offset } = bounded(options.limit, options.offset)
      const tag = options.tag === undefined ? null : normalizeTag(options.tag)
      const rows = database
        .prepare(
          "SELECT t.* FROM knowledge_targets t WHERE t.account_pk=? AND EXISTS (SELECT 1 FROM tags l WHERE l.taggable_type='knowledge' AND l.taggable_pk=t.pk AND (? IS NULL OR l.tag=?)) ORDER BY t.pk LIMIT ? OFFSET ?",
        )
        .all(account(key), tag, tag, limit + 1, offset)
      return {
        items: rows.slice(0, limit).map((row) => {
          const target = targetOf(row)
          return {
            target,
            tags: database
              .prepare("SELECT tag FROM tags WHERE taggable_type='knowledge' AND taggable_pk=? ORDER BY tag")
              .all(Number(row.pk))
              .map((label) => String(label.tag)),
            targetState: state(key, target),
          }
        }),
        hasMore: rows.length > limit,
      }
    },
    addEntity: async (key, kind, name) => {
      if (!["organization", "family", "project", "group"].includes(kind))
        throw new CliError("validation_error", "unknown entity kind")
      const at = now(),
        id = ulid(at),
        title = textOf(name, 200)
      database
        .prepare("INSERT INTO knowledge_entities (uid,account_pk,kind,name,created_at) VALUES (?,?,?,?,?)")
        .run(id, account(key), kind, title, at)
      return { id, kind, name: title, createdAt: iso(at) }
    },
    entities: async (key) =>
      database
        .prepare("SELECT * FROM knowledge_entities WHERE account_pk=? ORDER BY name,uid LIMIT 500")
        .all(account(key))
        .map(entityOf),
    relate: async (key, input) => {
      requiredReference(key, input.from)
      requiredReference(key, input.to, input.kind === "assigned-to")
      if (
        input.from === input.to ||
        !["member-of", "related-to", "assigned-to"].includes(input.kind) ||
        (input.kind === "assigned-to" && (!input.from.startsWith("task:") || !input.to.startsWith("person:")))
      )
        throw new CliError("validation_error", "a relationship needs distinct references and a supported kind")
      const pk = account(key)
      const existing = database
        .prepare("SELECT * FROM knowledge_relations WHERE account_pk=? AND from_ref=? AND to_ref=? AND kind=?")
        .get(pk, input.from, input.to, input.kind)
      if (existing) return relationOf(existing)
      const id = ulid(now())
      database
        .prepare(
          "INSERT INTO knowledge_relations (uid,account_pk,from_ref,to_ref,kind,role,evidence,created_at,confirmed,provenance) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          pk,
          input.from,
          input.to,
          input.kind,
          input.role === undefined ? null : textOf(input.role, 200),
          input.evidence === undefined ? null : textOf(input.evidence, 2000),
          now(),
          input.confirmed === false ? 0 : 1,
          input.provenance === undefined ? null : textOf(input.provenance, 2000),
        )
      return relationOf(database.prepare("SELECT * FROM knowledge_relations WHERE uid=?").get(id) as Row)
    },
    relations: async (key, reference) =>
      database
        .prepare(
          "SELECT * FROM knowledge_relations WHERE account_pk=? AND (? IS NULL OR from_ref=? OR to_ref=?) ORDER BY created_at,uid LIMIT 500",
        )
        .all(account(key), reference ?? null, reference ?? null, reference ?? null)
        .map(relationOf),
    removeRelation: async (key, id) => {
      if (
        !database.prepare("DELETE FROM knowledge_relations WHERE account_pk=? AND uid=?").run(account(key), id).changes
      )
        throw new CliError("not_found", "no relationship with that id in this account")
      return { id, removed: true }
    },
    confirmRelation: async (key, id) => {
      const row = database
        .prepare("SELECT * FROM knowledge_relations WHERE account_pk=? AND uid=?")
        .get(account(key), id)
      if (!row) throw new CliError("not_found", "no relationship with that id in this account")
      requiredReference(key, String(row.from_ref))
      requiredReference(key, String(row.to_ref), row.kind === "assigned-to")
      database.prepare("UPDATE knowledge_relations SET confirmed=1 WHERE account_pk=? AND uid=?").run(account(key), id)
      return relationOf({ ...row, confirmed: 1 })
    },
    schedule: async (key, task, dueAt, timezone) => {
      openTask(key, task)
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format()
      } catch {
        throw new CliError("validation_error", "unknown IANA timezone")
      }
      const timestamp = due(dueAt),
        pk = account(key)
      const existing = database
        .prepare(
          "SELECT * FROM knowledge_reminders WHERE account_pk=? AND task_id=? AND due_at=? AND state IN ('pending','leased')",
        )
        .get(pk, task, timestamp)
      if (existing) return reminderOf(existing)
      const id = ulid(now())
      database
        .prepare(
          "INSERT INTO knowledge_reminders (uid,account_pk,task_id,due_at,timezone,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,'pending',1,?,?)",
        )
        .run(id, pk, task, timestamp, timezone, now(), now())
      return reminder(key, id)
    },
    reminders: async (key) =>
      database
        .prepare("SELECT * FROM knowledge_reminders WHERE account_pk=? ORDER BY due_at,uid LIMIT 500")
        .all(account(key))
        .map(reminderOf),
    cancelReminder: async (key, id) => {
      reminder(key, id)
      database
        .prepare(
          "UPDATE knowledge_reminders SET state='cancelled',revision=revision+1,receipt=NULL,lease_until=NULL,updated_at=? WHERE account_pk=? AND uid=? AND state IN ('pending','leased')",
        )
        .run(now(), account(key), id)
      return reminder(key, id)
    },
    snoozeReminder: async (key, id, dueAt, revision) => {
      const held = reminder(key, id)
      openTask(key, held.task)
      if (
        !database
          .prepare(
            "UPDATE knowledge_reminders SET due_at=?,state='pending',revision=revision+1,receipt=NULL,lease_until=NULL,updated_at=? WHERE account_pk=? AND uid=? AND revision=? AND state<>'cancelled'",
          )
          .run(due(dueAt), now(), account(key), id, revision).changes
      )
        throw new CliError("validation_error", "reminder changed or was cancelled")
      return reminder(key, id)
    },
    claimReminders: async (key, options = {}) => {
      const { limit } = bounded(options.limit),
        lease = options.leaseMs ?? 60_000
      if (!Number.isInteger(lease) || lease < 1000 || lease > 3_600_000)
        throw new CliError("validation_error", "lease takes 1000–3600000 milliseconds")
      const pk = account(key),
        at = now()
      database
        .prepare(
          "UPDATE knowledge_reminders SET state='cancelled',receipt=NULL,lease_until=NULL,updated_at=? WHERE account_pk=? AND state IN ('pending','leased') AND task_id NOT IN (SELECT id FROM tasks WHERE account=? AND state='open')",
        )
        .run(at, pk, taskAccount(key))
      const rows = database
        .prepare(
          "SELECT uid FROM knowledge_reminders WHERE account_pk=? AND due_at<=? AND (state='pending' OR (state='leased' AND lease_until<=?)) ORDER BY due_at,uid LIMIT ?",
        )
        .all(pk, at, at, limit)
      const claimed: Reminder[] = []
      for (const row of rows) {
        const receipt = ulid(at)
        if (
          database
            .prepare(
              "UPDATE knowledge_reminders SET state='leased',receipt=?,lease_until=?,updated_at=? WHERE account_pk=? AND uid=? AND (state='pending' OR (state='leased' AND lease_until<=?))",
            )
            .run(receipt, at + lease, at, pk, String(row.uid), at).changes
        )
          claimed.push(reminder(key, String(row.uid)))
      }
      return claimed
    },
    acknowledgeReminder: async (key, id, receipt) => {
      const held = reminder(key, id)
      if (held.state === "delivered" && held.receipt === receipt) return held
      openTask(key, held.task)
      if (
        !database
          .prepare(
            "UPDATE knowledge_reminders SET state='delivered',lease_until=NULL,updated_at=? WHERE account_pk=? AND uid=? AND state='leased' AND receipt=? AND lease_until>?",
          )
          .run(now(), account(key), id, receipt, now()).changes
      )
        throw new CliError("validation_error", "receipt is stale or the delivery lease expired")
      return reminder(key, id)
    },
  }
}
