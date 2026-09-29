# Messenger CLI Local Search & Conversation Indexing — the owner's requirements

Given by the owner on 2026-09-29, verbatim. Where the research in this folder contradicts a
requirement (the storage engine in §2), that is recorded in [`decisions.md`](decisions.md), not
edited here.

## 1. Goal

Build a fast, local, cross-platform search subsystem for Messenger CLI that can search across large message histories from multiple chats, groups and sources.

The primary search path must:

* work entirely locally;
* require no LLM/API calls;
* work across chats regardless of whether the user is currently a member, provided the messages have already been imported locally;
* support large groups with approximately 1M messages;
* support a substantially larger total local corpus;
* provide good relevance ranking;
* tolerate typos and spelling variants;
* support filters by chat, author, source and date;
* leave room for optional semantic/conversation-aware indexing later.

AI-based conversation reconstruction and vector search must **not run automatically for every group**.

They are an explicit, user-triggered enrichment feature.

---

# 2. Storage architecture

Replace SQLite with PGlite as the daemon-owned embedded database.

Architecture:

```text
CLI
 │
MCP / other clients
 │
 ▼
Messenger daemon
 │
 ├── messenger adapters
 ├── sync
 ├── storage
 ├── search
 └── conversation enrichment
        │
        ▼
      PGlite
```

Only the daemon may open the PGlite data directory.

CLI processes must communicate with the daemon and must never access database files directly.

Use one long-lived PGlite instance for the lifetime of the daemon.

Required extensions:

```text
pg_textsearch   BM25 lexical search
pg_trgm         fuzzy / typo search
unaccent        accent-insensitive normalization
```

Optional:

```text
pgvector        semantic search over enriched conversation chunks
```

Do not add Elasticsearch, OpenSearch, LanceDB or a separate graph database in the initial architecture.

---

# 3. Search philosophy

There are two separate search systems.

## A. Message search

Cheap, automatic and always available.

Every suitable incoming message is indexed immediately.

Uses:

* BM25
* trigram similarity
* metadata filters

No embeddings.

No AI calls.

No reconstructed conversations.

## B. Conversation search

Optional and explicitly generated.

For selected groups/chats:

1. reconstruct conversation relationships;
2. build message graphs;
3. identify coherent conversations/subthreads;
4. create searchable conversation documents/chunks;
5. optionally generate embeddings;
6. store the resulting derived index.

This operation may consume LLM/API credits.

Therefore it must never silently happen for all chats.

---

# 4. Core message model

At minimum:

```text
messages

id
source
source_message_id

account_id
chat_id
sender_id

sent_at

text
normalized_text

reply_to_message_id nullable
quoted_message_id nullable

thread_id nullable
topic_id nullable

forward_source nullable

created_at
updated_at

raw_metadata jsonb
```

Keep provider-specific IDs separately from internal IDs.

Example:

```text
source = telegram

source_message_id = 238745
chat_id = internal UUID / bigint
```

Do not use Telegram/Max IDs as globally unique primary keys.

---

# 5. Chat model

The search system must not equate:

```text
searchable
```

with:

```text
currently joined
```

A chat may be:

```text
joined
left
public
imported
archived
external
unknown
```

If its messages exist locally, they should remain searchable unless the user explicitly removes them.

Suggested fields:

```text
chats

id
source
source_chat_id

name
username
type

membership_state
is_searchable

message_count

first_message_at
last_message_at
last_indexed_at
```

---

# 6. Normalization

Preserve original `text`.

Generate a normalized search representation separately.

Normalization should include:

* Unicode normalization;
* lowercase where appropriate;
* accent/diacritic-insensitive variant;
* whitespace normalization;
* stripping useless control characters.

Do NOT destructively alter the original message.

Example:

```text
Original:

¿Alguien conoce un buen gestor en València?


Normalized:

alguien conoce un buen gestor en valencia
```

Mixed-language messages must work.

Do not assume one language per group.

Initial lexical indexing should prefer language-neutral behavior rather than aggressively stemming every message using an incorrectly detected language.

---

# 7. BM25 full-text search

Use `pg_textsearch`.

BM25 should be the main ranking system.

Search must work across:

```text
one chat
several chats
all chats
one messenger
all messengers
```

Example:

```bash
<cli> search "TIE appointment Valencia"
```

Search all locally indexed messages.

Filters:

```bash
<cli> search "TIE appointment" --chat valencia-expats

<cli> search "gestor" --after 2026-01-01

<cli> search "football trainer" --before 2026-06-01

<cli> search "school" --from @john

<cli> search "visa" --source telegram
```

Filters must be executed in the database where practical rather than loading large candidate sets into JavaScript.

