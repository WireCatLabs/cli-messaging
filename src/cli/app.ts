/** Who a messenger CLI is: the word people type, where its files live, what its variables start with. */
export interface AppIdentity {
  /** `tg`, `max` — in usage lines and in every message that tells somebody what to type. */
  command: string
  /** `tg-cli` — the directory name under the OS conventions, and the keyring service. */
  appName: string
  /** `TG` gives `TG_PROFILE`, `TG_TIMEOUT`, `TG_CONFIG_DIR`… */
  envPrefix: string
  description: string
  version: string
}

export const envName = (app: AppIdentity, name: string): string => `${app.envPrefix}_${name}`
