import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { checkFor, isSealed, passes, sealFile, unsealFile } from "./sealed.js"

const FAST = { log2N: 10, r: 8, p: 1 }
const TEXT = `${'{"id":"1","text":"synthetic line"}\n'.repeat(2000)}`

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "sealed-"))
  writeFileSync(join(dir, "plain.jsonl"), TEXT)
  return dir
}

describe("a sealed file", () => {
  it("opens with the same password into what went in, readable only by its owner", async () => {
    const dir = folder()
    await sealFile(join(dir, "plain.jsonl"), join(dir, "x.sealed"), "correct horse", FAST)
    await unsealFile(join(dir, "x.sealed"), join(dir, "back.jsonl"), "correct horse")

    expect(isSealed(join(dir, "x.sealed"))).toBe(true)
    expect(isSealed(join(dir, "plain.jsonl"))).toBe(false)
    expect(readFileSync(join(dir, "x.sealed")).includes("synthetic")).toBe(false)
    expect(readFileSync(join(dir, "back.jsonl"), "utf8")).toBe(TEXT)
    expect(statSync(join(dir, "x.sealed")).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "back.jsonl")).mode & 0o777).toBe(0o600)
  })

  it("refuses a wrong password and a changed byte, and leaves nothing behind", async () => {
    const dir = folder()
    await sealFile(join(dir, "plain.jsonl"), join(dir, "x.sealed"), "correct horse", FAST)
    const bytes = readFileSync(join(dir, "x.sealed"))
    bytes[bytes.length - 40] = (bytes[bytes.length - 40] ?? 0) ^ 1
    writeFileSync(join(dir, "changed.sealed"), bytes)

    await expect(unsealFile(join(dir, "x.sealed"), join(dir, "a.jsonl"), "wrong horse")).rejects.toThrow(
      /wrong password/,
    )
    await expect(unsealFile(join(dir, "changed.sealed"), join(dir, "b.jsonl"), "correct horse")).rejects.toThrow(
      /wrong password, or the file was changed/,
    )
    expect(readdirSync(dir).sort()).toEqual(["changed.sealed", "plain.jsonl", "x.sealed"])
  })

  it("never overwrites, refuses an empty password and a file it did not seal", async () => {
    const dir = folder()
    await sealFile(join(dir, "plain.jsonl"), join(dir, "x.sealed"), "pw", FAST)

    await expect(sealFile(join(dir, "plain.jsonl"), join(dir, "x.sealed"), "pw", FAST)).rejects.toThrow()
    await expect(unsealFile(join(dir, "x.sealed"), join(dir, "plain.jsonl"), "pw")).rejects.toThrow(/exists/)
    await expect(sealFile(join(dir, "plain.jsonl"), join(dir, "y.sealed"), "", FAST)).rejects.toThrow(/empty/)
    await expect(unsealFile(join(dir, "plain.jsonl"), join(dir, "z.jsonl"), "pw")).rejects.toThrow(/not a sealed/)
    expect(existsSync(join(dir, "y.sealed"))).toBe(false)
    expect(readFileSync(join(dir, "plain.jsonl"), "utf8")).toBe(TEXT)
  })

  it("keeps a check that tells the same password from another, without the password", async () => {
    const check = await checkFor("correct horse", FAST)

    expect(JSON.stringify(check)).not.toContain("correct horse")
    expect(await passes("correct horse", check)).toBe(true)
    expect(await passes("correct horse!", check)).toBe(false)
    await expect(passes("correct horse", { ...check, log2N: 30 })).rejects.toThrow(/key cost/)
  })
})