---

# 8. Fuzzy / trigram search

Use `pg_trgm`.

Fuzzy search is complementary to BM25.

Important cases:

```text
Valenca      → Valencia
empadronamento → empadronamiento
Ptsharev     → Ptsarev
whatsap      → whatsapp
```

Do not run expensive trigram matching blindly over millions of messages if BM25 already provides strong results.

Recommended query flow:

```text
query
 │
 ├── BM25 candidates
 │
 └── fuzzy candidates when useful
        │
        ▼
     rank/fuse
```

Trigram search should especially help with:

* names;
* usernames;
* locations;
* uncommon terms;
* misspellings;
* zero-result BM25 queries.

---

# 9. Default ranking

Initial ranking should remain deterministic.

Do not use an LLM to rank normal search results.

Candidate signals:

```text
BM25 score
trigram similarity
exact phrase match
exact token match
recency
```

BM25 should dominate relevance.

Recency may be used as a small secondary signal but must not make recent irrelevant messages outrank older highly relevant ones.

Keep ranking implementation behind:

```ts
interface SearchRanker
```

so it can be modified later.

---

# 10. Search API

Expose a storage-independent service API.

```ts
interface SearchService {
  search(
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]>
}

interface SearchOptions {
  chatIds?: string[]
  senderIds?: string[]
  sources?: MessengerSource[]

  after?: Date
  before?: Date

  mode?: "text" | "semantic" | "hybrid"

  fuzzy?: boolean

  limit?: number
  offset?: number
}
```

Default:

```text
mode = text
fuzzy = true
limit = 50
```

`text` must never require embeddings or API calls.

---

# 11. Search result

Return enough context that both humans and agents can understand a result.

```ts
interface SearchResult {
  messageId: string
  chatId: string

  chatName?: string

  senderId?: string
  senderName?: string

  sentAt: Date

  text: string

  score: number
  matchType: "bm25" | "fuzzy" | "hybrid"

  contextBefore?: Message[]
  contextAfter?: Message[]
}
```

CLI output should normally include several surrounding messages.

Example:

```text
Valencia Expats
2026-03-11 12:43

John:
I finally got my TIE appointment yesterday.

Maria:
Where?

John:
Policía Nacional on Calle Hospital.
You need the EX-17 and a photo.

────────────────────────────────────
```

Searching individual messages but displaying local context is important.

---

# 12. Conversation graph

Conversation reconstruction is a separate subsystem.

Do NOT introduce Neo4j, AGE or another graph database initially.

Represent the graph relationally.

Schema:

```text
message_edges

from_message_id
to_message_id

edge_type
confidence

edge_source

created_at
```

Possible edge types:

```text
explicit_reply
quote
thread
topic

same_author_continuation
mention
temporal_reply

inferred_reply
inferred_context
```

`edge_source` examples:

```text
provider
heuristic
llm
```

Examples:

```text
1042 ─explicit_reply─► 1038

1050 ─same_author_continuation─► 1049

1071 ─inferred_reply─► 1062
```

---

# 13. Graph construction stages

Graph building must proceed from cheapest / most reliable signals to expensive signals.

## Stage 1 — deterministic provider edges

Use existing messenger metadata:

```text
reply_to
quote
thread/topic ID
forward relationships
```

Confidence approximately:

```text
1.0
```

No AI required.

## Stage 2 — deterministic heuristics

Possible signals:

* same author and short time gap;
* explicit `@username`;
* message immediately following a question;
* shared URLs;
* quote-like text;
* topic/thread metadata;
* nearby messages involving the same participants.

These should create candidate edges with lower confidence.

## Stage 3 — AI inference

Only when explicitly requested.

Give the model a bounded time/message window and ask it to determine likely conversational relationships.

For example:

```text
Messages 4000–4070
```

Output structured edges:

```json
[
  {
    "from": 4028,
    "to": 4019,
    "relationship": "reply",
    "confidence": 0.83
  }
]
```

Never ask the model to rewrite the complete corpus.

Use structured output.

Process bounded windows.

Overlap windows enough to avoid breaking conversations at boundaries.

---

# 14. Conversation enrichment command

Provide an explicit command.

Suggested interface:

```bash
<cli> search enrich --chat <chat>
```

Examples:

```bash
<cli> search enrich --chat valencia-expats

<cli> search enrich --chat valencia-expats --after 2026-01-01

<cli> search enrich --chat valencia-expats --mode heuristic

<cli> search enrich --chat valencia-expats --mode ai
```

Modes:

```text
metadata
heuristic
ai
```

Default should NOT silently invoke paid AI.

