# Search discovery integration

The owner authorized continued search improvement, dependency releases, consumer integration and
merges on 2026-10-10. The current model-free research path depends on a full archive snapshot and
shared synthetic templates. Fresh wording exposes retrieval failures, so it cannot replace strict
search by default.

The implementation provides an explicit archive discovery option shared by CLI, MCP and SDK. Strict Lucene remains
the compatibility default. Discovery retrieves partial lexical matches using the existing SQLite
FTS indexes and ranks them without neural downloads or a full in-memory corpus. All hard account,
chat, sender, date and explicit syntax constraints remain enforced. Metadata describes partial
matching; results are relevant evidence, not asserted answers or answer probabilities.

Delivery sequence:

1. Preserve fresh-fixture evidence and compare bounded OR candidate retrieval with cheap ranking.
2. Add storage-backed discovery using existing FTS BM25 and bounded direct-reply lookup; no base
   schema changes or automatic conversation rebuilds. Test hard filters, deleted records, account
   isolation, explicit syntax, cancellation and bounds.
3. Expose the opt-in through shared CLI/MCP/SDK entry points and saved-search behavior. Keep remote
   search separate from archive discovery. Update shared guides and generated consumer contracts.
4. Measure the built implementation with fresh and historical synthetic fixtures and increasing
   archive sizes. Record failures and whole-process resources.
5. Run required checks, merge passing work, release the shared package, adopt the exact released
   version in isolated Telegram/MAX worktrees, check offline CLI/MCP adoption and release tools.

Use synthetic stores only. No real account actions or message reads are part of this work. Public
strict search defaults and explicit Boolean semantics remain unchanged.
