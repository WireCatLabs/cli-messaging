# Conversation disentanglement for group chats — research, 2026-09-30

Scope: split an interleaved group-chat stream (Telegram, MAX) into conversations, then chunk and embed.
Labels: **paper** (title, year, table), **code** (repo, file), **inferred** (my reasoning, not checked).
Numbers appear only with their source. A number I read only through a web summary is marked **unverified**.

## 1. What matters for us

1. **Humans agree on only about half of whole conversations.** On the Ubuntu IRC test set, two annotators
   reach link κ 0.74, 1-1 83.8, and exact-match conversation F1 49.5.
   **paper** Kummerfeld et al., "A Large-Scale Corpus for Conversation Disentanglement", ACL 2019, Table 2.
   So chunking must tolerate wrong splits. A "perfect" conversation boundary does not exist. **inferred**
2. **Do not give the agent a whole log in one call.** GPT-4o, given a full IRC log in one call and asked for all
   links: link F1 22.0, conversation exact-match F1 0.
   **paper** Pal et al., "Disentangling Approaches to Conversation Disentanglement: Fine-Tune or Learn from
   Scratch?", LREC 2026, Table 1. Asking one target message at a time with a candidate list works much better
   (section 4).
3. **The two biggest gains for LLMs: show earlier conversations, and show the messages after the target.**
   Takada & Mori 2026 add "dialogue-level assignment" (DLA: assign to an existing conversation, not to one
   message) and "subsequent context" (SC: messages after the target). With Gemini 2.5 Pro they report
   conversation exact-match F1 61.27, above the best trained model (DiHRL, 48.90).
   **paper** as reported in Takada & Mori, "DD-GEPA", arXiv 2606.07894, 2026, Table 2. I did not read the
   original LaCATODA 2026 paper. DD-GEPA warns that the public IRC data may be in LLM pretraining data.
   61.27 is also above the human exact-match agreement of 49.5, which makes me cautious. **inferred**
   For our workflow: **the overlap between batches is the look-ahead.** A message near the end of a batch
   should be decided again, or left open, when the next batch shows what follows it. **inferred**
4. **Explicit replies are already gold links.** We have them for 60.5% of messages (our measurement). IRC has
   no reply button. Only about 48% of IRC messages name the addressee.
   **paper** Kummerfeld 2019, §2. Our task is therefore easier than the IRC benchmark, and the hard part
   is the 40% with no link. **inferred**
5. **Same-sender runs are a hint, not a merge.** The average speaker takes part in about 3.3 conversations.
   **paper** Elsner & Charniak, "You Talking to Me?", ACL 2008, §3. The rule "all messages of a user belong to
   one conversation" held 52.2% of the time. **paper** Kummerfeld 2019, §5.3. Store same-sender links as
   candidates with provenance, and let the agent confirm them. **inferred**
6. **Size the candidate window from our own data, not from IRC.** IRC models look back 100 messages
   (**code** `irc-disentanglement/src/disentangle.py:34`, `--max-dist 101`) or 50 (**paper** DD-GEPA §5.5).
   Ubuntu is busy: 94.8% of conversations get a first reply within 3 minutes (**paper** Kummerfeld 2019,
   §5.3). Our median gap is 538 s. Measure the distance from each explicit reply to its parent, in messages and
   in seconds, and set the window to cover 95–99% of them. **inferred**
7. **Build a small gold set.** Annotation took 7–11 s per message (**paper** Kummerfeld 2019, §4.2). So 500
   messages cost about 1–1.5 hours of one person. **inferred** Without it we cannot compare any setting.

## 2. Datasets

