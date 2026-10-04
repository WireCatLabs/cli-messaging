# Stemmed search — word forms in strict message search

Plan, 2026-10-04 (TASK-359). **Not approved yet.** Read at cli-messaging `8bd52da` (`origin/main`). Owner rulings
taken as given, not reopened: stems live in a **separate index** (no query expansion); stemming is **on by default**
for plain words, with an exact mode; server search (`--backend live|archive|both`) is a later, separate plan.

Evidence labels, as in [`../storage/plans/phase-2.md`](../storage/plans/phase-2.md): **verified** has a `path:line`
at `8bd52da`; **measured** is a run of the stemming benchmark (branch `bench/stemming-vs-trigrams`, PR #504,
`bench/stemming/results.md`); **docs say** names the source; **inferred** is reasoning.

## 1. Goal

`messages search` and `messages stats` (CLI and MCP, tg and MAX alike) find `квартиру` for `квартира` and
`canciones` for `canción`, ranked by relevance, with exact matches first, and say in the answer that stems were
used. The exact behaviour of today stays one keystroke away. Legacy discovery (`--language legacy`) is unchanged.

Why: measured on human-lemmatized treebanks, today's strict term finds 0.260 of the relevant Russian messages
and 0.391 of the Spanish ones; Snowball stems find 0.881 / 0.956 at precision 0.839 / 0.693 (exact: 0.992 / 0.870).

## 2. Current state

| What | Where | Label |
|---|---|---|
| Normalizer: NFKD → strip marks → NFC → lowercase; folds ё→е, й→и, accents | `src/store/normalize.ts:9-17` | verified |
| `message_words`: contentless FTS5 (`contentless_delete = 1`), columns `normalized_text, scope`, `unicode61 remove_diacritics 2`, `prefix = '3'`, filled by **SQL triggers** | `drizzle/20261001110736_version-12-word-index/migration.sql` | verified |
| `scope` = `c<chat_pk> s<sender_pk>`; small chat/sender filtered inside the index (`SCOPE_TOKEN_LIMIT` 100k), bm25 with the scope column at weight 0 | `src/store/sqlite/words.ts:34-36` | verified |
| Readiness: one row `message_words` in `search_index_state`, `ready = filled_through ≥ watermark && no pending normalization`; `INDEX` is hard-coded | `src/store/sqlite/search-index.ts:5,26-45` | verified |
| Fill: `store migrate`, `store reindex` (`resetSearchIndex`), ≤5000 rows on open, 200 ms before each search/stats | `src/cli/messenger/store-maintenance-command.ts:312-355`, `src/store/store.ts:462-476`, `src/services/messages.ts:118-121` | verified |
| Strict search refuses text queries with `index_not_ready` while the index is not ready | `src/services/messages-search.ts:136-140` | verified |
| Lucene compile: `text` term **and** phrase → one quoted FTS5 phrase on `message_words`; wildcard/regex expand over `message_words_vocab`; `body` raw; ranking joins **one** FTS table as `f` with `bm25(1.0, 0.0)` | `src/store/sqlite/lucene.ts:402-407,473-496,342-356` | verified |
| A quoted token is always `operator: "phrase"`, also a single quoted word; default field `text` | `src/search/lucene/parser.ts:241,254` | verified |
| Docs promise: term = «точное совпадение анализированного текста; без автоматического prefix»; phrase = «последовательность анализированных слов»; «нулевой результат не заменяется похожими словами» | `docs/search/query-language.md` (operators table, «Миграция legacy») | verified |
| `FIELD_VERSION = 1`; fields table and operators table are generated from the registry | `src/search/lucene/registry.ts:12-35` | verified |
| Driver surface is `exec / prepare / close` — no user-defined SQL functions; node:sqlite and bun:sqlite | `src/store/driver.ts:17-29` | verified |
| An **older** tg/max keeps writing to a file a newer one migrated, unless `minCompatible` rises | `src/store/migrations.ts:17,306` | verified |
| Next free migration number is **15** (no open PR claims it) | `docs/plans/2026-09-29-parity-lanes.md:77`; `gh pr list` 2026-10-04 | verified |
| Open PRs touching the envelope: #505 (real `wordsReady`/coverage in Lucene), #508 (same in legacy) | GitHub | verified |

## 3. Decisions made here

### S1. Schema — migration 15

