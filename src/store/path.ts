import { join } from "node:path"
import { resolvePaths } from "@wirecat/cli-core"

/**
 * One file for every messenger and account. `MESSAGING_STORE` is read here and nowhere else: the
 * test sandbox and `bin/tg` point it away from the owner's real file.
 */
export const storePath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.MESSAGING_STORE ?? join(resolvePaths({ appName: "cli-messaging", prefix: "MESSAGING", env }).state, "messages.db")
