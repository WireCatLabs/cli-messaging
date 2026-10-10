import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { migrate } from "./migrations.js"
import { type EmailInput, mailStoreOver, type ThreadSave } from "./sqlite/emails.js"
import { openSqlite } from "./sqlite/open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})

const freshPath = () => join(mkdtempSync(join(tmpdir(), "mail-")), "store.db")

const seeded = async () => {
  const { database } = await openSqlite(freshPath())
  opened.push(database)
  migrate(database)
  database
    .prepare("INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)")
    .run(1, "email", "owner@example.com", "Owner Example")
  return { database, mail: mailStoreOver({ database }) }
}

const email = (overrides: Partial<EmailInput> = {}): EmailInput => ({
  externalId: "<first@example.com>",
  subject: "Quarterly planning",
  from: { address: "Alice@Example.com", name: "Alice Example" },
  to: [{ address: "owner@example.com", name: null }],
  cc: [{ address: "bob@example.com", name: "Bob Sample" }],
  sentAt: 1000,
  receivedAt: 1100,
  references: [],
  bodyText: "Let us agree on the roadmap.",
  outgoing: false,
  read: true,
  mailboxes: [{ externalId: "INBOX", name: "Inbox", kind: "inbox" }],
  ...overrides,
})

const thread = (emails: EmailInput[], now = 2000): ThreadSave => ({ accountId: 1, externalId: "thread-1", emails, now })

describe("mail store", () => {
  it("saves a thread with its emails, recipients and mailboxes, and a resave changes nothing", async () => {
    const { mail } = await seeded()
    const first = await mail.saveThread(thread([email()]))
    expect(first.thread).toMatchObject({ subject: "Quarterly planning", emailsCount: 1, lastEmailAt: 1000 })
    const [saved] = first.emails
    expect(saved).toMatchObject({ fromAddress: "alice@example.com", read: true, outgoing: false, references: [] })
    expect(saved?.recipients.map(({ address, role, position }) => [address, role, position])).toEqual([
      ["owner@example.com", "to", 0],
      ["bob@example.com", "cc", 1],
    ])
    expect(saved?.mailboxes.map(({ externalId }) => externalId)).toEqual(["INBOX"])

    const again = await mail.saveThread(thread([email()], 3000))
    expect(again.thread.id).toBe(first.thread.id)
    expect(again.emails.map(({ id }) => id)).toEqual(first.emails.map(({ id }) => id))
    expect(again.emails[0]?.recipients).toEqual(saved?.recipients)
    expect(again.thread.emailsCount).toBe(1)
    expect(await mail.thread(first.thread.id)).toEqual(again)
  })

  it("adds replies and mailboxes, keeps the thread's subject and time, and reads by Message-ID", async () => {
    const { mail } = await seeded()
    const reply = email({ subject: "Re: Quarterly planning", externalId: "<reply@example.com>", sentAt: 5000 })
    await mail.saveThread(thread([reply, email()]))
    const details = await mail.saveThread(
      thread([email({ mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }] })], 6000),
    )
    expect(details.thread).toMatchObject({ subject: "Quarterly planning", emailsCount: 2, lastEmailAt: 5000 })
    expect(details.emails.map(({ externalId }) => externalId)).toEqual(["<first@example.com>", "<reply@example.com>"])
    expect((await mail.email(1, "<first@example.com>"))?.mailboxes.map(({ name }) => name)).toEqual([
      "Inbox",
      "Projects",
    ])
    expect(await mail.email(1, "<missing@example.com>")).toBeNull()
    expect((await mail.threads({ accountId: 1 })).map(({ id }) => id)).toEqual([details.thread.id])
    expect(await mail.threads({ accountId: 2 })).toEqual([])
  })

  it("searches subjects and bodies by word prefix, and an email marked deleted leaves the results", async () => {
    const { mail } = await seeded()
    await mail.saveThread(
      thread([email(), email({ externalId: "<second@example.com>", subject: "Lunch", bodyText: "Pizza on Friday" })]),
    )
    expect((await mail.search("quarterly")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])
    expect((await mail.search("roadm")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])
    expect((await mail.search("pizza friday")).map(({ externalId }) => externalId)).toEqual(["<second@example.com>"])
    expect(await mail.search("  ")).toEqual([])

    expect(await mail.markDeleted(1, ["<second@example.com>"], 7000)).toBe(1)
    expect(await mail.search("pizza")).toEqual([])
    expect((await mail.threads())[0]?.emailsCount).toBe(1)

    await mail.saveThread(thread([email({ bodyText: "The roadmap changed to a timeline." })], 8000))
    expect((await mail.search("timeline")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])

    await mail.markDeleted(1, ["<first@example.com>"], 9000)
    expect(await mail.threads()).toEqual([])
    expect((await mail.threads({ includeDeleted: true }))[0]?.deletedAt).toBe(9000)
  })

  it("refuses an empty key and leaves nothing behind", async () => {
    const { mail } = await seeded()
    await expect(mail.saveThread(thread([email(), email({ externalId: "" })]))).rejects.toThrow("Invalid email key")
    expect(await mail.threads({ includeDeleted: true })).toEqual([])
    await expect(mail.saveThread({ ...thread([]), externalId: "" })).rejects.toThrow("Invalid thread key")
  })

  it("is the shared store's mail, built on first use", async () => {
    const store = await openStore({ path: freshPath() })
    opened.push(store)
    expect(await store.mail.threads()).toEqual([])
    expect(store.mail).toBe(store.mail)
  })
})