```sql
CREATE VIRTUAL TABLE message_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');      -- no prefix index: wildcards never read stems
CREATE TABLE message_stems_pending (pk INTEGER PRIMARY KEY);   -- messages whose stems are stale
-- triggers, pure SQL, so any binary (also an older one) keeps the index honest:
--   AFTER INSERT ON messages                          → INSERT OR IGNORE INTO message_stems_pending
--   AFTER UPDATE OF text, chat_pk, sender_identity_pk → same, WHEN something really changed
--   AFTER DELETE ON messages                          → DELETE FROM message_stems WHERE rowid = old.pk
--                                                       and from message_stems_pending
ALTER TABLE search_index_state ADD COLUMN stemmer_version INTEGER;
INSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, stemmer_version)
  SELECT 'message_stems', coalesce(max(pk), 0), 0, 0, 1, 1 FROM messages;
```

- Same shape as `message_words`: contentless with delete, `scope` column with the same tokens, so
  `SCOPE_TOKEN_LIMIT` and `bm25(1.0, 0.0)` carry over unchanged.
- **Positions kept** (`detail=full`, the default): `text:"оплатил счёт"` is a phrase over stems.
- **Source is `messages.text`, not `normalized_text`** — stems are taken before folding (§S5).
- A trigger cannot stem: the driver has no UDF, and a UDF in a trigger would break every older writer
  (`migrations.ts:17`). Hence the queue. `minCompatible` stays unchanged.
- The migration cannot fill small files in-transaction like version 12 did — SQL has no stemmer. Every
  file starts not ready; JS fills it (§S2).

### S2. When stems are written

| Event | Who writes | How |
|---|---|---|
| Ingest / edit (any binary) | trigger | pk into `message_stems_pending` |
| Ingest / edit (this version) | store write path | drain the pending pks of the write transaction before `COMMIT` (`upsertMessage` callers) |
| Delete / tombstone row deletion | trigger | `DELETE FROM message_stems WHERE rowid = old.pk` |
| Existing archive (backfill) | `fillStems` | batches of 5,000 pks ≤ watermark, each its own `BEGIN IMMEDIATE`, `filled_through` advances; resumable |
| Small file (≤ `BACKFILL_ON_OPEN`) | `openStore` | fill on open, as normalization is today |
| Large file | `store migrate` (progress notes: `stemming up to message N`, `k of n stemmed`) and the 200 ms fill before each search/stats | |
| `store reindex` | `resetSearchIndex` | also `delete-all` on `message_stems`, empties the queue, `filled_through = 0` |
| Stemmer or normalizer version changes | fill | row's version ≠ code's → reset stems row, refill (same as reindex, stems only) |

**Readiness:** `ready = filled_through ≥ watermark && pending queue empty && stemmer_version = STEMMER_VERSION`.
`searchIndexState` takes the row name instead of the hard-coded `INDEX`.

**While not ready** (no silent fallback to exact): a query with a stemmed `text` leaf throws
`validation_error`, `reason: "index_not_ready"`, plus `index: "message_stems"`, `done`, `total`, and the
message «stems are N% built — run `<cli> store migrate`, or search exact forms with `--exact`». A query
with only `exact:`, `body` or metadata leaves runs as today. The 200 ms fill runs first, so a few
freshly ingested rows never block a search.

### S3. Stem cache

`Map<string, string>` from lowercased NFC token → stored stem, per fill run and per write drain,
cleared when it passes 200,000 entries (1M messages hold 523k distinct words — measured). No
persistence, no LRU. Expected to remove most of the 93 s of Snowball time at 1M (**inferred**; the
gate measures it, §S12).

### S4. Vendoring Snowball

| Item | Decision |
|---|---|
| What | Official Snowball **3.1.1** generated JavaScript: `base-stemmer.js`, `russian-stemmer.js`, `spanish-stemmer.js`, generated at snowballstem/snowball `cd195b51` |
| Where | `src/search/snowball/` (generated, never edited) + `LICENSE` (BSD-3-Clause, from the Snowball repo) + a `.d.ts` |
| Not | `snowball-stemmers` (112 ё mismatches, last release 2016), `natural` (569 mismatches) — measured |
| Lint / coverage | excluded from Biome and from the coverage floor; the wrapper `src/search/stem.ts` is covered |
| Package | shipped in `dist/`, licence in the `files` list; runs on node and Bun (plain ESM, no native code) |
| Update | `bin/snowball-update <sha>`: clone, `make`, generate RU/ES, copy, print the diff; then bump `STEMMER_VERSION` |
| Check | a test runs the stemmers over a committed 2,000-word sample of snowball-data `a0ec0d0` `voc.txt → output.txt` per language (0 mismatches); the update script runs the full lists |

