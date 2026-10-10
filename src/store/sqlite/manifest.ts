import type { Migration } from "../migrations.js"
import { GENERATED } from "./migrations.generated.js"

/**
 * Every folder drizzle-kit generated, in order, and the schema version it becomes. Consecutive
 * folders may share a version — a generated one and a `--custom` one for its triggers — and are
 * applied as one migration, one `schema_migrations` row. The version and
 * `minCompatible` are ours, not Drizzle's: `schema_migrations` is the only log, and every build
 * already installed decides by it.
 */
export interface ManifestEntry {
  name: string
  version: number
  minCompatible: number
}

/**
 * The v2 baseline is version 100, not 1: a build of the old line speaks up to 28 and refuses a file whose
 * `minCompatible` is above that, while a v2 file numbered 1 would look older to it and be migrated.
 * 100 also leaves the old line room for versions of its own before v2 ships.
 */
export const BASELINE = 100

export const MANIFEST: ManifestEntry[] = [
  { name: "20261010130203_store-v2-baseline", version: BASELINE, minCompatible: BASELINE },
  { name: "20261010130206_store-v2-search", version: BASELINE, minCompatible: BASELINE },
]

export const generatedMigrations = (
  manifest: ManifestEntry[] = MANIFEST,
  generated: { name: string; statements: string[] }[] = GENERATED,
): Migration[] => {
  const migrations: Migration[] = []
  for (const entry of manifest) {
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
