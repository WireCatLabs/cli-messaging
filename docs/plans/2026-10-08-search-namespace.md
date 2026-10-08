# Every search under `search <resource>`

**Status:** approved 2026-10-08. Nothing is built.
Rule: [STANDARD.md, "Search hierarchy"](../dev/STANDARD.md#search-hierarchy) and "No two commands overlap"
under command names. Goes with [`2026-10-08-notes-graph.md`](2026-10-08-notes-graph.md), which adds notes.

## 1. Goal

One place to search, so an agent that learns it finds every kind of thing. `search all` is the default;
each resource is a narrower leaf of the same command, not a sibling elsewhere in the tree. No aliases:
old paths stop working in the release that adopts the tree (STANDARD.md rule 9).

## 2. Mapping (tg and max alike unless noted)

| Today | After | Notes |
|---|---|---|
| — | `search all [query]` | messages, mail and notes in the local store, merged and ranked; each hit typed (`msg:`, `note:`) |
| `messages search` | `search messages [query]` | messenger messages only; keeps `--backend archive\|server\|both`, `--sync-first` |
| `messages search 'in:email …'` | `search mail [query]` | mail is its own resource for the reader, though stored as messages |
| — (memo `notes search`) | `search notes [query]` | from the notes plan |
| `conversations search` | `search conversations <query>` | |
| `topics search <chat> <text>` (tg) | `search topics <chat> <text>` | topic titles in one forum group |
| `bot messages search` | `bot search messages` | the account namespace comes first, as `bot stats` |
| `memo search`, `memo notes search` | `memo search all\|notes\|mail\|messages` | the same shared leaves |
| `searches …` | unchanged | saved searches are records; their stored command paths are migrated (§3) |

`search messages` must not return mail and `search mail` must not return messages, or the two overlap.
Only `search all` spans resources.

## 3. Moving together (STANDARD.md, "Relocations are coordinated changes")

- CLI paths, help, completion, `commands` manifest, generated `docs/commands.md` in tg and max.
- MCP tool names follow the command (`search_all`, `search_messages`, …); the `search_all` description
  says it is the first tool to use.
- Permission keys: `messages.search` → `search.messages` and so on, with an explicit migration of saved
  profiles; never a broader key.
- Saved searches (`searches`): stored records that name an old path get it rewritten by a store
  migration.
- Skills, cli-docs pages, READMEs: every example.
- One release of cli-messaging, then tg, max and memo the same day — the week's breaking change,
  listed under "may break scripts".

## 4. Work items

1. cli-messaging: `search` group and leaves over the existing services, `search all` merge, MCP tools,
   permission and saved-search migrations; old leaves removed.
2. tg, max, memo: adopt; regenerate docs; update skills.
3. cli-docs: pages and examples.

## 5. Tests

- Every old path fails with "unknown command" (no alias); every new one answers as the old did.
- `search all` returns a message, a mail and a note for a term all three contain, each typed.
- `search messages` returns no mail; `search mail` no messenger messages.
- A saved search made with an old path still runs after the migration.

## 6. Rulings

- **Type is an option** (owner, 2026-10-08): `search notes budget --type internal`, as `tasks --type`;
  for notes `internal|file`, for messages `text|voice|file`.
- **Mail is its own resource** (owner, 2026-10-08): `search mail`; `search messages` is messenger
  messages only.
