import {
  type CredentialSource,
  Credentials,
  type KeyringStore,
  pathsAreOverridden,
  resolvePaths,
} from "@leemour/cli-core"
import { type AppIdentity, envName } from "../app.js"

export interface BotTokenStoreOptions {
  app: AppIdentity
  profile: string
  env?: NodeJS.ProcessEnv
  keyring?: KeyringStore
  configDir?: string
}

/**
 * A bot token per profile, beside — never inside — the personal session: keyring account
 * `bot:<profile>` under the app's own service, `<PREFIX>_BOT_TOKEN`, then a 0600 file.
 */
export class BotTokenStore {
  readonly profile: string
  readonly #account: string
  readonly #credentials: Credentials

  constructor({ app, profile, env = process.env, keyring, configDir }: BotTokenStoreOptions) {
    const where = { appName: app.appName, prefix: app.envPrefix, env }
    this.profile = profile
    this.#account = `bot:${profile}`
    this.#credentials = new Credentials({
      configDir: configDir ?? resolvePaths(where).config,
      service: app.appName,
      envVar: envName(app, "BOT_TOKEN"),
      isolated: pathsAreOverridden(where),
      ...(keyring ? { keyring } : {}),
      env,
      warn: (message) => process.stderr.write(`${message}\n`),
    })
  }

  read(): { token: string; source: CredentialSource } | undefined {
    const stored = this.#credentials.read(this.#account)
    return stored ? { token: stored.secret, source: stored.source } : undefined
  }

  write(token: string): CredentialSource {
    return this.#credentials.write(this.#account, token)
  }

  remove(): CredentialSource[] {
    return this.#credentials.remove(this.#account)
  }
}