| Dataset | Size | Labels | License | Source |
|---|---|---|---|---|
| Ubuntu IRC (Kummerfeld 2019) | 77,563 annotated msgs (74,963 Ubuntu + 2,600 #Linux) | human reply graphs, adjudicated dev/test | data CC-BY-4.0; code ISC | **paper** Table 1; **code** `LICENSE.md` |
| IRC new domains (Gouravajhala 2023) | 2,400 annotated + 12,000 context (mediawiki, rust, stripe, ubuntu-meeting) | human reply graphs | CC-BY-4.0 (same `data/`) | **code** `data/new-domains/README.md` |
| Elsner & Charniak #Linux | 2,500 msgs (800 test, 6 annotators) | conversations only, no graph | free download | **paper** EC 2008 Table 1 |
| Russian Telegram, thread reconstruction (Buyanov 2023) | size not checked | human, Label Studio | CC BY 4.0 | Mendeley `7rms5vdhf8` |
| Russian Telegram, reply recovery (Buyanov 2023) | size not checked | positives from Telegram `reply_to`, random negatives; test set checked by crowd + authors | CC BY 4.0 | Mendeley `xm86yszck2` |
| Movie Dialogue (Liu et al., IJCAI 2020) | 29,669/2,036/2,010 instances, 827,193 msgs (**unverified**) | synthetic: separate sessions interleaved | no license file (GitHub API: none) | github.com/LayneIns/E2E-dialo-disentanglement |
| Slack (Chatterjee et al., MSR 2020) | 38,955 conversations, 437,893 msgs (**unverified**) | machine-disentangled; small manual check | Zenodo 3627124, "other-open" | **paper** MSR20 §3 |
| DISCO Discord (Subash et al., MSR 2022) | not checked | machine-disentangled; 500 conversations checked by hand (**unverified**) | not checked | ACM DL |
| Gitter SE (Jiang et al., IJCAI 2021) | 749 dialogs | human | not checked | github.com/disensoftware/disentanglement-for-software |

Notes:
- Download: `git clone https://github.com/jkkummerfeld/irc-disentanglement`. Also on Hugging Face as
  `jkkummerfeld/irc_disentangle` (CC-BY-4.0; its 254,742 rows include the context lines, **unverified** card).
- Format (**code** `data/README.md`): `*.ascii.txt` one message per line; `*.annotation.txt` lines like
  `1002 1003 -` (a link); a self-link marks a new conversation. Lines 0–999 are context only; annotation starts at
  1,000.
- The **Russian Telegram data is the closest match to us**: same app, same `reply_to` field, Russian. The
  Buyanov et al. paper, "Who is answering to whom? Modeling reply-to relationships in Russian asynchronous
  chats" (Dialogue 2023), was a 404 at dialog-21.ru, so I have no numbers from it. Their best model is
  `astromis/rubert_reply_recovery` on Hugging Face (MIT). **code** github.com/Astromis/research/reply_recovery.
- Riou et al. 2015 (French Ubuntu IRC) is "available on request". **paper** Kummerfeld 2019 Table 1.
- Chinese: I found no human-annotated group-chat disentanglement set in two searches.
- Slack, Discord and Movie Dialogue are not usable as gold for evaluation (machine labels or synthetic). **inferred**

## 3. Features and baselines

Which features matter:
- **Name mention is the single most useful feature.** Without it the pair classifier F-score drops from 71 to 56.
  **paper** Elsner & Charniak 2008, §5.
- Chat features (time gap, same speaker, mention) alone: F 66. Discourse cues alone: F 58. Word overlap alone:
  F 56. All combined: F 71. Content features help only together with the time gap. **paper** EC 2008, Table 2.
- The IRC feedforward model uses: time gap, message distance, same speaker, who addressed whom (before, between,
  after), same target, word overlap, user's previous message, bot flag. **code** `src/disentangle.py`, features
  block around lines 280–370; **paper** Kummerfeld 2019 supplement, Table 1. No feature ablation is published.
- Links rarely span more than an hour in IRC annotations. **paper** Kummerfeld 2019, §5.3.

Ubuntu IRC test set, link level and conversation level (**paper** Kummerfeld 2019 Tables 3–4; later rows from
Pal et al. 2026 Table 1 and Ma et al. 2022 Table 1):

| System | Link P/R/F | VI | 1-1 | Conv. exact P/R/F |
|---|---|---|---|---|
| Previous message (heuristic) | 35.7 / 34.4 / 35.0 | 66.1 | 27.6 | 0 / 0 / 0 |
| Lowe et al. 2017 (time + mention heuristic) | — | 80.6 | 53.7 | 10.8 / 7.6 / 8.9 |
| Elsner & Charniak 2008 (linear pairs) | — | 82.1 | 51.4 | 12.1 / 21.5 / 15.5 |
| Linear, hand features | 64.7 / 62.3 / 63.5 | 88.9 | 69.5 | 19.3 / 24.9 / 21.8 |
| Feedforward + GloVe | 73.7 / 71.0 / 72.3 | 91.3 | 75.6 | 34.6 / 38.0 / 36.2 |
| FF ×10 vote | 74.9 / 72.2 / 73.5 | 91.5 | 76.0 | 36.3 / 39.7 / 38.0 |
| Pointer network (Yu & Joty, EMNLP 2020) | 74.5 / 71.7 / 73.1 | 94.2 | 80.1 | 44.9 / 44.2 / 44.5 |
| Structural BERT (Ma et al., ACL 2022) | — | 94.6 | 84.2 | 51.8 / 51.7 / 51.7 |
| Structural BERT + RL (Bhukar et al., AAAI 2023) | 83.3 / 83.3 / 83.3 | 96.2 | — | 51.5 / 52.3 / 51.9 |

- Pure heuristics are weak at conversation level: exact-match F1 0 to 8.9. Hand features in a small model already
  reach link F1 63.5. **paper** Kummerfeld 2019 Tables 3–4.
- The vote ensemble: the README says the paper describes it wrongly; the most agreed link wins, ties go to
  the shorter link. **code** README "Updates".
- Only 10.8% of the Lowe heuristic's conversations are exactly right. 47% of them start at the wrong message.
  **paper** Kummerfeld 2019, §5.3.
- Zero-shot without labels (self-supervised response selection): link F1 ~41–42, conversation F1 ~23–25.
  With 10% of labels: link F1 69.3. **paper** Chi & Rudnicky, "Zero-Shot Dialogue Disentanglement by
  Self-Supervised Entangled Response Selection", EMNLP 2021, Table 2.

## 4. LLM results

| Setting | Model | Result | Source |
|---|---|---|---|
| Whole log in one call, 1 short example | GPT-4o | link F1 22.0, VI 59.4, 1-1 20.9, conv F1 0 | **paper** Pal et al. 2026, Table 1 |
| Whole log per example, fine-tuned on 153 logs | GPT-4o-mini | link F1 74.4, VI 92.5, 1-1 78.0, conv F1 45.3 | same |
| One target, 50 previous msgs, zero-shot, 100 msgs sampled | GPT-3.5-turbo-0301 | pairwise link F1 0.10 (vs 0.72 trained) | **paper** Li et al., "Revisiting Conversation Discourse for Dialogue Disentanglement", arXiv 2306.03975, Table 7 |
| One target, 50 candidates, whitespace fields | Qwen3-30B-A3B-Thinking | conv F1 14.43, 1-1 56.68 | **paper** DD-GEPA 2026, Table 2 |
| Same, JSON fields + `{is_new, parent}` output | Qwen3-30B | conv F1 39.40, 1-1 78.46 | same |
| Same, prompt optimised by GEPA | Qwen3-30B | conv F1 42.52, 1-1 82.26 | same |
| DLA + SC (as reported) | GPT-4.1 | conv F1 47.53, 1-1 86.34, VI 95.39 | DD-GEPA Table 2, citing Takada & Mori 2026 |
| DLA + SC (as reported) | Gemini 2.5 Pro | conv F1 61.27, 1-1 90.78, VI 97.16 | same |
| Sliding window, 20 utterances, spoken classroom data | gpt-4.1 | κ 0.65 (all-at-once zero-shot: κ 0.10) | **paper** Ravi et al., arXiv 2510.22844, 2025, Tables 6, 8 |

Reading:
- Older or smaller LLMs, zero-shot, are far below trained models. Strong 2025–2026 models with a good prompt
  reach or pass them. **paper** rows above.
- Prompt format alone moved Qwen3-30B from conv F1 14 to 39. **paper** DD-GEPA Table 2.
- Remaining LLM errors (DD-GEPA §6.3): greetings and "hmm" between other messages; bot and system messages that
  contain a name; topic-only links with domain jargon; comments with several possible addressees; cases that need
  the messages after the target.
- GPT-5.2 in DD-GEPA appears only as a 96.12% success rate on 450 hard single decisions (Table 1), not on the
  test set.

## 5. Metrics

Recommendation for us:
- **Link level: precision, recall, F1** over (message, parent) pairs, self-link = "starts a new conversation".
  This scores the agent's direct output. **code** `tools/evaluation/graph-eval.py`.
- **Conversation level: exact-match F1, 1-1, and scaled VI** (reported as 1 − VI/log n).
  **code** `tools/evaluation/conversation-eval.py` (needs Google OR-Tools for the 1-1 matching).
- Exact-match F1 ignores single-message conversations. **paper** Kummerfeld 2019 §4.3.
- Among standard metrics, exact-match F1 is closest to human satisfaction (MAE 0.14). NMI, ARI and Shen-F
  overrate quality. **paper** Jiang et al., "Dialogue Disentanglement in Software Engineering: How Far are We?",
  IJCAI 2021, §4.
- Shen-F and Local-3 exist for comparison with older work only. **paper** Kummerfeld 2019 §5.2.
- VI and ARI look good when most conversations are singletons. Report the singleton share next to them.
  **inferred**

Scorer formats (**code** `tools/README.md`):
- graph: `path/file.annotation.txt:1003 1002 -` per link, run `python3 tools/evaluation/graph-eval.py --gold … --auto …`
- clusters: one conversation per line, `path/file:1002 1003 1004`, run `conversation-eval.py gold system`
- `dstc8-evaluation.py` prints scaled VI, ARI and matched-cluster P/R/F.
- Also `graph-to-cluster.py` (union-find from links) and `significance.py` (permutation test). All ISC.
- Easiest for us: export our links in the graph format and reuse the scripts as-is. **inferred**

## 6. Guidance for the agent workflow

From the literature:
- **Per-message decisions, not a list of links for a whole log.** **paper** Pal 2026 §4.2.1, Table 1.
- **Candidate window 50–100 previous messages.** **paper** DD-GEPA §5.5; **code** `--max-dist 101`. Some gold
  parents fall outside 50 (DD-GEPA §5.6).
- **Show each message as labelled JSON**: id, timestamp, speaker, text. **paper** DD-GEPA Table 2, Appendix.
- **Output** `{"is_new_dialogue": bool, "utterance_id": id|null}` or `{"response_index": id|null}`.
  **paper** DD-GEPA §5.3, Appendix.
- **Show earlier conversations as groups (DLA) and messages after the target (SC).** **paper** as cited in DD-GEPA.
- **Sliding windows beat whole transcripts** (κ 0.65 vs 0.10). Window 10, 20, 30 were about the same (κ 0.67,
  0.65, 0.67). **paper** Ravi 2025, Tables 6, 8, 9.
- Temperature 0 for reproducible labels. **paper** DD-GEPA §5.5.

For our CLI (all **inferred**):
- Batch = N targets plus the look-back window plus K look-ahead messages. No paper tests "N targets per call",
  which is our middle ground between one call per message (expensive) and one call per log (bad).
- Mark decisions for the last K messages of a batch as provisional. Redo them in the next batch.
- Give the agent the deterministic layer as facts: explicit reply parent (fixed, never overridden), forum thread,
  same-sender candidate, and the current conversation ids of earlier messages.
- Ask the agent only about messages with no explicit reply. Allow "unsure"; do not force a parent.
- Store per link: parent id or null, source (`reply`, `thread`, `heuristic`, `agent`), model, prompt version,
  batch id, and a confidence. Then a new prompt can be rescored against the gold set.
- Tell the agent that bots, joins and service messages start nothing and answer nothing unless replied to.
- Hold out a random sample of explicit replies (hide the link, ask the agent) as a cheap extra test. Messages
  people replied to with the button may differ from the unlinked 40%, so this does not replace the gold set.

## 7. Chunking evidence

- **No direct evidence** found that conversation-based chunks beat fixed windows for retrieval over
  multi-party chat.
- Nearest evidence: SeCom (Pan et al., ICLR 2025) segments long two-person conversations into topical segments.
  Segments beat turn-level and session-level memory. LOCOMO, BM25: GPT4Score 71.57 vs 65.58 (turn) vs 63.16
  (session). Long-MT-Bench+, MPNet: 88.81 vs 84.91 vs 73.38. **paper** SeCom Table 1 (checked in the PDF).
  That is topic segmentation of a two-person conversation, not disentanglement of a group.
- Better disentanglement gave better downstream dialogue models in next-utterance selection (**paper**
  Kummerfeld 2019 Table 7) and in response selection and QA (**paper** Ma et al. 2022 Table 5). This is
  indirect evidence.
- LLM thread labels improved downstream coding of classroom talk when the whole transcript was given: κ 0.63
  with threads vs 0.05 without. With a sliding window the gain was small: 0.64 vs 0.60.
  **paper** Ravi 2025, Table 11. Local context did most of the work there.
- For document chunking the results are mixed. One 2026 study on theses found semantic chunking no better than
  fixed windows (arXiv 2607.01852, **unverified**).
- Verdict: test it on our own questions. Compare conversation chunks with fixed windows of the same token
  budget, measured by recall@k on questions with a known answer message. **inferred**

## 8. Open questions

1. How far back are our explicit reply parents (messages and seconds)? This sets the candidate window.
2. How many messages go in one agent batch, and how many look-ahead messages?
3. Do we store one parent per message, or several (IRC allows several)?
4. How large a gold set, and who labels it?
5. Should same-sender runs join automatically when the gap is under X seconds, or always go to the agent?
6. Chunk size cap: long conversations must split. By time gap, by token count, or by reply subtree?
7. Can we get the Buyanov 2023 paper and its numbers? It is the only Russian Telegram work found.
8. The 61.27 result: pretraining leakage or real? Our own gold set is the only way to tell.
