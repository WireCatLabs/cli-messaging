# Scoring the conversation rules

Phase 3 item 6 ([plan](../../docs/storage/plans/phase-3.md)). Two checks of `linkMessages`
(`src/conversations/link.ts`):

- **`run.sh`** — the hand-labelled IRC corpus of Kummerfeld et al., "A Large-Scale Corpus for
  Conversation Disentanglement", ACL 2019 ([repository](https://github.com/jkkummerfeld/irc-disentanglement),
  data CC BY 4.0, tools ISC). It clones the corpus into `DISENTANGLE_DATA`, a directory outside this
  repository, converts each file into our messages, and scores the answers with the corpus's own
  `graph-eval.py` and `conversation-eval.py`.
- **`holdout.ts`** — a real store: hides a share of the reply links, runs the rules, and counts how many
  come back. Prints counts per chat key only.

```sh
DISENTANGLE_DATA=~/data/irc-disentanglement ./run.sh test      # or dev
node --experimental-strip-types holdout.ts <messages.db> 0.2 200
```

Needs `git`, Node 24, `python3` and `uv` (the conversation scorer runs on Python 3.10 with
`ortools<9.4`, which still has `pywrapgraph`, and scikit-learn).

## Results, 2026-09-30, rules version 1

IRC test set (10 files, 5,000 annotated messages). Link P/R/F over (message, parent); conversation
metrics from `conversation-eval.py`.

| variant | link P / R / F | 1 − scaled VI | one-to-one | exact-match F |
|---|---|---|---|---|
| previous message (joins and quits start their own) | 34.1 / 32.8 / 33.4 | 72.4 | 37.4 | 0.3 |
| mention only | 39.2 / 37.7 / 38.4 | 73.2 | 33.8 | 4.4 |
| same sender only | 36.7 / 35.4 / 36.0 | 73.5 | 32.1 | 4.0 |
| **rules (both)** | **54.4 / 52.5 / 53.4** | **80.2** | **48.0** | **9.3** |
| rules, else previous message | 48.9 / 47.2 / 48.0 | 72.9 | 36.8 | 0.0 |

Dev set: previous 28.8, rules 52.4 link F; one-to-one 34.6 and 51.2.

For scale, from the paper: its "previous message" baseline 35.0 link F (ours 33.4 — close, not
identical); its trained model 72.3 link F and 36.2 exact-match F; two human annotators 49.5 exact-match F.

What this says:

- Both rules beat the baseline, and together they add up: 53.4 against 38.4 and 36.0 alone.
- Linking to the previous message when no rule fires makes everything worse. The rules stay without it.
- Exact-match conversations stay low (9.3): every message with no rule link starts its own
  conversation. Closing that gap is the agent's work in phase 4.
- IRC has no reply button, so the messenger's replies — our strongest link — are not tested here.

**Held-out replies on a Telegram archive** (a development copy; a public group of 5,000 messages and a
group of 270; 20% of reply links hidden, seed 42): the rules found 2 of 397 and 0 of 11 hidden
replies; 31 and 2 got a wrong parent, the rest none. The cause: the store holds **no username for any
Telegram sender** (0 of 1,535 identities), so the mention rule never fires, although 12% of the large
group's messages contain an `@name`. The same-sender rule fires, but links a person to their own
previous message, which is rarely the one they replied to.
