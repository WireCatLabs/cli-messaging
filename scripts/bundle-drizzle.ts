/**
 * Bundles the Drizzle modules the store uses into `dist/store/sqlite/drizzle/`, over what `tsc` wrote.
 * Loaded from `node_modules`, Drizzle costs Node about 200 ms per process: its 290 KB `package.json`
 * is read for each of its 72 modules. Bundled, it loads in a few milliseconds (NEED-385 A). The Node
 * and Bun drivers stay separate entries — each imports its own runtime's SQLite at the top.
 *
 *   node scripts/bundle-drizzle.ts          (part of `pnpm build`)
 */
import { join } from "node:path"
import { build } from "esbuild"

const root = join(import.meta.dirname, "..")
await build({
  entryPoints: ["core", "node", "bun"].map((name) => join(root, "src/store/sqlite/drizzle", `${name}.ts`)),
  outdir: join(root, "dist/store/sqlite/drizzle"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["node:sqlite", "bun:sqlite"],
  chunkNames: "shared-[hash]",
  sourcemap: true,
  logLevel: "warning",
})
