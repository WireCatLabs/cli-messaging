import type { Migration } from "../migrations.js"
import { GENERATED } from "./migrations.generated.js"

/**
 * Every folder drizzle-kit generated, in order, and the schema version it becomes. The version and
 * `minCompatible` are ours, not Drizzle's: `schema_migrations` is the only log, and every build
 * already installed decides by it.
 */
export type ManifestEntry =
  | { name: string; version: number; minCompatible: number }
  /** Built by versions 1–5 before Drizzle; kept only as what drizzle-kit diffs against. */
  | { name: string; coveredByHandWritten: true }

export const MANIFEST: ManifestEntry[] = [{ name: "20260929205838_baseline", coveredByHandWritten: true }]

export const generatedMigrations = (
  manifest: ManifestEntry[] = MANIFEST,
  generated: { name: string; statements: string[] }[] = GENERATED,
): Migration[] =>
  manifest.flatMap((entry) => {
    if ("coveredByHandWritten" in entry) return []
    const found = generated.find(({ name }) => name === entry.name)
    if (!found) throw new Error(`migration ${entry.name} is in the manifest and not in the bundle — run pnpm db:bundle`)
    return [{ version: entry.version, minCompatible: entry.minCompatible, statements: found.statements }]
  })
