/**
 * Writes every folder drizzle-kit generated under drizzle/ into src/store/sqlite/migrations.generated.ts,
 * so the migrations ship in dist like any other code: tsc does not copy .sql files, and a bundle needs
 * no path resolved at runtime on either Node or Bun.
 *
 *   pnpm db:bundle
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
const folders = readdirSync(join(root, "drizzle"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const generated = folders.map((name) => ({
  name,
  statements: readFileSync(join(root, "drizzle", name, "migration.sql"), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean),
}))

writeFileSync(
  join(root, "src/store/sqlite/migrations.generated.ts"),
  `// Written by scripts/bundle-migrations.ts from drizzle/ — run \`pnpm db:bundle\`, do not edit.\n` +
    `export const GENERATED: { name: string; statements: string[] }[] = ${JSON.stringify(generated, null, 2)}\n`,
)
console.log(`bundled ${generated.length} migration${generated.length === 1 ? "" : "s"}`)
