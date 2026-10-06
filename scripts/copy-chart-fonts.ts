import { cpSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
cpSync(join(root, "src/charts/fonts"), join(root, "dist/charts/fonts"), { recursive: true })
