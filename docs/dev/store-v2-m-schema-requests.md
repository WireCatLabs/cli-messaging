# Messaging core schema requests

## Retain exact roster observations

The baseline dropped `membership_batches` and `membership_batch_members`. Materialized `member_stays` and daily
`member_counts` cannot reconstruct each identity's presence at each read. For example, a partial roster observes
Alice Example at day 1.25 and a later roster observes her at day 7.5. The stay retains day 7.5 as `last_seen_at`;
the count at day 1.25 retains only how many people were listed. The day-one checkpoint must now be unknown.

To preserve exact checkpoint evidence, request two tables following v2 naming:

- `member_observations`: integer `id`, `chat_id`, `observed_at`, optional `started_at`, `complete`, `reported_count`,
  `listed_count`, `source`, `created_at`, `updated_at`; index `(chat_id, observed_at, id)`.
- `member_observation_members`: `member_observation_id`, `identity_id`, `member_stay_id`; composite primary key
  `(member_observation_id, identity_id)` and an index on `member_stay_id`.

The core currently reports only evidence retained by stays. Adding these tables would let roster writes preserve
all explicit observations and retention distinguish partial absence from complete absence at historical
checkpoints. The regression fixture in `src/store/retention.test.ts` demonstrates the information loss.

## Enforce one displayed alias

Request a unique expression index on `(aliasable_type, aliasable_id, coalesce(account_id, 0))` where `display = 1`.
The current schema has lookup indexes but permits two displayed aliases for the same thing and account. The contact
API serializes its replacement in a transaction; a database constraint should protect every writer.
