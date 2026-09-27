import { randomBytes } from "node:crypto"

/**
 * One logical send's identity, made before the request and kept through every retry: a signed
 * 64-bit integer as a string, which is what Telegram's `random_id` takes and what fits MAX's `cid`.
 */
export const newSendId = (): string => randomBytes(8).readBigInt64BE().toString()
