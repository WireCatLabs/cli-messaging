# Scoring the conversation rules

Phase 3 item 6 ([plan](../../docs/storage/plans/phase-3.md)). Two checks of `linkMessages`
(`src/conversations/link.ts`):

- **`run.sh`** — the hand-labelled IRC corpus of Kummerfeld et al., "A Large-Scale Corpus for
  Conversation Disentanglement", ACL 2019 ([repository](https://github.com/jkkummerfeld/irc-disentanglement),
  data CC BY 4.0, tools ISC). It clones the corpus into `DISENTANGLE_DATA`, a directory outside this
  repository, converts each file into our messages, and scores the answers with the corpus's own
  `graph-eval.py` and `conversation-eval.py`.
- **`sweep.ts`** — tunes the same-sender rule on the **dev** split only: its window in messages and
  minutes, and whether it or the mention rule wins. The test split is then scored once with `run.sh`.
- **`scale.ts`** — time and memory of the rules for one chat of N messages (phase 3 item 7): the first N
  rows of `bench/search`'s corpus as one chat, with invented replies (60%, parent within 50) and mentions
  (5%).
- **`agent.ts`** — phase 4 item 5 by hand: a real agent links the IRC dev split through the same service
  as `conversations batches next` and `links add`, then the result is scored against the rules alone.
- **`holdout.ts`** — a real store: hides a share of the reply links, runs the rules, and counts how many
  come back. Prints counts per chat key only.

```sh
DISENTANGLE_DATA=~/data/irc-disentanglement ./run.sh test      # or dev
DISENTANGLE_DATA=~/data/irc-disentanglement node --experimental-strip-types sweep.ts dev
node --experimental-strip-types holdout.ts <messages.db> 0.2 200
node --experimental-strip-types scale.ts 1000000    # corpus from bench/search/gen.ts 1000000 42
DISENTANGLE_DATA=~/data/irc-disentanglement node --experimental-strip-types agent.ts prepare dev   # after pnpm build
```

Needs `git`, Node 24, `python3` and `uv` (the conversation scorer runs on Python 3.10 with
`ortools<9.4`, which still has `pywrapgraph`, and scikit-learn).

## The user's agent, 2026-10-01

`agent.ts` on the dev split (10 files). Each file is loaded from line 900, so 100 lines of context come
before the 250 annotated ones. **Claude Sonnet 5.5**, one agent per file, was given
`skills/link-conversations/SKILL.md` and the bench script in place of the CLI. Batches of 50: 7 per
file, 3,500 answers, about 5,000 tokens of messages per file. The rules on the same input score as on
the whole file (link F 53.7).

| variant | link P / R / F | 1 − scaled VI | one-to-one | exact-match F |
|---|---|---|---|---|
| rules v2 | 54.8 / 52.6 / 53.7 | 85.5 | 64.0 | 13.6 |
| **rules + the agent's answers** | **78.0 / 74.8 / 76.3** | **95.9** | **88.6** | **53.7** |

What this says:

- The agent adds 22.6 points of link F, and exact-match conversations go from 13.6 to 53.7 — above the
  paper's trained model (72.3 link F, 36.2 exact-match F) and two human annotators (49.5 exact-match F).
  The paper's numbers are on the test split, these on dev, from one run of one model: an order of size, not a ranking.
- Six answers were refused for naming a parent outside the batch, 68–186 messages back. In all six the
  true parent was a few messages back, so the check refused wrong answers and cost nothing. 41 of the
  2,145 gold links (1.9%) reach further back than 50 messages; no batch can link those.
- Five `add` calls printed nothing. One was `EAGAIN`: the script read stdin with `readFileSync(0)`, which
  fails on a non-blocking pipe (fixed); one ran while the script was briefly moved away; the others' error
  was hidden by `2>/dev/null` in the agents' instructions. Each batch was sent again and stored once — 350
  rows per file, one per message.

## Scale, 2026-10-01

`scale.ts`, Node 24, one process per row. "Heap after" is what the result holds; peak RSS includes the
script holding all N input messages, which the store's build will read in batches instead.

| messages | rules | rate | links | conversations | heap after | peak RSS |
|---|---|---|---|---|---|---|
| 5,000 | 0.02 s | 245,852 msg/s | 3,418 | 1,835 | 3 MB | 99 MB |
| 100,000 | 0.17 s | 593,420 msg/s | 68,762 | 36,612 | 50 MB | 338 MB |
| 1,000,000 | 1.78 s | 561,832 msg/s | 688,812 | 364,976 | 285 MB | 1,426 MB |

The rules are far under the plan's one minute at 1M, so a chat is rebuilt whole (plan C3). Writing the
result to the store is measured once the store methods exist (item 2).

## Results, 2026-09-30

**Rules version 2** (same sender: within 10 messages and 5 minutes; a mention wins over it). Chosen on
the dev split with `sweep.ts`: link F 53.7 there against 52.4 for version 1 (3 messages, 2 minutes);
wider windows (20, 50 messages, 30 minutes) gained at most 0.1, and the mention rule winning was better
at every setting. Test scored once afterwards:

| variant | link P / R / F | 1 − scaled VI | one-to-one | exact-match F |
|---|---|---|---|---|
| previous message | 34.1 / 32.8 / 33.4 | 72.4 | 37.4 | 0.3 |
| same sender only (v2) | 40.0 / 38.5 / 39.2 | 79.8 | 44.6 | 5.8 |
| **rules v2** | **56.4 / 54.4 / 55.4** | **85.8** | **60.9** | **16.0** |

**Rules version 1** (same sender within 3 messages and 2 minutes), first run.
IRC test set (10 files, 5,000 annotated messages; dev: 10 files, 2,500). Link P/R/F over (message, parent); conversation
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
group of 270; 20% of reply links hidden, seed 42): version 1 found 2 of 397 and 0 of 11 hidden
replies (31 and 2 wrong); version 2 found 2 and 0 (51 and 4 wrong).

What is verified, and what is not:

- **Verified:** the store holds no username for any Telegram sender (0 of 1,535 identities), so the
  mention rule cannot fire on Telegram, although 12% of the large group's messages contain an `@name`.
- **Not measured:** whether usernames would change this result. These hidden messages are replies made
  with the button: a person who presses reply rarely also types the name, and a reply points at
  someone else's message, so a same-sender link is wrong there almost by definition.
- **Unknown:** how the rules do on the Telegram messages that have no reply link, which is where they
  matter. That needs a hand-labelled Telegram sample.