### S5. Analyzer — one function for index and query

`stemTokens(text)` in `src/search/stem.ts`, shared by the fill, the write drain and the query compiler:

1. `text.normalize("NFC").toLowerCase()`
2. split as `unicode61` does (letters, digits, `Co`, marks kept in the token) — parity with `fts5vocab` is a test
3. per token, choose by script of **all** its letters:

| Token | Stemmer | Example |
|---|---|---|
| only Cyrillic letters | Russian | `квартиру` → `квартир` |
| only Latin letters | Spanish | `canciones` → `cancion` |
| mixed scripts (homoglyphs, `Москвa`), any digit (`covid19`), other scripts | none — the token itself | |
| stem would be empty | none — the token itself | |

4. `normalize()` of the result (stem **then** fold). Folding first cost Russian recall 0.881 → 0.785 (measured).

Russian Snowball folds ё itself; й is folded by `normalize` after stemming. English is stemmed as
Spanish (Latin script): F1 still rises 0.596 → 0.711 over exact, false merges 2.7% → 6.5% (measured).
Language detection is out of scope.

### S6. Fields and exact-mode syntax

| Input | Field / operator in the AST | Index |
|---|---|---|
| `квартира` | `text` term | stems (∪ words, §S8) |
| `"квартира"`, `"оплатил счёт"` (bare quotes) | **`exact`** phrase | words — today's behaviour |
| `text:"оплатил счёт"` | `text` phrase | stems, adjacency kept |
| `exact:квартира`, `exact:"…"`, `exact:кварт*`, `exact:/…/` | `exact` | words |
| `text:invo*`, `text:/pass(port)?/` | `text` wildcard / regex | words vocabulary — patterns never stem |
| `body:…` | `body` | unchanged |
| `--exact` (CLI) / `exact: true` (MCP) | default field becomes `exact` | words |

Why **bare quotes = exact**:

