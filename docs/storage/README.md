# Storage and search

The message store (SQLite through Drizzle, an async API) and local search over it. How the store is
built today is in [ARCHITECTURE, "The store"](../dev/ARCHITECTURE.md#the-store).

| File | Answers |
|---|---|
| [`requirements.md`](requirements.md) | what the owner asked for, verbatim |
| [`decisions.md`](decisions.md) | the storage rulings in force |
| [`schema-v2.md`](schema-v2.md) | every table and column of the v2 store, and what each one means |
| [`search-indexes.md`](search-indexes.md) | how search works: the word indexes, search by meaning — chunks, vectors, the scan, the merge with words |
| [`../../bench/search/`](../../bench/search/) | the benchmark fixture and its results |

Search AI configuration and opt-in analysis: [`../search/ai-providers.md`](../search/ai-providers.md).

`schema-v2.md` is the store v2 plan's schema page, rendered from the plan's spec, with its first paragraph
replaced. After a spec change, copy the page again over everything below that paragraph; the schema test
fails until the code and the page agree.
