import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths, writeSecurely } from "@leemour/cli-core"
import type { Provider } from "../../domain/models.js"
import type { AccountKey } from "../../store/store.js"
import type { AppIdentity } from "../app.js"

/** Which account a profile is, remembered so `--offline` can find its rows without connecting. */
export const accountFileFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "accounts", `${profile}.json`)

export const rememberAccount = (app: AppIdentity, profile: string, id: string, env: NodeJS.ProcessEnv): void =>
  writeSecurely(accountFileFor(app, profile, env), `${JSON.stringify({ account: id })}\n`, 0o600)

export const recalledAccount = (
  app: AppIdentity,
  provider: Provider,
  profile: string,
  env: NodeJS.ProcessEnv,
): AccountKey | undefined => {
  try {
    const { account } = JSON.parse(readFileSync(accountFileFor(app, profile, env), "utf8")) as { account?: unknown }
    return typeof account === "string" ? { provider, account } : undefined
  } catch {
    return undefined
  }
}
