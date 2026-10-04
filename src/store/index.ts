export type { CacheDatabase, CacheStatement, OpenDatabase, SqlValue } from "./driver.js"
export { PRAGMAS } from "./driver.js"
export { MIGRATIONS, type Migration, migrate } from "./migrations.js"
export { openCache } from "./open.js"
export { storePath } from "./path.js"
export { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
export {
  fillSearchIndex,
  resetSearchIndex,
  type SearchIndexFill,
  type SearchIndexState,
  searchIndexState,
} from "./sqlite/search-index.js"
export {
  type AccountKey,
  type ChatStats,
  type DeletionScope,
  type Delta,
  type IdentityRef,
  type IngestedVia,
  type LinkedIdentity,
  type LinkOptions,
  type MessageFilter,
  type MessageStore,
  openStore,
  type PersonFacts,
  type PersonRecord,
  type Range,
  type StoredChatFilter,
  type StoredHit,
  type StoreOptions,
} from "./store.js"
