/**
 * What one account on one messenger can do, said up front so a command checks before it asks
 * instead of calling and catching. A bot account is a messenger too, with less: no history, and a
 * chat list made only of the chats it has seen (max-cli `NEED-301`).
 *
 * Only fields some command reads are here; the list grows with the commands that need it.
 */
export interface Capabilities {
  /** Whether past messages can be fetched at all. A bot sees only what arrives while it listens. */
  history: boolean
  /** `server` — the provider lists the chats; `observed` — only chats the store has seen. */
  chatList: "server" | "observed"
  /** `push` — a live connection; `poll` — long polling or a webhook; `none` — ask again later. */
  realtime: "push" | "poll" | "none"
  send: boolean
  edit: boolean
  delete: boolean
  react: boolean
  /** Topics or threads inside one chat. */
  threads: boolean
}