Possible default:

```text
metadata + heuristic
```

AI must require:

```text
--mode ai
```

or explicit configuration.

---

# 15. AI cost controls

Before an expensive enrichment run, calculate an approximate workload.

Example:

```text
Chat: Valencia Expats
Messages: 483,212
Period: Jan 2025 – Sep 2026

Deterministic graph:
  Free

AI inference:
  ~7,400 windows
  estimated input: ~11.2M tokens
  estimated cost: €X–€Y

Continue? [y/N]
```

Also support:

```bash
--max-cost
--max-tokens
--after
--before
```

and ideally:

```bash
--dry-run
```

Example:

```bash
<cli> search enrich \
  --chat valencia-expats \
  --mode ai \
  --max-cost 5 \
  --dry-run
```

The daemon must never accidentally generate an unbounded bill.

---

# 16. Conversation components

Once the graph exists, identify connected or strongly related message groups.

Do not assume a group chat contains one chronological conversation.

Example:

```text
10:31 visas
10:32 football
10:32 visas
10:33 restaurant
10:33 football
10:34 visas
```

Chronological chunking alone is insufficient.

The graph should allow:

```text
visa conversation
  100
  104
  109
  115

football conversation
  101
  106
  112

restaurant conversation
  108
  113
```

even though messages are interleaved.

---

# 17. Conversation documents

Materialize graph-derived conversations separately.

Schema approximately:

```text
conversation_documents

id
chat_id

first_message_at
last_message_at

message_ids
participant_ids

title nullable
summary nullable

document_text

graph_version
model nullable

created_at
updated_at
```

`document_text` should preserve actual useful conversation content.

Do not rely only on an AI-generated summary.

Prefer something similar to:

```text
[Anna]
Does anyone know where to renew a TIE?

[Peter]
I did mine last week.

[Anna]
Where did you get the appointment?

[Peter]
Calle Hospital. Bring EX-17 and photos.
```

This preserves facts that a generated summary could accidentally omit.

---

# 18. Semantic indexing

Semantic search is performed over:

```text
conversation_documents
```

rather than every raw message.

Use pgvector.

Suggested separate table:

```text
conversation_embeddings

conversation_id

embedding
model
dimensions

content_hash

created_at
```

Do not place embedding vectors directly on `messages`.

This allows:

* changing models;
* reindexing;
* supporting multiple models;
* deleting semantic indexes without touching message storage.

---

# 19. Incremental enrichment

A 1M-message chat must not need complete reprocessing after every sync.

Track enrichment state.

```text
search_enrichment_state

chat_id

graph_version
last_message_id
last_processed_at

embedding_model
embedding_version
```

When new messages arrive:

```text
existing graph
      +
new messages
      +
small overlap window
      ↓
incremental graph update
```

Reprocess only the relevant trailing region unless explicitly rebuilding.

---

# 20. Semantic search command

Normal:

```bash
<cli> search "TIE appointment"
```

means lexical search.

Semantic must be explicit initially:

```bash
<cli> search "where did people recommend renewing residence cards?" \
  --mode semantic
```

Hybrid:

```bash
<cli> search "TIE appointment" --mode hybrid
```

If semantic data is unavailable for some chats:

```text
Semantic index:
  Valencia Expats       ✓
  Parents Valencia      ✓
  Football Spain        not indexed
```

Do not fail the whole query.

Search the available semantic corpus and clearly expose coverage in diagnostics.

---

# 21. Hybrid ranking

Hybrid search should combine:

```text
BM25 message results
+
semantic conversation results
```

Start with Reciprocal Rank Fusion.

Avoid inventing a complicated custom scoring formula prematurely.

Conceptually:

```text
BM25 ranking ───────┐
                    ├── RRF ──► final ranking
vector ranking ─────┘
```

Keep this implementation replaceable.

---

# 22. Indexing lifecycle

New messages should automatically receive:

```text
database insert
BM25 indexing
normalization
```

No AI.

No embeddings.

Optional background operations:

```text
trigram/index maintenance
statistics
```

Conversation enrichment should only run for chats that have explicitly been enabled.

Possible configuration:

```text
search.enrichment.chats = [...]
```

but an explicit CLI command should be the primary initial interface.

---

# 23. Search management commands

Implement:

```bash
<cli> search status
```

Example:

```text
Messages:              4,381,224
Searchable chats:      812

BM25 indexed:          4,381,224
Fuzzy index:           ready

Conversation graphs:
  chats:               3
  conversations:       28,419

Semantic index:
  conversations:       23,104
  model:               multilingual-e5-small
```

Also:

