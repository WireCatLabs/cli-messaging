# Conventions

**How commands, options, answers and MCP tools of tg and max are named and shaped is
[`STANDARD.md`](STANDARD.md)** — it lives here, and both CLIs link it.

**The shared rules are max-cli's** —
[max-cli `docs/dev/CONVENTIONS.md`](https://github.com/leemour/max-cli/blob/main/docs/dev/CONVENTIONS.md):
the linter decides formatting, strict TypeScript with no `any`, sparse comments that say *why*,
core code takes its environment as arguments, one-shot means the process exits, no credential or
message in a log, a test must not prepare what a first run lacks, documents corrected in place.

What differs here:

- **English everywhere.** The README, these pages and the changelog are English; max-cli's newer
  documents are Russian.
- **No messenger.** max-cli's "wire names below the adapter" rule becomes stricter: there is no
  adapter here at all, and the lint rule in `biome.json` refuses one.
- **No user pages rule.** max-cli keeps its Russian user pages free of correction marks and ids;
  here the README is the only user page, and the same spirit applies — current facts only.
- **The changelog** has these headings, each at most once per version: `Added`,
  `Changed — may break callers`, `Fixed`, `Security`, `Removed`. The top section is
  `## Unreleased`; a release PR renames it `## <version> — DD.MM.YYYY`. No backlog or decision ids.
  An entry says what changed for a caller, why when it is not obvious, and what to do when it
  breaks something. `pnpm docs:check` checks the shape.
- **No `docs_ai/` in this repository.** It is gitignored; plans that others need are committed
  under [`docs/plans/`](../plans/).
- **Parallel sessions.** Work in a worktree, rebase on `origin/main` before pushing, and announce a
  store migration first ([`ARCHITECTURE.md`](ARCHITECTURE.md#migrations)).

A link from one repository to another is a GitHub URL. A relative path into a sibling checkout
resolves on one machine and nowhere else, and `pnpm docs:check` refuses it.
