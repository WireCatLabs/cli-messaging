import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Chat, GroupCard } from "../../domain/models.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountCommand } from "./account-command.js"
import { chatsCommand } from "./chats-command.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 3,
}
const card = (id: string, title: string): GroupCard => ({
  ...chat,
  id,
  title,
  description: null,
  link: null,
  settings: {
    allCanPin: null,
    onlyAdminsAdd: null,
    onlyAdminsCall: null,
    onlyOwnerEditsInfo: null,
    membersSeeLink: null,
  },
})

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "admin-"))
  return {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

const call = async (
  argv: string[],
  adapter: MessengerAdapter,
  env: NodeJS.ProcessEnv,
  own: Partial<Messenger> = {},
) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => adapter,
    chatArgument: "a chat",
    ...own,
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [chatsCommand(messenger), contactsCommand(messenger), accountCommand(messenger)] },
    { streams, tty: false, env },
  )
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

const base: MessengerAdapter = {
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat], hasMore: false }),
  history: async () => ({ items: [], hasMore: false }),
  resolve: async () => chat,
  chat: async () => ({ ...chat, members: null }),
  contact: async () => ({ id: "9", name: "Olga", username: null, description: null, lastMessagedAt: null, chats: [] }),
  around: async () => [],
  send: async () => {
    throw new Error("never sends")
  },
  logout: async () => {},
  close: async () => {},
}