- Lucene analyzes quoted text with the field's analyzer, so a pure Lucene profile would stem phrases too.
  Elasticsearch, the Lucene product people meet, ships the opt-in `quote_field_suffix` for exactly this
  case: «words that appear in between quotes are redirected to a different field», the unstemmed one
  (docs say: [Mixing exact search with stemming](https://www.elastic.co/guide/en/elasticsearch/reference/current/mixing-exact-search-with-stemming.html)).
  Our profile turns that option on. It stays a Lucene-family behaviour, written down as a profile setting.
- Every quoted query a caller sends today keeps its exact result set; only bare words grow. Least breakage.
- Quotes already mean «literally this» to most people (web search) and to our own recipes (`"example.org"`).
- A stemmed phrase is still available as `text:"…"`; the rewrite applies only when the field is implicit,
  so the parser marks it in the AST as `exact` — the AST never depends on how the text was typed.

The owner may prefer the pure Lucene reading — §9 Q1.

### S7. Query compile (`lucene.ts`)

| Leaf | Today | After |
|---|---|---|
| `text` term / phrase | `message_words MATCH "w"` | `message_words MATCH "w"` **OR** `message_stems MATCH "stem(w)"` (phrase: stems in order) |
| `text` wildcard / regex | vocab expansion over `message_words_vocab` | unchanged |
| `exact` (all four operators) | — | today's `text` compile, unchanged |
| `body`, metadata fields | | unchanged |
| `mustNot` on a `text` leaf | excludes exact form | excludes every form (stem) — `-квартира` drops `квартиру` too |

`hasText` splits into "needs stems" / "needs words" for the two readiness checks. `messages stats` uses the
same compile, so its counts grow with the result sets.

### S8. Ranking

- **Invariant: stemmed results ⊇ exact results.** Folding after stemming can give two spellings that
  fold the same word different stems (й cases); the `OR` with the words index in §S7 keeps every exact
  hit. Tested on the treebanks (0 exact hits missing).
- Rank table `f` = `message_stems` when any required leaf is stemmed, `message_words` otherwise.
  Exact-field leaves enter the rank expression as their stems (a superset, so the rank never drops a row;
  the leaf fragments still filter exactly).
- Order: **exact tier first** — `(m.pk IN (SELECT rowid FROM message_words WHERE message_words MATCH ?))
  DESC` over the required text leaves in their exact form — then `f.rank` (bm25 over stems), then the
  existing tie-breakers. `--newest` ignores both, as today.
- The Boolean set never depends on ranking (docs promise).

### S9. Response transparency

Additive, in the existing envelope (rebased on #505/#508):

```jsonc
"stemsReady": true,                       // beside wordsReady, same meaning for message_stems
"query": { …,
  "stemming": { "applied": true, "stemmer": "snowball-3.1.1",
                "terms": [{ "word": "квартира", "stem": "квартир", "language": "ru" },
                          { "word": "invoice", "stem": "invoic", "language": "es" }] } },
"items": [{ …, "exact": false }]          // the hit matched only through a stem
```

CLI pretty output adds one stderr note when stems were used: «also found other forms: квартира → квартир* (ru)».

### S10. Parity and the MCP contract

- All code in cli-messaging; no messenger knowledge. tg and MAX get it through the pinned release only.
- `--exact` goes into `parity.json` first (one meaning everywhere), `STANDARD.md` option catalogue regenerated;
  both `messages search` and `messages stats` take it. MCP: `exact` boolean on `<cli>_messages_search` and
  `_stats` (snake_case rule, STANDARD «MCP» 2).
- AST: new field value `exact`, `version: 1` unchanged (additive). An AST with `field: "text"` from an
  existing MCP caller now stems — named in the changelog.
- `FIELD_VERSION` 1 → 2; MCP description string mentions stemming, exact quotes and `exact:`.

### S11. Docs and changelog

- `docs/search/query-language.md`: operators/fields tables (generated: new `exact` row, `text` normalization
  «Snowball 3.1.1 ru/es by script, then v1»), a section «Формы слов» with the limits below, «Миграция legacy»
  row for exact, the not-ready message. Recipes (`recipes.json`, run by tests): `квартира` finds `квартиру`;
  `"квартира"` does not.
- `query-language-spec.md`: the line «Analyzer reference: Whitespace для text» → stems.
- Documented limits (**known false merges**, measured): `часть/часто` (`част`), `потому/потом` (`пот`),
  `caso/casa` (`cas`), `partido/parte` (`part`), `plazo/plaza` (`plaz`); English via the Spanish stemmer
  (`car/care`). The way out is `"…"` or `--exact`.
- `CHANGELOG.md`, «Changed — may break callers»: bare words now match other forms, result sets and `stats`
  counts grow, order changes (exact first); `text` in an MCP AST stems; quoted text keeps today's sets;
  `store migrate` builds a new index (time, +disk); strict text search answers `index_not_ready` until it is built.

### S12. Benchmark gate (before the query flip)

Re-run at 1M **through the store code** (migration DDL with `scope` + `contentless_delete`, the cache, the
write drain, the exact-tier order, the messages join). The bench's 97 MB / 18.9 ms were index-only numbers.

| Metric | Bench (S) | Target |
|---|---|---|
| Stem fill, 1M, of which Snowball | 142 s / 93 s | ≤ 75 s / ≤ 25 s |
| Disk, `message_stems`, 1M | 97 MB (no scope, no delete) | ≤ 140 MB |
| Query p95, ~1% df word, 1M, page 20, exact-first | 18.9 ms (index only) | ≤ 30 ms |
| Ingest of 5,000 messages, write drain on | — | ≤ +25 % vs off |
| RU SynTagRus recall / precision via store | 0.881 / 0.839 | within ± 0.02 |
| ES AnCora recall / precision via store | 0.956 / 0.693 | within ± 0.02 |
| Exact hits missing from stemmed results | — | 0 |

A miss stops the flip and comes back to the owner with the numbers.

## 4. What NOT to do

- No FTS5 `porter` tokenizer (English only, wraps the token stream, cannot choose by script).
- No stemming after folding (Russian recall −0.10, measured).
- No query-time expansion through the word vocabulary (it holds folded words only — owner ruling).
- No UDF in a trigger; no `minCompatible` bump.
- No union with trigram neighbours (S+T1 precision 0.52 / 0.40, measured); T1 stays for typos in legacy.
- No stems for wildcard/regex patterns, `body`, `filename`, `from`, `chat`.
- No silent fallback to exact while stems are not ready.
- No change to legacy discovery in this plan.

## 5. Work items — small PRs, in order

| # | PR | Content | Behaviour change |
|---|---|---|---|
| 0 | `docs(plans)` | this plan | none |
| 1 | `docs(plans)` | claim migration **15** in the lanes plan | none |
| 2 | `feat(search)` | vendored Snowball + `LICENSE` + `bin/snowball-update` + `stemTokens` + cache + unit tests (§7) | none |
| 3 | `feat(store)` | migration 15, queue triggers, `fillStems`, write drain, open/migrate/reindex, readiness by row name, `stemsReady` | `store migrate` builds stems; queries unchanged. After #505/#508 |
| 4 | `bench(search)` | gate (§S12) through the store; after #504 merges | none |
| 5 | `feat(search)!` | parser (implicit quotes → `exact`, `--exact`), compile §S7, ranking §S8, transparency §S9, MCP, `parity.json`, `FIELD_VERSION` 2, docs, changelog | **may break callers** — its own release, inside the once-a-week breaking budget |
| 6 | consumers | tg-cli and max-cli bump the exact pin; release notes say «run `store migrate`» | |

## 6. Tests

- **Unit, `stem.test.ts`:** RU `квартира/квартиру/квартиры → квартир`, `квартирант` stays apart; ё
  `ёлка/елка/ёлки → елк`; й `мой`, `йогурт` (stem then fold); ES `canción/canciones/cancion → cancion`,
  `año → ano`; script rules (mixed, digits, Greek, emoji); documented false merges `часть/часто`,
  `caso/casa` asserted **as merged** so a stemmer update that changes them is noticed; empty-stem guard.
- **Tokenizer parity:** JS tokens = `fts5vocab` terms on a fixture with punctuation, emoji, combining marks.
- **Store:** queue from inserts by a connection without the new code (raw SQL insert), edit changes stems,
  edit of reactions only does not enqueue, delete removes, reindex, version mismatch refills, readiness
  states, resumable fill.
- **Search (integration, real CLI and MCP on the synthetic fixture):** term finds forms; bare quotes and
  `--exact` do not; `text:"…"` stemmed phrase; `exact:` wildcard; `-квартира` excludes forms; exact hits
  ranked first; `index_not_ready` with progress for a stemmed query, exact-only query still runs; `stats`
  counts match `search`; tg and MAX command paths give the same answer.
- **Superset** test on the treebank subset in the gate.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Precision drop users see as noise (ES 0.870 → 0.693) | exact tier first; `"…"`/`--exact`; documented merges |
| First upgrade of a big archive: strict word search errors until stems are built | progress in the error and in `store migrate`; release note; small files fill on open |
| Older binaries write while a new one is not running → queue grows | readiness counts the queue; the next new-binary run drains it |
| Write drain slows ingest | measured in the gate; fallback: drain only in fill (queue still keeps it correct) |
| Snowball update changes stems silently | `STEMMER_VERSION` + refill; merge-fixture tests |
| Spanish stemmer on English | measured gain over exact; language detection is a later idea |
| Disk +~100 MB per 1M | gate target; named in the changelog |
| #505/#508 not merged → envelope conflicts | PR 3 waits for them |

## 8. Out of scope

Server/live search (`--backend`), language detection, an English stemmer, stems in legacy discovery,
lemmatization dictionaries, synonyms.

## 9. Questions for the owner

1. **Should bare quotes mean exact (`"квартира"` finds only `квартира`)?**
   A — yes, as Elasticsearch's `quote_field_suffix`; stemmed phrase via `text:"…"`; also `exact:` and `--exact`.
   B — pure Lucene: quotes are a stemmed phrase; exact only through `exact:` / `--exact`.
   **Recommended: A** — today's quoted queries keep their exact results, and quotes already read as «literally».
2. **Which stemmer for Latin-script words?** A — Spanish for all Latin (English included). B — no stemming for
   Latin. **Recommended: A** — measured English F1 still rises 0.596 → 0.711; B loses the Spanish gain (0.391 → 0.956).
3. **Exact matches ranked first, or pure bm25 over stems?** A — exact tier first. B — pure bm25.
   **Recommended: A** — the word typed is the likeliest intent; costs one extra index lookup, measured in the gate.
