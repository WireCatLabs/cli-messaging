# Lucene A1 — final indexed search benchmark

Synthetic corpus from existing bench/search generator and store loader.

### Lucene A1 node v24.19.0, 100,000 messages

Executor SHA-256 fda468398c10cfd8bd8efbdbd2bd492e4046ad9347d262461cfb523484eacc7a; measured 2026-10-03T11:33:49.536Z.

20 repeated requests; first request uses a new process but SQLite/OS pages may be warm after fill. Source all; result limit 20. RSS includes fill.

| Query | first ms | warm p50 ms | warm p95 ms | hits |
|---|---|---|---|---|
| exact | 90.38 | 2.98 | 4.26 | 20 |
| implicit AND | 10.51 | 1.97 | 2.43 | 17 |
| OR | 24.67 | 2.88 | 3.96 | 20 |
| NOT | 2.22 | 2.55 | 5.35 | 20 |
| phrase | 34.88 | 3.27 | 3.95 | 20 |
| term regex | 3.65 | 2.21 | 2.86 | 20 |
| scoped body regex | 18.64 | 6.61 | 9.66 | 0 |

RSS 166 MiB; no live messages or accounts used.


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

Executor SHA-256 fda468398c10cfd8bd8efbdbd2bd492e4046ad9347d262461cfb523484eacc7a; measured 2026-10-03T11:33:50.343Z.

20 repeated requests; first request uses a new process but SQLite/OS pages may be warm after fill. Source all; result limit 20. RSS includes fill.

| Query | first ms | warm p50 ms | warm p95 ms | hits |
|---|---|---|---|---|
| exact | 370.20 | 5.15 | 6.45 | 20 |
| implicit AND | 47.58 | 4.15 | 5.05 | 20 |
| OR | 292.46 | 8.19 | 15.84 | 20 |
| NOT | 5.01 | 4.92 | 5.55 | 20 |
| phrase | 237.10 | 14.01 | 19.50 | 20 |
| term regex | 6.92 | 5.20 | 6.07 | 20 |
| scoped body regex | 111.66 | 46.51 | 60.18 | 0 |

RSS 269 MiB; no live messages or accounts used.


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
