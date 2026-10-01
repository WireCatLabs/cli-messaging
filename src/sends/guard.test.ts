import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { sendGuard } from "./guard.js"
import { SendJournal, sendsPathFor as sendsPath } from "./journal.js"
import { RecipientList, recipientsPathFor as recipientsPath } from "./recipients.js"
import { newSendId } from "./send-id.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "0" }
const env = { APP_STATE_DIR: mkdtempSync(join(tmpdir(), "app-sends-")) }
const sendsPathFor = (profile: string) => sendsPath(app, profile, env)
const recipientsPathFor = (profile: string) => recipientsPath(app, profile, env)

describe("the send guard", () => {
  const guardAt = (profile: string, time: string, sendsPerHour: number) =>
    sendGuard({
      profile,
      readOnly: false,
      readOnlyFrom: "default",
      sendsPerHour,
      journal: new SendJournal(sendsPathFor(profile)),
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      warn: () => {},
      now: () => new Date(time),
    })

  it("forgets sends older than an hour, and names the moment the limit opens again", () => {
    const journal = new SendJournal(sendsPathFor("g-window"))
    for (const at of ["2026-09-24T08:00:00Z", "2026-09-24T09:10:00Z", "2026-09-24T09:20:00Z", "2026-09-24T09:30:00Z"]) {
      journal.append({ at, profile: "g-window", chatId: "111", outcome: "sent" })
    }

    expect(() =>
      guardAt("g-window", "2026-09-24T09:40:00Z", 4).check({ chatId: "111" }, { reserve: false }),
    ).not.toThrow()
    // Lowered below what the hour holds: it opens when enough sends have aged out, not the first.
    expect(() => guardAt("g-window", "2026-09-24T09:40:00Z", 2).check({ chatId: "111" })).toThrow(
      "at 2026-09-24T10:20:00.000Z",
    )
  })
})

describe("two senders at once", () => {
  const guard = (profile: string, sendsPerHour: number, time = "2026-09-24T09:00:00Z") =>
    sendGuard({
      profile,
      readOnly: false,
      readOnlyFrom: "default",
      sendsPerHour,
      journal: new SendJournal(sendsPathFor(profile)),
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      warn: () => {},
      now: () => new Date(time),
    })

  it("at the limit, only one passes: the first holds its place while its send is on the way", () => {
    const first = guard("g-race", 1)
    const second = guard("g-race", 1)

    expect(() => first.check({ chatId: "111" })).not.toThrow()
    expect(() => second.check({ chatId: "111" })).toThrow("the next send is possible")

    first.record({ chatId: "111", outcome: "sent" })
    expect(new SendJournal(sendsPathFor("g-race")).entries()).toMatchObject([{ chatId: "111", outcome: "sent" }])
  })

  it("gives the place back when the send failed", () => {
    const first = guard("g-race-failed", 1)
    first.check({ chatId: "111" })
    first.record({ chatId: "111", outcome: "failed" })

    expect(() => guard("g-race-failed", 1).check({ chatId: "111" })).not.toThrow()
  })

  it("waits out a lock another process holds, and clears one a dead process left", () => {
    const lock = `${sendsPathFor("g-lock")}.lock`
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, "")
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))

    expect(() => guard("g-lock", 1).check({ chatId: "111" })).not.toThrow()
    expect(existsSync(lock)).toBe(false)
  })

  it("counts a scheduled message in the hour it goes out, not the hour it was queued", () => {
    const at = "2026-09-24T09:00:00Z"
    guard("g-later", 1, at).check({ chatId: "111", scheduledFor: "2026-09-24T15:00:00Z" })

    expect(() => guard("g-later", 1, at).check({ chatId: "111" })).not.toThrow()
    expect(() => guard("g-later-2", 1, at).check({ chatId: "111", scheduledFor: "2026-09-24T15:00:00Z" })).not.toThrow()
    expect(() => guard("g-later-2", 1, at).check({ chatId: "111", scheduledFor: "2026-09-24T15:30:00Z" })).toThrow(
      "the next send is possible",
    )
  })

  it("counts each person added to a group, and refuses more at once than the limit", () => {
    expect(() =>
      guard("g-people", 2).check({ chatId: "111", kind: "chat", action: "members.add", personIds: ["1", "2", "3"] }),
    ).toThrow("3 at once is more than the hourly limit")
  })
})

