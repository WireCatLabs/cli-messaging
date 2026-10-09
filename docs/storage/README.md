# Storage and search

The message store (SQLite through Drizzle, an async API) and local search over it. How the store is
built today is in [ARCHITECTURE, "The store"](../dev/ARCHITECTURE.md#the-store).

| File | Answers |
|---|---|
| [`requirements.md`](requirements.md) | what the owner asked for, verbatim |
| [`decisions.md`](decisions.md) | the storage rulings in force |
| [`search-indexes.md`](search-indexes.md) | how search works: the word indexes, search by meaning — chunks, vectors, the scan, the merge with words |
| [`../../bench/search/`](../../bench/search/) | the benchmark fixture and its results |

Search AI configuration and opt-in analysis: [`../search/ai-providers.md`](../search/ai-providers.md).
