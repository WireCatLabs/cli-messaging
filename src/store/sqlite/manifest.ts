import type { Migration } from "../migrations.js"
import { GENERATED } from "./migrations.generated.js"

/**
 * Every folder drizzle-kit generated, in order, and the schema version it becomes. Consecutive
 * folders may share a version — a generated one and a `--custom` one for its triggers — and are
 * applied as one migration, one `schema_migrations` row. The version and
 * `minCompatible` are ours, not Drizzle's: `schema_migrations` is the only log, and every build
 * already installed decides by it.
 */
export type ManifestEntry =
  | { name: string; version: number; minCompatible: number }
  /** Built by versions 1–5 before Drizzle; kept only as what drizzle-kit diffs against. */
  | { name: string; coveredByHandWritten: true }

export const MANIFEST: ManifestEntry[] = [
  { name: "20260929205838_baseline", coveredByHandWritten: true },
  // Older builds refuse the file from here on (plan D6): none of them writes normalized_text.
  { name: "20260930003739_version-6-columns", version: 6, minCompatible: 6 },
  { name: "20260930003740_version-6-message-count", version: 6, minCompatible: 6 },
  { name: "20260930022658_version-7-chat-members", version: 7, minCompatible: 6 },
  { name: "20260930023839_version-8-sync-state", version: 8, minCompatible: 6 },
  { name: "20260930024055_version-9-fetch-leases", version: 9, minCompatible: 6 },
  { name: "20260930024643_version-10-contacts", version: 10, minCompatible: 6 },
  { name: "20260930024933_version-11-transcripts", version: 11, minCompatible: 6 },
  { name: "20261001110735_version-12-search-state", version: 12, minCompatible: 6 },
  { name: "20261001110736_version-12-word-index", version: 12, minCompatible: 6 },
]

export const generatedMigrations = (
  manifest: ManifestEntry[] = MANIFEST,
  generated: { name: string; statements: string[] }[] = GENERATED,
): Migration[] => {
  const migrations: Migration[] = []
  for (const entry of manifest) {
    if ("coveredByHandWritten" in entry) continue
    const found = generated.find(({ name }) => name === entry.name)
    if (!found) throw new Error(`migration ${entry.name} is in the manifest and not in the bundle — run pnpm db:bundle`)
    const last = migrations.at(-1)
    if (last?.version !== entry.version) {
      migrations.push({ version: entry.version, minCompatible: entry.minCompatible, statements: [...found.statements] })
    } else if (last.minCompatible !== entry.minCompatible) {
      throw new Error(`the rows of version ${entry.version} disagree on minCompatible`)
    } else {
      last.statements.push(...found.statements)
    }
  }
  return migrations
}
