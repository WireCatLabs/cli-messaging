import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Chat, GroupCard } from "../../domain/models.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { chatsCommand } from "./chats-command.js"
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
  const code = await run(argv, { app, commands: () => [chatsCommand(messenger)] }, { streams, tty: false, env })
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

    expect(JSON.parse(listed.stdout[0] ?? "")).toHaveLength(3)
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
})
