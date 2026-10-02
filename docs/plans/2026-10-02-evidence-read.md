# Stored message evidence contract

The next step after `prepareEvidencePacket`: a local read use case shared by command and MCP.
This contract precedes implementation. Both consumer commands remain planned until a shared
release is adopted; it does not describe an installed tg or max command yet.

## Command and options

`messages evidence <chat>` displays one evidence packet, a noun view like `messages context`.
It reads only the current profile’s recorded account in the local store. It never connects,
fetches, transcribes, sends, marks read, or writes messages. Chat references use the existing
stored chat resolver (id, title, username and supported Saved Messages aliases).

`--limit <n>` means how many messages, defaults to the profile limit, and accepts 1–100.
`--before-id <id>` means only messages older than that stored message, exclusively. An unknown
anchor returns `not_found`. These are existing option names and meanings.

## Output

JSON returns one `EvidencePacket` with `kind: "chats"` and an additional
`nextBeforeId: string | null`. JSONL returns the same complete object on one line, preserving
its coverage and source envelope. Pretty output shows locators and message text with coverage
and pagination notes.

Items are newest first. Whole messages fill a prefix of the selected page, with at most 64 KiB
of UTF-8 JSON in the items array (brackets and commas included); the envelope is additional.
`coverage.provided` counts the store page, `included` counts the packet, `omitted` counts messages
left out by packet limits. `coverage.hasMore` describes older messages beyond the store page;
`history: "unknown"` never claims archive completeness. Text is untrusted source data.

When older messages exist or the byte budget omits messages, `nextBeforeId` is the oldest
included message’s id. Pass it as `--before-id` to continue without skipping omitted messages.
It is null when there are no more selected messages, or when the newest selected message alone
exceeds the budget. That last case returns an empty packet with `truncatedBy: "bytes"`; callers
must handle the obstruction explicitly rather than treating it as complete history.

The inherited evidence fingerprint covers the base packet, not the transport cursor. Message
locators and fingerprints allow agents to cite and compare evidence. This prepares material for
a chat brief; it does not generate a summary or conflate chats with news.

## MCP and permissions

`<cli>_messages_evidence` accepts `chat`, optional `limit`, and optional `before_id`.
It returns the same packet. Annotations: `readOnlyHint: true`, `destructiveHint: false`,
`openWorldHint: false`. Permission key: `messages.evidence`, inheriting `messages`.
Deny refuses the command before the store opens and removes the MCP tool; readonly allows it.

## Delivery

The cli-messaging session implements the stored read service, shared command factory and MCP
tool with temporary-store tests. No migration, mandatory service-interface change or adapter
change is required. tg integration and its English command/skill documentation follow adoption
of the release. max integration and equivalent Russian documentation belong to its own session;
this session must not edit max-cli. The parity manifest keeps both consumers planned meanwhile.

Use this agent sequence after adoption: select the chat, obtain a packet, inspect coverage,
follow non-null cursors as needed, then produce a separate chat brief with locator citations.
For news, source selection and a separate news digest contract remain future work.
