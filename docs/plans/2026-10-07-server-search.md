# Server search beside the archive — `--backend archive|server|both`

Plan, 2026-10-07 (max-cli journal TASK-456, handoff [2026-10-07-server-search-handoff.md](2026-10-07-server-search-handoff.md)).
Read at cli-messaging `a1dedb5`, tg-cli `7b00153`, max-cli `adca306`. **§9 is open: the default stays `archive`
until the owner answers NEED-809.** Everything else below is decided here.

Evidence labels as in [the stemmed-search plan](2026-10-04-stemmed-search.md): **verified** has a `path:line`;
**docs say** names the source; **inferred** is reasoning.

## 0. What each messenger's server can search

| Question | Answer | Label · source |
|---|---|---|
| Telegram, one chat | `searchMessages({ chatId, query, fromUser, minDate, maxDate, threadId, limit })`; ≤ 100 per page | docs say: mtcute 0.32.3 `highlevel/methods/messages/search-messages.d.ts:11-93`; [TDLib searchChatMessages](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1search_chat_messages.html) |
| Telegram, every chat | `searchGlobal({ query, minDate, maxDate, limit, offset })`: private chats, groups and joined channels, not secret chats; no sender parameter; mtcute caps it near 10,000 | docs say: `search-global.d.ts:3-55`; [TDLib searchMessages](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1search_messages.html) |
| Telegram, what `q` matches | **Undocumented.** [messages.search](https://core.telegram.org/method/messages.search) says only "text search request". User reports say whole words, some prefix and English word-form matching; quotes and `-` are not operators | inferred; [bugs.telegram.org/c/724](https://bugs.telegram.org/c/724) is a user report |
| Telegram, paging | mtcute sets `next` on every non-empty page; `total` is the server's `count`, can be `inexact`. `hasMore` = `page.length === limit`, as `history()` does | verified: mtcute `iter-search-messages.js`; tg `src/telegram/adapter.ts:176-182` |
| Telegram, counting | `messages.search` with `limit: 0` returns the server's count, by the server's matching; `getSearchCounters` counts by message type only, no text | docs say: [messages.search](https://core.telegram.org/method/messages.search), [getSearchCounters](https://core.telegram.org/method/messages.getSearchCounters) |
| Telegram, flood waits | No published numbers. mtcute sleeps and retries any wait ≤ 10 s, up to 5 times, **inside one call**; the high-level search methods do not take `floodSleepThreshold` | verified: mtcute `network/middlewares/flood-waiter.js:14,26-38`; `network-manager.d.ts:108` |
| Telegram, topics | Without `threadId` the chat search covers every topic | docs say: TDLib searchChatMessages |
| MAX | Opcode 73 (`MSG_SEARCH`) is named in PyMax, tsmax (a port) and one community doc: per chat, `{chatId, query, count}`. **Nobody calls it**: no PyMax method, no output saved, not in our captures. Opcode 60 is probably a public-chat search | docs say: PyMax `53103f0` `src/pymax/protocol/enums.py:60-72`; [max-api-docs](https://github.com/pr0bel1230/max-api-docs) `protocol/messaging.md:946-1041`; verified absent: max-cli `docs_ai/captures/2026-09-25-*.jsonl` (FIND-906) |

**Conclusion.** Telegram gets the capability now. MAX stays archive-only until a probe on a test account
(NEED-810) shows opcode 73's real answer; an explicit `--backend server` on MAX is refused with a capability
error, and the default never is.

## 1. Goal

`messages search` asks the messenger's server and the local archive in one run, and answers one strict,
deduplicated, ranked list in which each hit says where it came from. The archive answer is never lost or
delayed without a bound because the server is slow, absent or refuses.

## 2. Current state

| What | Where | Label |
|---|---|---|
| Search = optional sync-first refresh, then the local search | `src/services/messages.ts:370-379` | verified |
| Sync-first: bounds, permission key `messages.sync-first`, `refreshed` block, stale coverage | `src/services/search-refresh.ts:10-23,53-143` | verified |
| CLI refuses sync-first on ask/readonly with `refuseLocalWrite` | `src/cli/messenger/search-sync-options.ts:30`, `src/cli/messenger/context.ts:276` | verified |
| MCP shows the sync arguments only when the key is `allow` | `src/mcp/server.ts:40`, `src/mcp/tool.ts:194,227` | verified |
| The only server search in the adapter: `historyFrom` (by sender) | `src/cli/messenger/port.ts:150-155`; tg `src/telegram/adapter.ts:327-333` | verified |
| `stored` saves only the reads it lists; any other method passes through unsaved | `src/cli/messenger/stored.ts:100-130` | verified |
| `saveMessages` does not touch ranges; only archive fetch calls `markRange` | `src/store/store.ts:704-711`, `src/services/archive.ts:321-323` | verified |
| An unknown chat becomes a row with `kind: "unknown"` | `src/store/sqlite/chats.ts:38-46` | verified |
| The contract already says remote search must refuse what it cannot do, or post-filter locally with visible coverage | `docs/search/query-language.md` «Машинный контракт и охват» | verified |

## 3. Decisions made here

### R1. Strict semantics: the server finds candidates, the store decides

The server's results are **candidates**. They are saved into the store, and the same strict local query then
runs once over the archive plus the fresh rows. One row per message makes deduplication free, and the ranking
stays the store's (exact forms first, then bm25 over stems). `exact:`, `-word`, phrases, `has:` and every other
field keep the meaning the docs promise.

Not chosen: merging two ranked lists (reciprocal rank fusion, as `conversations search` does,
`src/services/embeddings.ts:720`). It would show hits the strict query rejects, under rules nobody documents.

The cost, said in the docs: a server hit the local query rejects is not shown (it is still saved).

### R2. What goes to the server

Only what can narrow the candidates safely. Sending fewer words is safe, because the local query re-checks;
sending what the server reads differently is not.

| Query part | Sent as |
|---|---|
| Required words and phrases of `text`/`exact` (must clauses) | `query`, words joined by spaces |
| A top-level OR of word groups | one call per branch, at most `maxCalls` |
| `chat:` / `--chat`, one chat | `searchMessages` in that chat; otherwise `searchGlobal` |
| `from:` one person, with one chat | `fromUser`; without a chat it is not sent (global has no sender) |
| Date range | `minDate` / `maxDate` |
| Negations, wildcards, regex, `has:`, `tag:`, `kind:`, presets, `body:`, `filename:` | not sent: local filters only |

A query with no positive words skips the server (`server.skipped: "no_words"`). Other accounts in scope
(`in:`, `--source`) are archive-only; the server step uses only the active connection, as sync-first does.

### R3. Flag and default

- CLI: `--backend archive|server|both` on `messages search`, plus `--server-time <duration>`.
- MCP: `backend` and `server_time` on `messages_search`.
- **Default: `archive` until NEED-809 is answered; the owner asked for `both`.**
- `both` never throws because of the server. It falls back to the archive answer plus `server.skipped`:
  `offline` (`--offline`, MCP without a connection), `pushed_history` (MAX), `unsupported` (no capability),
  `not_allowed` (permission not `allow`), `no_words`, `other_accounts`.
- `server` is explicit: it refuses with the error that `both` turns into a skip (capability error, permission
  error, `--offline` conflict) and searches only the candidates the server returned.
- `archive` is today's behaviour, byte for byte.
- `--backend` and `--sync-first` combine: the refresh runs first, then the server step.

### R4. Permission and writes

- New key `messages.server-search`. The check for `both` is non-throwing (`levelFor`); `server` uses
  `refuseLocalWrite`, like sync-first. Read-only and `ask` profiles get the archive answer under `both`.
- MCP shows `backend: "server"` only when the key is `allow`; `both` on a profile without it answers
  from the archive with `server.skipped: "not_allowed"`.
  **Correction 2026-10-07 (implementation):** MCP offers `backend` wherever the messenger's server can
  search, at every level; the guard refuses `server` and turns `both` into `not_allowed`, the same check
  for CLI and MCP.
- Server hits are saved with `via: "search"`. They never call `markRange`, so ranges, `fetchedAt`,
  completeness and `store gaps` are unchanged (§2, verified). The stems queue and word index grow; the
  write drain already handles that.
- Nothing is marked read. Chats new to the store are saved first from the hits' chat facts, so they do not
  become `kind: "unknown"` rows.

### R5. Bounds, and what runs in parallel

- Defaults: **5 s** (`timeMs`, maximum 60 s), **100** messages per call, **3** calls (`maxCalls`).
  Sync-first's 30 s is right for a refresh someone asked for, too long for every search (NEED-809).
- **What is parallel:** the server calls run concurrently with the store preparation (index top-up,
  `prepareLucene`, resolving `chat:` and `from:`). The strict query runs **after** the save, because it
  must see the fresh rows. It is not two lists merged.
  **Correction 2026-10-07 (implementation):** the translation needs the resolved query, so `prepareLucene`
  runs before the calls; what runs in parallel is the server calls with each other (one per OR branch).
- **At the bound:** the in-flight call is abandoned, its result is **dropped, never saved**, and the answer is
  the archive's plus `server.complete: false`. Nothing writes after the answer, so a late reply cannot write
  into a closed store. The connection's close cancels the request.
- Flood waits: the tg adapter makes the call with `floodSleepThreshold` at or below the time bound (raw
  `client.call` if mtcute's high-level method does not pass it), so mtcute does not sleep past the bound.
  A refused flood wait is `server.failed: "rate_limited"`.

### R6. What the answer reports

```jsonc
"server": {
  "backend": "both",              // as asked
  "skipped": null,                // or offline | pushed_history | unsupported | not_allowed | no_words | other_accounts
  "calls": 2, "returned": 87, "new": 12,
  "failed": [{ "chat": null, "reason": "rate_limited" }],   // stable reasons, never provider text
  "complete": false               // false at a bound, a failure, or a page that had more
}
```

Each hit gains `source: "archive" | "server" | "both"`. Before saving, the step looks up which of the server's
`(chat, id)` keys the store already held: held → `both`, new → `server`, not returned by the server →
`archive`. `coverage` is unchanged: the server makes no claim about completeness. JSONL streams hits with
`source`; the `server` block goes to stderr, as `refreshed` does.

### R7. `stats messages show` stays archive-only

Telegram can count (`limit: 0`), but by its own undocumented matching, not by the strict query, and counting
the saved candidates is capped by the message bound. Either number would be wrong without saying so.
`stats` gets no `--backend`; the docs say why.

### R8. Saved searches

As with sync-first, a saved search does not save network consent: `searches create` refuses `--backend`, and
a saved run uses the default or the `--backend` typed on that run.

### R9. Adapter capability

```ts
/** A messenger whose server searches message text. Its matching is its own: the results are candidates. */
export interface MessageSearch {
  /** Newest first as the server answers; one chat when `chat` is set, every chat otherwise. */
  searchMessages(query: ServerQuery, window: { limit: number; signal: AbortSignal }): Promise<ServerFound>
}
export interface ServerQuery { text: string; chat?: string; from?: Id; minDate?: number; maxDate?: number }
export interface ServerFound { items: MessageHit[]; chats: Chat[]; hasMore: boolean }
```

Optional like `SenderSearch`. `stored` does **not** wrap it: the service saves, because it must look up
`source` before saving and must drop a late page (R5). tg maps with `toMessage`/`toMessageHit`
(`src/telegram/map.ts:157,288`) and sets `hasMore` from `page.length === limit`.

## 4. What NOT to do

- No raw server hits in the answer (R1). No server counts in `stats` (R7).
- No negations, wildcards or regex sent to the server (R2).
- No MAX opcode 73 until NEED-810's probe; no live probe on the owner's account.
- No change to `archive`'s answer, the coverage rules or the legacy chain.
- No store migration: `via` is a plain string (`src/store/store.ts:86`).

## 5. Work items — small PRs, in order

1. **This plan** and its claim in [the lanes plan](2026-09-29-parity-lanes.md#4-releases-while-lanes-run).
2. **Capability** — `MessageSearch` in `port.ts`, the fake adapter, `parity.json` entries `planned` for tg
   and `none` for max. tg PR: `searchMessages` on mtcute, flood threshold, mapping tests.
3. **Service step** — `src/services/server-search.ts`: query translation (R2), bounds and drop-late (R5),
   source lookup and save (R4, R6); `messages.search` runs it under `backend`. Default `archive`.
4. **Surfaces** — CLI `--backend`, `--server-time`; MCP `backend`, `server_time`; `searches create` refusal;
   permission key; recipes.
5. **Docs** — `docs/search/query-language.md` (server search, `source`, `server`), `docs/search/sync-first.md`,
   `docs/dev/ARCHITECTURE.md`; tg and max `docs/search.md` and changelogs; cli-docs
   `content/docs/search-architecture*.mdx` (also the stale «Word forms»), the parser bump to 0.168+.
6. **Default flip** to `both` — only after NEED-809; a "may break callers" changelog entry.

## 6. Tests

Fake adapter: translation table R2 (each row); OR branches capped; no-words skip; each `skipped` reason
under `both` and each refusal under `server`; time bound drops the late page and writes nothing; `source`
for held/new/archive-only hits; a server hit the strict query rejects is saved but not shown; `exact:` and
`-word` unchanged with server candidates; ranges and completeness unchanged after a save; MCP hides
`backend` without `allow`; JSON purity; `archive` output identical to today's. tg: mapping and `hasMore`.

## 7. Risks

- Telegram's matching is unknown (§0): recall from the server is "whatever it returns". The local re-check
  keeps precision; probes (NEED-811) only improve the docs.
- Flood waits on every search once `both` is the default. Mitigated by 3 calls, 5 s and the threshold.
- Saved candidates make a chat look partly held in `messages list --offline`. Same as `messages context`
  today, which also saves scattered messages.

## 8. Out of scope

MAX server search (after NEED-810), server search in `conversations search` and bots, server counts,
`channels.searchPosts` (public channels not joined; paid quota).

## 9. Questions for the owner

1. **NEED-809 · Should every `messages search` ask Telegram's server too (`--backend both` by default),
   with a 5 s limit and the permission on by default?** "Both" means a network call and a store write on
   each search, MCP included, and a flood-limit risk. A: yes, as R3–R5 · B: `both` by default only in the CLI,
   MCP stays `archive` · C: keep `archive` as default.
   Recommended: **B** — an agent over MCP searches often and in bursts, the shortest way to flood waits.
2. **NEED-810 · Which test account may receive the MAX opcode-73 probe?** Without one, MAX stays
   archive-only.
3. **NEED-811 · Which Telegram test account may receive the four matching probes** (prefix `прив`, word form
   `книгу`, quotes, minus)? Not blocking: they decide what the docs say about server recall.
