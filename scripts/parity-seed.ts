/**
 * Adds to `parity.json` what the CLIs have and it does not list yet, and sorts it. A row that exists is
 * never changed: where a command is, a reason and a meaning are edited by hand, and a seed must not
 * write today's differences back over them. A new row that some CLIs lack comes in planned for them
 * with `by: "?"`, for someone to replace with who closes it.
 *
 *   node dist/bin/max.js commands --json > max.json; node dist/bin/tg.js commands --json > tg.json
 *   pnpm parity:seed max.json tg.json      # one file per CLI in "clis"
 *
 * A new CLI joins with `pnpm parity:seed --cli wa`: it is added to "clis" and every row and option is
 * planned for it, so its parity check passes from its first pull request and the gaps stay visible.
 * Its author then narrows the rows to what it has.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { formatManifest, seedCli, seedPrograms } from "../dist/parity/seed.js"

const { values, positionals } = parseArgs({ options: { cli: { type: "string" } }, allowPositionals: true })
const path = join(import.meta.dirname, "../parity.json")
const manifest = JSON.parse(readFileSync(path, "utf8"))

const seeded =
  values.cli !== undefined && positionals.length === 0
    ? seedCli(manifest, values.cli)
    : positionals.length > 0 && values.cli === undefined
      ? seedPrograms(
          manifest,
          positionals.map((file) => JSON.parse(readFileSync(file, "utf8"))),
        )
      : undefined
if (!seeded) throw new Error("usage: parity-seed <commands.json...> | parity-seed --cli <name>")
writeFileSync(path, formatManifest(seeded))