describe("chats create, join and leave", () => {
  it("**creates a group with the people resolved to ids**, through the guard, and journals no title", async () => {
    const env = sandbox()
    const created: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      people: async (references) => references.map((_, index) => String(90 + index)),
      createGroup: async (title, people, options) => {
        created.push([title, people, options])
        return card("70", title)
      },
    }

    const made = await call(["chats", "create", "Secret plans", "Olga", "@ivan", "--json"], adapter, env)

    expect(made.code).toBe(0)
    const answer = JSON.parse(made.stdout[0] ?? "")
    expect(answer).toMatchObject({ operationId: expect.any(String), chat: { id: "70", title: "Secret plans" } })
    expect(created).toEqual([["Secret plans", ["90", "91"], { channel: false }]])
    const [entry] = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entry).toMatchObject({ kind: "chat", action: "create", chatId: "70", people: 2, outcome: "sent" })
    expect(JSON.stringify(entry)).not.toContain("Secret plans")
  })

  it("**refuses to add someone the recipient list does not name**, and creates nothing", async () => {
    const env = sandbox()
    mkdirSync(join(env.CHAT_STATE_DIR, "profiles"), { recursive: true })
    writeFileSync(
      join(env.CHAT_STATE_DIR, "profiles", "default.recipients.json"),
      JSON.stringify({ chats: [{ id: "7", title: "Book club", partnerId: null }] }),
    )
    let created = 0
    const adapter: MessengerAdapter = {
      ...base,
      people: async () => ["91"],
      createGroup: async (title) => {
        created += 1
        return card("70", title)
      },
    }

    const refused = await call(["chats", "create", "Plans", "Ivan"], adapter, env)

    expect(refused.code).toBe(7)
    expect(created).toBe(0)
  })

  it("**joins by link and leaves by name**, each answering with its operation id", async () => {
    const env = sandbox()
    const left: string[] = []
    const adapter: MessengerAdapter = {
      ...base,
      join: async () => card("71", "Joined"),
      leave: async (chatId) => {
        left.push(chatId)
        return { chatId }
      },
    }

    const joined = await call(["chats", "join", "https://t.me/+abc", "--json"], adapter, env)
    const gone = await call(["chats", "leave", "Book club", "--json"], adapter, env)

    expect(JSON.parse(joined.stdout[0] ?? "")).toMatchObject({ operationId: expect.any(String), chat: { id: "71" } })
    expect(JSON.parse(gone.stdout[0] ?? "")).toEqual({ operationId: expect.any(String), chatId: "7" })
    expect(left).toEqual(["7"])
  })

  it("**says plainly when the messenger cannot do it**", async () => {
    const refused = await call(["chats", "leave", "Book club"], base, sandbox())

    expect(refused.code).toBe(2)
    expect(refused.stderr.join("\n")).toContain("this messenger cannot leave a chat")
  })

  it("**changes a title and a setting in one write**, and offers only the settings the messenger has", async () => {
    const env = sandbox()
    const changes: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      updateGroup: async (chatId, change) => {
        changes.push([chatId, change])
        return card(chatId, change.title ?? "Book club")
      },
    }
    const telegram = { groupSettings: ["allCanPin", "onlyAdminsAdd"] as const }

    const renamed = await call(
      ["chats", "update", "Book club", "--title", "Books", "--all-can-pin", "on", "--json"],
      adapter,
      env,
      telegram,
    )
    const quiet = await call(["chats", "update", "Book club", "--only-admins-add", "off"], adapter, env, telegram)
    const missing = await call(["chats", "update", "Book club", "--only-admins-call", "on"], adapter, env, telegram)
    const unclear = await call(["chats", "update", "Book club", "--all-can-pin", "yes"], adapter, env)
    const empty = await call(["chats", "update", "Book club"], adapter, env)

    expect(JSON.parse(renamed.stdout[0] ?? "")).toMatchObject({
      operationId: expect.any(String),
      chat: { title: "Books" },
    })
    expect(changes).toEqual([
      ["7", { title: "Books", settings: { allCanPin: true } }],
      ["7", { settings: { onlyAdminsAdd: false } }],
    ])
    expect([quiet.code, unclear.code, empty.code]).toEqual([0, 2, 2])
    expect(missing.stderr.join("\n")).toContain("unknown option '--only-admins-call'")
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries().map((one) => one.action)).toEqual([
      "update",
      "settings",
    ])
  })

  it("**shows the invite link, or says it is hidden**, and journals a reset", async () => {
    const env = sandbox()
    let link: string | null = null
    const adapter: MessengerAdapter = {
      ...base,
      group: async () => ({ ...card("7", "Book club"), link }),
      resetInviteLink: async (chatId) => ({ ...card(chatId, "Book club"), link: "https://t.me/+new" }),
    }

    const hidden = await call(["chats", "link", "show", "Book club"], adapter, env)
    link = "https://t.me/+old"
    const shown = await call(["chats", "link", "show", "Book club", "--json"], adapter, env)
    const reset = await call(["chats", "link", "reset", "Book club", "--json"], adapter, env)
    const card7 = await call(["chats", "show", "Book club", "--json"], adapter, env)

    expect(hidden.code).toBe(6)
    expect(JSON.parse(shown.stdout[0] ?? "")).toEqual({ chatId: "7", title: "Book club", link: "https://t.me/+old" })
    expect(JSON.parse(reset.stdout[0] ?? "")).toMatchObject({ chat: { link: "https://t.me/+new" } })
    expect(JSON.parse(card7.stdout[0] ?? "")).toMatchObject({
      link: "https://t.me/+old",
      settings: { allCanPin: null },
    })
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([
      { kind: "chat", action: "link.reset", chatId: "7", outcome: "sent" },
    ])
  })

  it("**adds and removes people through the guard**, naming who could not be added", async () => {
    const env = sandbox()
    const done: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      people: async (references) => references.map((_, index) => String(91 + index)),
      addMembers: async (chatId, people, options) => {
        done.push(["add", chatId, people, options])
        return { notAdded: ["92"] }
      },
      removeMembers: async (chatId, people) => {
        done.push(["remove", chatId, people])
      },
    }

    const added = await call(
      ["chats", "members", "add", "Book club", "Ivan", "Olga", "--history", "--json"],
      adapter,
      env,
    )
    const removed = await call(["chats", "members", "remove", "Book club", "Ivan", "--json"], adapter, env)
    const noHistory = await call(["chats", "members", "add", "Book club", "Ivan", "--history"], adapter, env, {
      addsWithHistory: false,
    })

    expect(JSON.parse(added.stdout[0] ?? "")).toEqual({
      operationId: expect.any(String),
      chatId: "7",
      added: ["91"],
      notAdded: ["92"],
    })
    expect(JSON.parse(removed.stdout[0] ?? "")).toMatchObject({ chatId: "7", removed: ["91"] })
    expect(noHistory.stderr.join("\n")).toContain("unknown option '--history'")
    expect(done).toEqual([
      ["add", "7", ["91", "92"], { history: true }],
      ["remove", "7", ["91"]],
    ])
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([
      { action: "members.add", people: 2 },
      { action: "members.remove", people: 1 },
    ])
  })

  it("**makes an admin with the rights the messenger has**, and takes them back", async () => {
    const env = sandbox()
    const done: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      people: async () => ["91"],
      addAdmin: async (chatId, person, rights) => {
        done.push(["add", chatId, person, rights])
      },
      removeAdmin: async (chatId, person) => {
        done.push(["remove", chatId, person])
      },
    }
    const telegram = { adminRights: ["members", "pin"] as const }

    const made = await call(
      ["chats", "admins", "add", "Book club", "Ivan", "--can", "pin, members", "--json"],
      adapter,
      env,
      telegram,
    )
    const unknown = await call(["chats", "admins", "add", "Book club", "Ivan", "--can", "read"], adapter, env, telegram)
    const taken = await call(["chats", "admins", "remove", "Book club", "Ivan", "--json"], adapter, env)

    expect(JSON.parse(made.stdout[0] ?? "")).toMatchObject({ chatId: "7", personId: "91", rights: ["pin", "members"] })
    expect(unknown.code).toBe(2)
    expect(unknown.stderr.join("\n")).toContain("not read")
    expect(taken.code).toBe(0)
    expect(done).toEqual([
      ["add", "7", "91", ["pin", "members"]],
      ["remove", "7", "91"],
    ])
  })

  it("**changes chat folders through the guard**, a folder named by its title, and refuses one it cannot tell apart", async () => {
    const env = sandbox()
    const done: unknown[] = []
    const folders = [
      { id: "4", title: "Work", chatIds: [] },
      { id: "5", title: "Twins", chatIds: [] },
      { id: "6", title: "Twins", chatIds: [] },
    ]
    const adapter: MessengerAdapter = {
      ...base,
      folders: async () => folders,
      createFolder: async (title, chatIds) => {
        done.push(["create", title, chatIds])
        return { id: "9", title, chatIds }
      },
      updateFolder: async (id, change) => {
        done.push(["update", id, change])
        return { id, title: change.title ?? "Work", chatIds: [] }
      },
      deleteFolder: async (id) => {
        done.push(["delete", id])
      },
    }

    const listed = await call(["chats", "folders", "list", "--json"], adapter, env)
    const made = await call(["chats", "folders", "create", "Home", "--chat", "Book club", "--json"], adapter, env)
    const renamed = await call(
      ["chats", "folders", "update", "Work", "--title", "Job", "--add", "Book club"],
      adapter,
      env,
    )
    const unclear = await call(["chats", "folders", "delete", "Twins"], adapter, env)
    const missing = await call(["chats", "folders", "delete", "Nope"], adapter, env)
    const empty = await call(["chats", "folders", "update", "Work"], adapter, env)
    const deleted = await call(["chats", "folders", "delete", "6", "--json"], adapter, env)

    expect(JSON.parse(listed.stdout[0] ?? "").items).toHaveLength(3)
    expect(JSON.parse(made.stdout[0] ?? "")).toMatchObject({ folder: { id: "9", chatIds: ["7"] } })
    expect([renamed.code, unclear.code, missing.code, empty.code, deleted.code]).toEqual([0, 2, 6, 2, 0])
    expect(done).toEqual([
      ["create", "Home", ["7"]],
      ["update", "4", { title: "Job", add: ["7"] }],
      ["delete", "6"],
    ])
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries().map((one) => one.action)).toEqual([
      "folder-create",
      "folder-update",
      "folder-delete",
    ])
  })

  it("**changes the address book through the guard**, each as its own account action", async () => {
    const env = sandbox()
    const done: unknown[] = []
    const ivan = { id: "91", name: "Ivan", username: null }
    const adapter: MessengerAdapter = {
      ...base,
      people: async () => ["91"],
      addContact: async (id) => {
        done.push(["add", id])
        return ivan
      },
      removeContact: async (id) => {
        done.push(["remove", id])
      },
      block: async (id) => {
        done.push(["block", id])
      },
      unblock: async (id) => {
        done.push(["unblock", id])
      },
      renameContact: async (id, first, last) => {
        done.push(["rename", id, first, last])
        return { ...ivan, name: `${first} ${last}` }
      },
    }

    const added = await call(["contacts", "add", "Ivan", "--json"], adapter, env)
    for (const verb of ["remove", "block", "unblock"]) await call(["contacts", verb, "Ivan"], adapter, env)
    const renamed = await call(["contacts", "rename", "Ivan", "Vanya", "P.", "--json"], adapter, env)

    expect(JSON.parse(added.stdout[0] ?? "")).toEqual({ operationId: expect.any(String), person: ivan })
    expect(JSON.parse(renamed.stdout[0] ?? "")).toMatchObject({ person: { name: "Vanya P." } })
    expect(done).toEqual([
      ["add", "91"],
      ["remove", "91"],
      ["block", "91"],
      ["unblock", "91"],
      ["rename", "91", "Vanya", "P."],
    ])
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries().map((one) => one.action)).toEqual([
      "contact-add",
      "contact-remove",
      "contact-block",
      "contact-unblock",
      "contact-rename",
    ])
  })

  it("**imports a file of numbers**, never printing or journaling one, and names a bad line by its number", async () => {
    const env = sandbox()
    const root = mkdtempSync(join(tmpdir(), "phones-"))
    const good = join(root, "good.txt")
    const bad = join(root, "bad.txt")
    writeFileSync(good, "+34 600 111 222, Ivan\n\n34600333444\tOlga\n")
    writeFileSync(bad, "34600111222; Ivan\nnot a number, Olga\n")
    const sent: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      importContacts: async (entries) => {
        sent.push(entries)
        return [{ id: "91", name: "Ivan", username: null }]
      },
    }

    const imported = await call(["contacts", "import", good, "--json"], adapter, env)
    const refused = await call(["contacts", "import", bad], adapter, env)

    expect(JSON.parse(imported.stdout[0] ?? "")).toEqual({
      operationId: expect.any(String),
      sent: 2,
      recognised: [{ id: "91", name: "Ivan", username: null }],
    })
    expect(sent).toEqual([
      [
        { phone: "34600111222", name: "Ivan" },
        { phone: "34600333444", name: "Olga" },
      ],
    ])
    expect(refused.code).toBe(2)
    expect(refused.stderr.join("\n")).toContain("line 2")
    expect(refused.stderr.join("\n")).not.toContain("Olga")
    const journal = readFileSync(sendsPathFor(app, "default", env), "utf8")
    expect(journal).toContain('"action":"contact-import"')
    for (const digits of ["600111222", "600333444", "600 111 222"]) expect(journal).not.toContain(digits)
  })

  it("**changes the profile with a photo**, masking the phone, and ends other sessions only with --others", async () => {
    const env = sandbox()
    const root = mkdtempSync(join(tmpdir(), "photo-"))
    const photo = join(root, "me.jpg")
    writeFileSync(photo, new Uint8Array([0xff, 0xd8, 0xff]))
    const changes: unknown[] = []
    const ended: number[] = []
    const adapter: MessengerAdapter = {
      ...base,
      updateProfile: async (change) => {
        changes.push({ ...change, photo: change.photo?.name })
        return { id: "500", name: "New Name", username: null, phone: "34600111222" }
      },
      endOtherSessions: async () => {
        ended.push(1)
        return []
      },
    }

    const updated = await call(
      ["account", "update", "--first-name", "New", "--description", "hi", "--photo", photo, "--json"],
      adapter,
      env,
    )
    const empty = await call(["account", "update"], adapter, env)
    const without = await call(["account", "sessions", "end", "--yes"], adapter, env)
    const unasked = await call(["account", "sessions", "end", "--others"], adapter, env)
    const ended1 = await call(["account", "sessions", "end", "--others", "--yes", "--json"], adapter, env)

    expect(JSON.parse(updated.stdout[0] ?? "")).toMatchObject({ account: { name: "New Name", phone: "***1222" } })
    expect(changes).toEqual([{ firstName: "New", description: "hi", photo: "me.jpg" }])
    expect([empty.code, without.code, unasked.code, ended1.code]).toEqual([2, 2, 7, 0])
    expect(ended).toEqual([1])
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries().map((one) => one.action)).toEqual([
      "profile",
      "sessions-end",
      "sessions-end",
    ])
  })

  it("**moderates a group by its rules**: deletes and removes where they allow, plans what asks, and moves the point", async () => {
    const env = sandbox()
    const done: string[] = []
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const say = (id: string, sender: string, text: string, minutes: number) => ({
      id,
      chatId: "7",
      senderId: sender,
      senderName: `Name ${sender}`,
      timestamp: at(minutes),
      editedAt: null,
      text,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })
    const adapter: MessengerAdapter = {
      ...base,
      historyAfter: async (_chat, window) =>
        "time" in window.after
          ? { items: [say("1", "8", "buy https://spam.example", 30), say("2", "6", "hello", 20)], hasMore: true }
          : { items: [say("3", "8", "again https://spam.example", 10)], hasMore: false },
      chatEvents: async () => ({
        chatId: "7",
        since: at(60),
        events: [
          {
            messageId: "0",
            timestamp: at(40),
            event: "add",
            by: { id: "6", name: null },
            people: [{ id: "9", name: "Bot" }],
          },
        ],
        more: false,
      }),
      members: async () => ({ chatId: "7", items: [{ id: "9", name: "Bot", username: null }], hasMore: false }),
      admins: async () => ["6"],
      delete: async (_chat, ids) => {
        done.push(`delete ${ids.join(",")}`)
      },
      removeMembers: async (_chat, people) => {
        done.push(`remove ${people.join(",")}`)
      },
    }
    const rules = async (...argv: string[]) => call(["chats", "rules", ...argv], adapter, env)

    const unsaved = await rules("show", "Book club", "--json")
    await rules("set", "Book club", "links", "delete")
    await rules("set", "Book club", "blocked", "9")
    await rules("set", "Book club", "blockedPeople", "remove")
    await rules("set", "Book club", "consent.delete", "allow")
    const planned = await call(["chats", "moderate", "Book club", "--json"], adapter, env)
    const acted = await call(["chats", "moderate", "Book club", "--allow-dangerous", "--json"], adapter, env)
    const noAge = await rules("set", "Book club", "newAccount.days", "3")
    const telegram = await call(["chats", "rules", "set", "Book club", "newAccount.days", "3"], adapter, env, {
      knowsAccountAge: false,
    })

    expect(JSON.parse(unsaved.stdout[0] ?? "")).toMatchObject({ chatId: "7", saved: false })
    const first = JSON.parse(planned.stdout[0] ?? "").rows
    expect(first.map((row: { rule: string; outcome: string }) => `${row.rule} ${row.outcome}`)).toEqual([
      "blocked planned",
      "links done",
      "links done",
    ])
    expect(JSON.parse(acted.stdout[0] ?? "").rows.map((row: { outcome: string }) => row.outcome)).toContain("done")
    expect(done).toEqual(["delete 1", "delete 3", "remove 9", "delete 1", "delete 3"])
    expect([noAge.code, telegram.code]).toEqual([0, 2])
    expect(telegram.stderr.join("\n")).toContain("does not say how old an account is")
    const saved = JSON.parse(readFileSync(join(env.CHAT_STATE_DIR, "profiles", "default.moderation.json"), "utf8"))
    expect(Object.keys(saved.checkedUntil ?? {})).toEqual(["7"])
  })

  it("judges a link as an invite by the messenger's own `inviteLinks`", async () => {
    const adapter: MessengerAdapter = {
      ...base,
      historyAfter: async () => ({
        items: [
          {
            id: "1",
            chatId: "7",
            senderId: "8",
            senderName: "Name 8",
            timestamp: new Date().toISOString(),
            editedAt: null,
            text: "join https://chat.whatsapp.com/AbC123",
            outgoing: false,
            attachments: [],
            replyTo: null,
            forwardedFrom: null,
            reactions: null,
          },
        ],
        hasMore: false,
      }),
      chatEvents: async () => ({ chatId: "7", since: new Date().toISOString(), events: [], more: false }),
      admins: async () => [],
    }
    const rule = async (own: Partial<Messenger>) => {
      const { stdout } = await call(["chats", "moderate", "Book club", "--json"], adapter, sandbox(), own)
      return JSON.parse(stdout[0] ?? "").rows.map((row: { rule: string }) => row.rule)
    }

    expect(await rule({})).toEqual(["links"])
    expect(await rule({ inviteLinks: /chat\.whatsapp\.com\// })).toEqual(["invites"])
  })
})

describe("truncated group event reads", () => {
  it("preserves chronological rows and gives guidance without claiming which part of history was returned", async () => {
    const events = [1, 2].map((id) => ({
      messageId: String(id),
      timestamp: new Date(id * 1000).toISOString(),
      event: "add",
      by: { id: "9", name: null },
      people: [],
    }))
    const result = await call(
      ["chats", "events", "7", "--json"],
      {
        ...base,
        chatEvents: async () => ({ chatId: "7", since: new Date(0).toISOString(), events, more: true }),
      },
      sandbox(),
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout.join(""))).toMatchObject({ items: events, hasMore: true })
    expect(result.stderr.join("")).toContain("adjust --since-time")
    expect(result.stderr.join("")).not.toContain("newest")
  })
})
