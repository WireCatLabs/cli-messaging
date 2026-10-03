# Message permalink and locator (B1c)

Approved and implemented 2026-10-03; owner instruction: implement. Shared #483/0.139.0, TG #252 and MAX #381 merged with green CI. Consumer binary release and live checks remain separate.

Personal command: `messages link <chat> <message>` or `messages link <msg:locator>`. A shared read service and MCP `messages_link` return `{ locator, url, access, reason }`. `access` is public/restricted/unknown/unavailable; URL may be null. Access describes the link audience, never proof that another account can read it. Read errors remain errors. Singular link differs from plural links (conversation graph).

Validate locator provider and active account before target lookup/export. Preserve string ids and canonical chat addresses. Telegram personal channels/supergroups export a thread-aware individual-message link via the adapter; dialogs/basic groups/Saved Messages return unavailable/unsupported_chat. MAX personal returns unavailable/unsupported_provider after validating a stored target. Offline validates a stored message and returns unavailable/offline, never connects. No message content in link result, no read acknowledgement, invite or membership change.

Add an optional permalink port and an additive service method. CLI and MCP use one service. Existing adapters/fakes remain compatible. Bot support is a later slice. Test provider/account mismatch before remote lookup, offline/store fallback and missing target, machine output, wrapper lifecycle, Telegram exact-id lookup and export flags/errors. Update docs, manifest, matrices and skills in both CLIs; publish shared prerequisite before exact consumer pins. Consumer binary releases and live checks are separate.

Source: [Telegram exportMessageLink](https://core.telegram.org/method/channels.exportMessageLink), [message link syntax](https://core.telegram.org/api/links#message-links). Telegram syntax stays in its adapter, never here.
