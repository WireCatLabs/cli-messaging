# Archive preparation — consumer releases and website follow-up

Status, 2026-10-08: Telegram 0.35.0 and MAX 0.34.0 are published. Their registry metadata, release tags
and provenance source commits are verified. The EN/RU/ES website implementation is in
[cli-docs #71](https://github.com/leemour/cli-docs/pull/71); CI/deployment evidence is tracked there.
This record completes the [website handoff](2026-10-08-server-search-website-handoff.md).

## Released behavior and scope

The archive-preparation and coverage contract originated in cli-messaging 0.174.0. Telegram 0.35.0
pins messaging 0.177.0 and MAX 0.34.0 pins 0.176.0; both pin cli-core 0.17.2.

`store fetch --all --background` starts downloading every chat, most recently active first, within a
90-day window unless another boundary is supplied. `--since-time 365d` goes further back. Default run
limits still apply per chat (1,000 for Telegram, 1,200 for MAX); repeat to continue busy histories.
A chat fetched to a time boundary can remain `partial`; that status alone does not trigger `coverage.next`.

Search coverage includes stored message/chat counts, never-fetched and behind chats, up to ten
attention chats and the one suggested next command. An empty answer with `coverage.next` still set
must trigger the suggested fetch or an owner question before a claim that the message does not exist.
MAX's server searches only one named chat. Counts, topic search, filters and MAX search without a chat
still need the downloaded archive.

## Release and documentation evidence

- Telegram: [release PR #346](https://github.com/leemour/tg-cli/pull/346). Notes correct the guidance for the existing
  server-search default and `--backend archive`; stale README/search/query-language and roadmap notes corrected.
- MAX: [release PR #468](https://github.com/leemour/max-cli/pull/468). Search/security/roadmap guidance
  corrected; canonical MCP prompts name current tools and check coverage. Completed MCP surface item CLI-74
  closed; MAX-65 completion (folder order, server logout, group photo) retained from #469–#471.
- Mechanical release checks and synthetic suites are recorded in private signed release reports.
  The owner explicitly accepted the notes, waived fresh live messenger tests and delegated recording the
  report sign-off in this session. No live messenger check is represented as having passed.
- Website: EN/RU/ES archive-preparation and coverage text in [#71](https://github.com/leemour/cli-docs/pull/71),
  scoped to `search-architecture.mdx`; local lint, 208 unit tests, search bundle, export, links/SEO and all
  locale HTML/Markdown content checks passed. The handoff now explains reviewed pins.

## Completed guide follow-up

The owner subsequently requested the full guide update. The website now pins Telegram v0.35.0 and
MAX v0.34.0 with reviewed English, Russian and Spanish guides, per-locale source fingerprints,
start-page links and exact portal errata. The [guide review record](https://github.com/leemour/cli-docs/blob/main/docs/reviews/2026-10-08-reviewed-tool-guides.md) documents the complete
scope: 29 Telegram and 31 MAX pages in all three locales, 117 translation overlays and six start pages.
Publishing a future CLI still does not automatically advance reviewed website pins.

Both minor generated-help gaps are corrected in the delivered website reference: bulk join-request
decline is exempt from the hourly sending allowance; MAX folder ordering keeps All chats first.
Immutable consumer tags retain their original generated strings, so the portal records and applies
these corrections after source-preservation validation. The search-default chronology and stale
join-request roadmap/migration notes are corrected in the same update. No archive-preparation or
guide-review task remains from this handoff.

Guide update and publication: [cli-docs #72](https://github.com/leemour/cli-docs/pull/72).
