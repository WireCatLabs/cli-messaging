import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PRESETS } from "../dist/search/lucene/presets.js"
import { QUERY_FIELDS, QUERY_OPERATORS } from "../dist/search/lucene/registry.js"
import { QUERY_LIMITS } from "../dist/search/lucene/types.js"

const root = join(import.meta.dirname, "..")
const guide = join(root, "docs/search/query-language.md")
const text = readFileSync(guide, "utf8")
const fields = [
  "| Поле | Тип | Значения / нормализация | Пример | Поддержка |",
  "|---|---|---|---|---|",
  ...QUERY_FIELDS.map(
    (field) =>
      `| \`${field.name}\` | ${field.type} | ${"values" in field ? field.values.join(", ") : field.normalization} | \`${field.example}\` | ${field.operators.join(", ")} |`,
  ),
].join("\n")
const operators = [
  "| Оператор | Пример | Семантика / поддержка |",
  "|---|---|---|",
  ...QUERY_OPERATORS.map(
    (entry) =>
      `| ${entry.name.replaceAll("|", "\\|")} | \`${entry.example.replaceAll("|", "\\|")}\` | ${entry.semantics.replaceAll("|", "\\|")} |`,
  ),
].join("\n")
const presets = [
  "| Preset | Что считается кандидатом (version 1) |",
  "|---|---|",
  ...Object.entries(PRESETS).map(([name, entry]) => `| \`${name}\` | ${entry.explanation} |`),
].join("\n")
const limits = [
  "| Ограничение | Значение |",
  "|---|---|",
  ...Object.entries(QUERY_LIMITS).map(([name, value]) => `| \`${name}\` | ${value} |`),
].join("\n")
interface Recipe {
  title: string
  query: string
  ids: string[]
}
const recipes: { recipes: Recipe[] } = JSON.parse(readFileSync(join(root, "docs/search/recipes.json"), "utf8"))
const examples = recipes.recipes
  .map(
    (recipe) =>
      `### ${recipe.title}\n\n\`\`\`sh\ntg messages search '${recipe.query.replaceAll("'", "'\\''")}' --timezone UTC\n\`\`\`\n\nНа synthetic fixture: ids ${recipe.ids.join(", ")}. В MAX замените первый аргумент \`tg\` на \`max\`.`,
  )
  .join("\n\n")
let result = text
for (const [name, body] of [
  ["fields", fields],
  ["operators", operators],
  ["presets", presets],
  ["limits", limits],
  ["recipes", examples],
]) {
  const start = `<!-- ${name}: generated -->`,
    end = `<!-- ${name}: end -->`
  if (!result.includes(start) || !result.includes(end)) throw new Error(`missing ${name} generation markers`)
  const from = result.indexOf(start) + start.length,
    to = result.indexOf(end, from)
  result = `${result.slice(0, from)}\n\n${body}\n\n${result.slice(to)}`
}
if (process.argv.includes("--check")) {
  if (result !== text) throw new Error("search reference drift — run pnpm search:docs")
} else writeFileSync(guide, result)
