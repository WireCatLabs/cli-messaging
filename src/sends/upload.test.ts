import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readUpload } from "./upload.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }

const setUp = () => {
  const root = mkdtempSync(join(tmpdir(), "upload-"))
  const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "store", "m.db") }
  const put = (path: string) => {
    const full = join(root, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, "bytes")
    return full
  }
  return { root, env, put }
}

describe("readUpload", () => {
  it("reads a file with its name, and a photo only with a photo's extension", async () => {
    const { env, put } = setUp()

    expect(await readUpload("file", put("docs/plan.pdf"), { app, env })).toMatchObject({
      kind: "file",
      name: "plan.pdf",
    })
    expect((await readUpload("photo", put("pics/cat.JPG"), { app, env })).bytes.byteLength).toBe(5)
    await expect(readUpload("photo", put("pics/cat.gif"), { app, env })).rejects.toThrow(/send .* as a file/)
  })

  it("**refuses hidden files, the CLI's own folders and the store**, also through a link — unless anyFile", async () => {
    const { root, env, put } = setUp()
    const key = put(".ssh/id_ed25519")
    const link = join(root, "innocent.txt")
    symlinkSync(key, link)

    for (const path of [key, put("state/session"), put("store/m.db"), link]) {
      await expect(readUpload("file", path, { app, env })).rejects.toThrow(/--allow-any-file/)
    }
    expect(await readUpload("file", key, { app, env, anyFile: true })).toMatchObject({ name: "id_ed25519" })
  })

  it("says what is wrong with a path that is not a readable file", async () => {
    const { root, env } = setUp()

    await expect(readUpload("file", join(root, "missing.pdf"), { app, env })).rejects.toThrow(/no such file/)
    await expect(readUpload("file", root, { app, env })).rejects.toThrow(/a folder/)
  })
})
