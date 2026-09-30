import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@leemour/cli-core"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter, Transcript } from "../cli/messenger/port.js"
import type { Message } from "../domain/models.js"
import { hearVoices, isVoice, type Kept, keyOf, openKept, spoken, withTranscript } from "./hearing.js"
import { speechModel } from "./models.js"

const messenger = {
  app: { command: "chat", appName: "chat-cli", envPrefix: "CHAT" },
  provider: "chat",
} as unknown as Messenger

const voice = (id: string): Message => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-09-29T10:00:00.000Z",
  editedAt: null,
  text: "",
  outgoing: false,
  attachments: [{ kind: "voice", mime: "audio/ogg", duration: 3 }],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const memory = (): Kept & { rows: Map<string, string> } => {
  const rows = new Map<string, string>()
  return {
    rows,
    get: (one) => rows.get(keyOf(one)),
    keep: (one, text) => {
      if (text.trim() !== "") rows.set(keyOf(one), text)
    },
    close: () => {},
  }
}

const telegram = (answer: (id: string) => Transcript | Error) =>
  ({
    transcribe: async (_chat: string, id: string) => {
      const found = answer(id)
      if (found instanceof Error) throw found
      return found
    },
  }) as unknown as MessengerAdapter

const choice = {
  with: "messenger" as const,
  model: speechModel("parakeet-v3"),
  directory: mkdtempSync(join(tmpdir(), "models-")),
}

describe("hearing voice messages in a list", () => {
  it("**shows a kept transcript without asking anyone**", async () => {
    const kept = memory()
    kept.keep({ chatId: "7", messageId: "1" }, "kept before", "telegram")

    const hearing = await hearVoices(messenger, [voice("1"), voice("2")], kept)

    expect(hearing).toEqual({ transcripts: new Map([["7/1", "kept before"]]), unheard: [] })
  })

  it("**hears the rest with --transcribe and keeps only finished text**; pending and refused ones are unheard", async () => {
    const kept = memory()
    const adapter = telegram((id) =>
      id === "1"
        ? { text: "hello", pending: false }
        : id === "2"
          ? { text: "", pending: true }
          : new CliError("provider_error", "no voice"),
    )

    const hearing = await hearVoices(messenger, [voice("1"), voice("2"), voice("3")], kept, {
      choice,
      connect: (work) => work(adapter),
    })

    expect(hearing.transcripts.get("7/1")).toBe("hello")
    expect(hearing.unheard).toEqual([
      { chatId: "7", messageId: "2" },
      { chatId: "7", messageId: "3" },
    ])
    expect(hearing.problem).toBe("no voice")
    expect([...kept.rows.keys()]).toEqual(["7/1"])
  })

  it("stops asking when the time is up, and says what is left", async () => {
    const hearing = await hearVoices(messenger, [voice("1")], memory(), {
      choice,
      connect: (work) => work(telegram(() => ({ text: "late", pending: false }))),
      budgetMs: 0,
    })

    expect(hearing.unheard).toEqual([{ chatId: "7", messageId: "1" }])
  })

  it("puts the transcript beside the text for a script, and under it for a person", () => {
    const hearing = { transcripts: new Map([["7/1", "hello"]]), unheard: [] }

    expect(withTranscript(voice("1"), hearing)).toMatchObject({ text: "", transcript: "hello" })
    expect(spoken(withTranscript({ ...voice("1"), text: "listen" }, hearing)).text).toBe("listen\n🎤 hello")
    expect(isVoice({ ...voice("1"), attachments: [{ kind: "photo" }] })).toBe(false)
  })

  it("**keeps transcripts per profile in the CLI's own cache**, readable by the owner only", async () => {
    const env = { CHAT_CACHE_DIR: mkdtempSync(join(tmpdir(), "kept-")) }
    const kept = await openKept(messenger, "work", env)
    kept.keep({ chatId: "7", messageId: "1" }, "hello", "gigaam-v3")
    kept.keep({ chatId: "7", messageId: "2" }, "  ", "telegram")
    kept.close()

    const again = await openKept(messenger, "work", env)
    expect(again.get({ chatId: "7", messageId: "1" })).toBe("hello")
    expect(again.get({ chatId: "7", messageId: "2" })).toBeUndefined()
    again.close()
    expect(statSync(join(env.CHAT_CACHE_DIR, "transcripts-work.db")).mode & 0o777).toBe(0o600)
  })
})
