# How search finds a message — the indexes and what each one is for

Written for the owner on 2026-09-30, who asked how the indexes work and when one finds what another
does not. The rulings behind it are in [`decisions.md`](decisions.md): SQLite FTS5, BM25 over words,
typo correction through the vocabulary, and the substring index kept as a fallback (NEED-379 A). These
indexes arrive in phase 2; phase 1 does not change search.

## The five kinds of index

1. **Filter indexes** — ordinary B-tree indexes: by chat and time, by sender, by account. They make
   `--chat`, `--from`, `--after`, `--before` fast. Always there.
2. **The word index, ranked by BM25** — FTS5 with the `unicode61` tokenizer over `normalized_text`,
   with a prefix index.
3. **The vocabulary** — every distinct word of the word index, with its three-letter pieces; only for
   typo correction.
4. **The substring index** — FTS5 with the `trigram` tokenizer over message text: any three letters
   anywhere. It exists today (migration 5).
5. **Name indexes** — small trigram indexes over chat titles and over people's names and usernames.
   Not over messages.

## 2 · The word index

It works like the index at the back of a book. Each message is normalized — lowercase, accents
removed, ё turned into е — then split into words at spaces and punctuation, and for every word the
index keeps the list of messages that contain it:

```text
gestor    → message 1
valencia  → message 1
tie       → message 4
ptsarev   → message 5      (calendly.com/ptsarev splits into calendly, com, ptsarev)
99812     → message 2      (ab-99812 splits into ab, 99812)
ab45217   → message 2      (no separator: one word)
```

A search for «gestor valencia» looks both lists up and keeps the messages in both. Word beginnings
work too: «квартир» finds квартиру, квартиры.

**BM25** orders what was found. For each message it adds up, per search word:

- **how rare the word is** across all messages — «ptsarev» is in few, «en» in almost all, so a match
  on «ptsarev» counts far more;
- **how often the word occurs in this message**;
- **how short the message is** — a short message with the word ranks above a long one where it is
  lost.

No AI; 1–25 ms at 1M messages ([benchmark](research/2026-09-29-search-benchmark.md)).

## 3 · The vocabulary

A table of every distinct word in the messages — 38 for the six messages below, 143,501 at 100k
messages (measured). Each word also has its three-letter pieces, indexed, so a typo can be looked up
fast:

```text
valencia → val ale len enc nci cia
whatsapp → wha hat ats tsa sap app
```

A search for «Valenca»:

1. Is «valenca» in the vocabulary? No.
2. Its pieces are `val ale len enc nca`. Which known words share several? valencia (4 shared), and
   others.
3. Keep those at most 2 edits away (an edit adds, removes, changes or swaps one letter). valencia is 1.
4. Search the word index for «valencia».

The vocabulary never searches messages itself; it only turns a typo into a real word.

## 4 · The substring index

It keeps every three-letter piece of every message, so it finds any three or more letters anywhere,
including inside a word. It cannot find fewer than three letters, and ranking over letter pieces is
weak.

## 5 · Name indexes

Answer "which chat or person did you mean": `--chat expats` finds «Valencia Expats», `--from ptsa`
finds «@ptsarev_v»; `contacts search` uses them. Small, and they exist today.

## Scenarios — measured

Run on 2026-09-30 in `node:sqlite` (Node 24) with both FTS5 tokenizers over six messages:

1. «¿Alguien conoce un buen gestor en València?»
2. «Order AB45217 arrived, tracking ab-99812»
3. «Сдаю квартиру в центре, пишите в whatsapp»
4. «Tiempo de espera para la TIE: dos meses»
5. «My calendly.com/ptsarev link for the TV setup»
6. «Entiendo, gracias»

| Search | Word index (2) | Substring index (4) | Who finds it |
|---|---|---|---|
| gestor valencia | 1 | 1 | both; words rank better |
| Valenca (typo) | — | — | **neither — only the vocabulary (3)** corrects it to valencia |
| whatsap (a letter missing) | — | 3 | **substring**; the vocabulary corrects it too |
| квартир (start of a word) | 3 | 3 | both |
| len (middle of a word) | — | 1, 5 (valencia, calendly) | **substring**, with noise |
| 45217 (inside «AB45217») | — | 2 | **substring** |
| 99812 (after a hyphen) | 2 | 2 | both |
| sarev (part of «ptsarev») | — | 5 | **substring** |
| tie | 4 | 4, **6** («en**tie**ndo») | **words**; substring adds noise |
| tv (two letters) | 5 | — | **words**; substring needs three letters |

So: **words with BM25** rank best, bring no noise and handle short words; **the vocabulary** fixes
typos neither index finds alone; **substring** finds fragments — parts of numbers, links, names, the
middle of words — and brings noise.

## The order a search runs in — proposed; the phase 2 plan settles it

1. Word index, every word required, ranked by BM25.
2. Nothing found → correct unknown words through the vocabulary, search again.
3. Still nothing → any word instead of every word (NEED-375).
4. Still nothing → the substring index.

Filters (chat, sender, source, date) apply at every step, in the database.
