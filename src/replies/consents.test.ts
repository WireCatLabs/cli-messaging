import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  mayModelReply,
  readReplyConsent,
  replyConsentPathFor,
  replyModelIdentity,
  writeReplyConsent,
} from "./consents.js"

describe("reply model consent", () => {
  it("is off by default, applies across the profile with chat opt-outs, and is endpoint-bound", () => {
    const root = mkdtempSync(join(tmpdir(), "reply-consents-"))
    const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1" }
    const env = { CHAT_CONFIG_DIR: join(root, "config") }
    const path = replyConsentPathFor(app, "default", env)
    const identity = replyModelIdentity("openai", "https://example.test/v1/")
    expect(readReplyConsent(path)).toEqual({ provider: null, deniedChats: [] })
    expect(mayModelReply(path, identity, "11")).toBe(false)
    writeReplyConsent(path, { provider: identity, deniedChats: ["12"] })
    expect(mayModelReply(path, identity, "11")).toBe(true)
    expect(mayModelReply(path, identity, "12")).toBe(false)
    expect(mayModelReply(path, "openai:https://elsewhere.test/v1", "11")).toBe(false)
    expect(mayModelReply(replyConsentPathFor(app, "other", env), identity, "11")).toBe(false)
    writeReplyConsent(path, { provider: null, deniedChats: ["12"] })
    expect(mayModelReply(path, identity, "11")).toBe(false)
  })
  it("refuses malformed stored consent without guessing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "reply-consents-")), "consents.json")
    for (const raw of ["{broken", '{"provider":"openai","deniedChats":[],"typo":true}']) {
      writeFileSync(path, raw)
      expect(() => readReplyConsent(path)).toThrow("consent is invalid")
    }
  })
})
