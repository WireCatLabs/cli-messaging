/**
 * Writes the option catalogue from `parity.json` into `docs/dev/STANDARD.md`, between its markers.
 * A test fails when the page and the manifest disagree, so run this after editing either.
 *
 *   pnpm parity:render
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { renderCatalogue, withCatalogue } from "../src/parity/catalogue.ts"

const root = join(import.meta.dirname, "..")
const page = join(root, "docs/dev/STANDARD.md")
const manifest = JSON.parse(readFileSync(join(root, "parity.json"), "utf8"))
writeFileSync(page, withCatalogue(readFileSync(page, "utf8"), renderCatalogue(manifest)))