```bash
<cli> search rebuild
<cli> search rebuild --chat <id>

<cli> search enrich --chat <id>
<cli> search enrich --chat <id> --mode ai

<cli> search enrichment-status --chat <id>

<cli> search drop-enrichment --chat <id>
```

Dropping enrichment must not remove raw messages.

---

# 24. Database maintenance

Provide:

```bash
<cli> db info
<cli> db doctor
<cli> db backup
<cli> db restore
<cli> db migrate
```

`db doctor` should check:

```text
database opens correctly
schema version
extensions available
search indexes valid
disk space
enrichment index consistency
```

---

# 25. SQLite migration

Existing users must have a migration path.

On first startup after upgrading:

```text
SQLite detected.

Messenger CLI now uses PGlite.

Messages: 184,291
Chats: 143
Attachments: 7,842

Migrate database? [Y/n]
```

Migration procedure:

```text
1. backup SQLite DB
2. create PGlite database
3. run schema migrations
4. copy data in batches
5. validate counts
6. construct search indexes
7. mark migration successful
8. retain old SQLite backup
```

Do not delete the old database automatically.

Migration must be resumable or safely restartable.

---

# 26. Performance target

Design for at least:

```text
1M messages in a single large group
10M+ messages in the total local corpus
```

Do not assume the entire corpus can fit in JS memory.

All bulk operations must use:

```text
streaming
pagination
bounded batches
database-side filtering
```

Add a benchmark fixture.

At minimum measure:

```text
BM25 query
fuzzy query
chat-filtered query
date-filtered query
combined query

100k messages
1M messages
10M messages where practical
```

The goal is interactive search.

Do not add Elasticsearch merely because a synthetic benchmark is imperfect; first determine whether the bottleneck is:

```text
PGlite/WASM
query
index
schema
ranking
I/O
```

---

# 27. Privacy

All lexical search and graph heuristics are local.

AI graph reconstruction may send message content to an external model.

Before enabling an external AI provider for a chat, make this explicit.

Support a local-model provider later.

Architecture:

```ts
interface ConversationInferenceProvider {
  inferEdges(
    messages: Message[]
  ): Promise<InferredEdge[]>
}
```

Implement provider adapters separately from graph construction.

---

# 28. Versioning

Derived search data must be versioned.

Store:

```text
normalizer_version
graph_algorithm_version
graph_model
graph_prompt_version
embedding_model
embedding_version
```

This allows:

```bash
<cli> search enrich --rebuild
```

after algorithms or models change.

Raw messages remain untouched.

---

# 29. Important invariants

1. Raw messages are the source of truth.

2. Search indexes are derived and rebuildable.

3. Conversation graphs are derived and rebuildable.

4. Embeddings are derived and rebuildable.

5. Deleting an index must never delete source messages.

6. Ordinary search must never incur API cost.

7. Background sync must never unexpectedly trigger LLM processing.

8. Search must work without semantic enrichment.

9. A chat does not need current membership to remain searchable.

10. All database ownership goes through the daemon.

---

# 30. Implementation phases

## Phase 1 — PGlite foundation

Implement:

```text
PGlite integration
daemon lifecycle
schema migrations
SQLite migration
repository layer
backup/doctor
```

No search changes yet beyond preserving current functionality.

## Phase 2 — proper lexical search

Implement:

```text
pg_textsearch
BM25 indexing
normalization
pg_trgm
filters
search CLI
context display
```

This should become the default production search.

## Phase 3 — deterministic conversation graph

Implement:

```text
reply edges
quote edges
threads/topics
mentions
simple temporal/author heuristics
message_edges
conversation components
```

No LLM.

No vectors.

This phase itself may already substantially improve contextual search.

## Phase 4 — optional AI graph reconstruction

Implement:

```text
ConversationInferenceProvider
windowing
structured output
confidence scores
cost estimation
budget limits
incremental processing
```

Only explicit invocation.

## Phase 5 — semantic conversation search

Implement:

```text
conversation_documents
pgvector
embedding providers
semantic search
RRF hybrid search
```

Again, only for explicitly enriched chats.

---

# 31. Definition of done for initial release

The first useful release does **not** require vectors.

It is done when:

```text
✓ daemon runs PGlite cross-platform
✓ old SQLite installations can migrate safely
✓ millions of raw messages can be stored
✓ messages are automatically BM25 indexed
✓ typo/fuzzy search works
✓ search can span every locally stored chat
✓ chat/source/author/date filters work
✓ results show surrounding conversation context
✓ searches incur zero API cost
✓ no Elasticsearch or external search service is required
```

The conversation-graph and semantic functionality should be developed as subsequent capabilities without changing the basic storage/search architecture.
