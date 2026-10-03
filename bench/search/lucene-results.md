# Lucene A1 — final indexed search benchmark

Synthetic corpus from existing bench/search generator and store loader.


### Lucene A1 node v24.19.0, 100,000 messages

Executor SHA-256 db818b4a6e8923e079cb79c0ea099e8f4606dbd7787497ae10f7d564d7cb8fb2; measured 2026-10-03T10:25:46.329Z.

20 repeated requests; first request uses a new process but SQLite/OS pages may be warm after fill. Source all; result limit 20. RSS includes fill.

| Query | first ms | warm p50 ms | warm p95 ms | hits |
|---|---|---|---|---|
| exact | 34.65 | 2.27 | 4.87 | 20 |
| implicit AND | 4.64 | 1.77 | 2.19 | 17 |
| OR | 9.23 | 2.15 | 2.72 | 20 |
| NOT | 2.04 | 1.90 | 2.29 | 20 |
| phrase | 16.54 | 2.87 | 3.57 | 20 |
| term regex | 3.70 | 1.92 | 2.42 | 20 |
| scoped body regex | 11.55 | 6.49 | 8.53 | 0 |

RSS 143 MiB; no live messages or accounts used.


EXPLAIN exact query:

```json
[
  {
    "id": 11,
    "parent": 0,
    "notused": 156,
    "detail": "SCAN f VIRTUAL TABLE INDEX 0:rM2"
  },
  {
    "id": 17,
    "parent": 0,
    "notused": 45,
    "detail": "SEARCH m USING INTEGER PRIMARY KEY (rowid=?)"
  },
  {
    "id": 25,
    "parent": 0,
    "notused": 0,
    "detail": "LIST SUBQUERY 1"
  },
  {
    "id": 28,
    "parent": 25,
    "notused": 156,
    "detail": "SCAN message_words VIRTUAL TABLE INDEX 0:M2"
  },
  {
    "id": 37,
    "parent": 25,
    "notused": 0,
    "detail": "CREATE BLOOM FILTER"
  },
  {
    "id": 45,
    "parent": 0,
    "notused": 45,
    "detail": "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)"
  },
  {
    "id": 50,
    "parent": 0,
    "notused": 45,
    "detail": "SEARCH ac USING INTEGER PRIMARY KEY (rowid=?)"
  },
  {
    "id": 80,
    "parent": 0,
    "notused": 0,
    "detail": "USE TEMP B-TREE FOR ORDER BY"
  }
]
```



### Lucene A1 node v24.19.0, 1,000,000 messages

Executor SHA-256 db818b4a6e8923e079cb79c0ea099e8f4606dbd7787497ae10f7d564d7cb8fb2; measured 2026-10-03T10:25:46.932Z.

20 repeated requests; first request uses a new process but SQLite/OS pages may be warm after fill. Source all; result limit 20. RSS includes fill.

| Query | first ms | warm p50 ms | warm p95 ms | hits |
|---|---|---|---|---|
| exact | 238.76 | 4.38 | 7.94 | 20 |
| implicit AND | 29.07 | 3.67 | 4.11 | 20 |
| OR | 182.52 | 6.42 | 7.17 | 20 |
| NOT | 4.09 | 4.39 | 5.02 | 20 |
| phrase | 156.04 | 12.48 | 13.26 | 20 |
| term regex | 6.02 | 4.16 | 4.83 | 20 |
| scoped body regex | 77.95 | 43.58 | 62.55 | 0 |

RSS 274 MiB; no live messages or accounts used.


EXPLAIN exact query:

```json
[
  {
    "id": 11,
    "parent": 0,
    "notused": 156,
    "detail": "SCAN f VIRTUAL TABLE INDEX 0:rM2"
  },
  {
    "id": 17,
    "parent": 0,
    "notused": 45,
    "detail": "SEARCH m USING INTEGER PRIMARY KEY (rowid=?)"
  },
  {
    "id": 25,
    "parent": 0,
    "notused": 0,
    "detail": "LIST SUBQUERY 1"
  },
  {
    "id": 28,
    "parent": 25,
    "notused": 156,
    "detail": "SCAN message_words VIRTUAL TABLE INDEX 0:M2"
  },
  {
    "id": 37,
    "parent": 25,
    "notused": 0,
    "detail": "CREATE BLOOM FILTER"
  },
  {
    "id": 45,
    "parent": 0,
    "notused": 45,
    "detail": "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)"
  },
  {
    "id": 50,
    "parent": 0,
    "notused": 45,
    "detail": "SEARCH ac USING INTEGER PRIMARY KEY (rowid=?)"
  },
  {
    "id": 80,
    "parent": 0,
    "notused": 0,
    "detail": "USE TEMP B-TREE FOR ORDER BY"
  }
]
```