describe("a reaction", () => {
  const guardFor = (profile: string, options: { readOnly?: boolean; sendsPerHour?: number } = {}) =>
    sendGuard({
      profile,
      readOnly: options.readOnly ?? false,
      readOnlyFrom: "config file",
      sendsPerHour: options.sendsPerHour ?? 1,
      journal: new SendJournal(sendsPathFor(profile)),
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      warn: () => {},
    })

  it("is refused by a read-only profile and by the recipient list, but not counted by the limit", () => {
    expect(() => guardFor("g-react-ro", { readOnly: true }).check({ chatId: "111", kind: "reaction" })).toThrow(
      "cannot send, react, change chats or change the account",
    )

    new RecipientList(recipientsPathFor("g-react-list"), app.command).add({
      id: "111",
      title: null,
      addedAt: "2026-09-24T00:00:00Z",
    })
    expect(() => guardFor("g-react-list").check({ chatId: "222", kind: "reaction" })).toThrow(
      /not on the recipient list.*`app g-react-list recipients add 222`/s,
    )

    const journal = new SendJournal(sendsPathFor("g-react-limit"))
    journal.append({
      at: new Date().toISOString(),
      profile: "g-react-limit",
      chatId: "111",
      outcome: "sent",
      kind: "reaction",
    })
    expect(() => guardFor("g-react-limit").check({ chatId: "111", kind: "message" })).not.toThrow()
    journal.append({ at: new Date().toISOString(), profile: "g-react-limit", chatId: "111", outcome: "sent" })
    expect(() => guardFor("g-react-limit").check({ chatId: "111", kind: "reaction" })).not.toThrow()
    expect(() => guardFor("g-react-limit").check({ chatId: "111", kind: "message" })).toThrow(
      "the next send is possible",
    )
  })
})

describe("a retry of a send whose outcome was unknown", () => {
  const guard = (profile: string) =>
    sendGuard({
      profile,
      readOnly: false,
      readOnlyFrom: "default",
      sendsPerHour: 1,
      journal: new SendJournal(sendsPathFor(profile)),
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      warn: () => {},
    })

  it("is not a second send when it repeats the send id in the same chat", () => {
    const first = guard("g-retry")
    first.check({ chatId: "-1001", sendId: "-42" })
    first.record({ chatId: "-1001", outcome: "outcome_unknown", sendId: "-42" })

    expect(() => guard("g-retry").check({ chatId: "-1001", sendId: "-42" })).not.toThrow()
    expect(() => guard("g-retry").check({ chatId: "-1001", sendId: "-43" })).toThrow("the next send is possible")
  })
})

describe("an allow-list refusal", () => {
  const refused = (allowFix?: string) =>
    sendGuard({
      profile: "work",
      command: "max",
      readOnly: false,
      readOnlyFrom: "default",
      allow: ["reaction"],
      allowFrom: "config file: personal.defaults",
      ...(allowFix ? { allowFix } : {}),
      sendsPerHour: 10,
      journal: new SendJournal(sendsPathFor("g-allow")),
      recipients: new RecipientList(recipientsPathFor("g-allow"), app.command),
      warn: () => {},
    })

  it("names the command that allows it, the CLI's own when it gives one", () => {
    expect(() => refused().check({ chatId: "1" })).toThrow("to allow it: max work config set allow reaction,send")
    expect(() => refused("max config set --personal --defaults allow").check({ chatId: "1" })).toThrow(
      "to allow it: max config set --personal --defaults allow reaction,send",
    )
  })
})

describe("the journal written by max-cli before it was shared", () => {
  it("reads its numeric cid as the send id", () => {
    const journal = new SendJournal(sendsPathFor("g-cid"))
    journal.append({ at: "2026-09-24T08:00:00Z", profile: "g-cid", chatId: "1", outcome: "sent", cid: 77 } as never)

    expect(journal.entries()).toEqual([
      { at: "2026-09-24T08:00:00Z", profile: "g-cid", chatId: "1", outcome: "sent", sendId: "77" },
    ])
  })
})

describe("a send id", () => {
  it("is a signed 64-bit integer as a string, new every time", () => {
    const ids = new Set(Array.from({ length: 50 }, newSendId))
    expect(ids.size).toBe(50)
    for (const id of ids) {
      expect(id).toMatch(/^-?\d{1,19}$/)
      expect(BigInt(id) >= -(2n ** 63n) && BigInt(id) < 2n ** 63n).toBe(true)
    }
  })
})
