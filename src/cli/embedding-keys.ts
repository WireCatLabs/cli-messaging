import { type CredentialSource, Credentials, pathsAreOverridden, resolvePaths } from "@leemour/cli-core"
import { type AppIdentity, envName } from "./app.js"

/**
 * An embedding provider's API key (phase 5 E11), kept as bot tokens are: the keyring account
 * `embeddings:<provider>` under the app's own service, then `<PREFIX>_OPENAI_API_KEY` or OpenAI's own
 * `OPENAI_API_KEY` for `openai`, then a 0600 file. Never printed, never in an error.
 */
export const embeddingKeys = (app: AppIdentity, env: NodeJS.ProcessEnv = process.env) => {
  const where = { appName: app.appName, prefix: app.envPrefix, env }
  const credentials = (provider: string) =>
    new Credentials({
      configDir: resolvePaths(where).config,
      service: app.appName,
      ...(provider === "openai" ? { envVar: envName(app, "OPENAI_API_KEY") } : {}),
      isolated: pathsAreOverridden(where),
      env,
      warn: (message) => process.stderr.write(`${message}\n`),
    })
  const account = (provider: string) => `embeddings:${provider}`
  return {
    read: (provider: string): { key: string; source: CredentialSource | "env" } | undefined => {
      const stored = credentials(provider).read(account(provider))
      if (stored) return { key: stored.secret, source: stored.source }
      const shared = provider === "openai" ? env.OPENAI_API_KEY?.trim() : undefined
      return shared ? { key: shared, source: "env" } : undefined
    },
    write: (provider: string, key: string): CredentialSource => credentials(provider).write(account(provider), key),
    remove: (provider: string): CredentialSource[] => credentials(provider).remove(account(provider)),
  }
}
