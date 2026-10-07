import { describe, expect, it } from "vitest"
import { docx, pdf, zip } from "../testing/files.js"
import { type Engine, engineHint, extractText, importEngine, type LoadEngine } from "./extract.js"

const hint = (name: string, extra: { kind?: string; mime?: string } = {}) => ({
  kind: extra.kind ?? "file",
  name,
  mime: extra.mime ?? null,
  path: `/saved/${name}`,
})
const text = (value: string) => new TextEncoder().encode(value)
const without =
  (missing: Engine): LoadEngine =>
  async (name) => {
    if (name === missing)
      throw Object.assign(new Error(`Cannot find package '${name}'`), { code: "ERR_MODULE_NOT_FOUND" })
    return importEngine(name)
  }

describe("reading the text layer of a file", () => {
  it("**reads plain text in UTF-8, with or without a BOM, Cyrillic and Latin alike**", async () => {
    expect(await extractText(text("счёт invoice 42"), hint("notes.txt"), importEngine)).toEqual({
      status: "extracted",
      text: "счёт invoice 42",
      extractor: "plain",
    })
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...text("a,b\nдоговор,1")])
    expect(await extractText(bom, hint("table.csv"), importEngine)).toMatchObject({ text: "a,b\nдоговор,1" })
    expect(
      await extractText(text('{"k":"v"}'), hint("data", { mime: "application/json" }), importEngine),
    ).toMatchObject({
      status: "extracted",
    })
  })

  it("refuses malformed BOM text and binary text, naming only the reason", async () => {
    expect(await extractText(new Uint8Array([0xff, 0xfe, 0x41]), hint("a.txt"), importEngine)).toEqual({
      status: "unreadable",
      extractor: "plain:v2",
      error: "invalid_encoding",
    })
    expect(await extractText(text("a\u0000b"), hint("a.log"), importEngine)).toMatchObject({ error: "binary" })
  })

  it("**reads a Word document through mammoth**, and records its version", async () => {
    const found = await extractText(docx(["Договор поставки", "invoice 7"]), hint("deal.docx"), importEngine)
    expect(found.status).toBe("extracted")
    expect(found).toMatchObject({ extractor: expect.stringMatching(/^docx:mammoth@\d+\.\d+\.\d+$/) })
    expect(found.status === "extracted" && found.text).toContain("Договор поставки")
  })

  it("marks a corrupt Word document unreadable, without the engine's message", async () => {
    const broken = zip({ "word/nothing.xml": "<x/>" })
    expect(await extractText(broken, hint("broken.docx"), importEngine)).toMatchObject({
      status: "unreadable",
      error: "unreadable",
    })
  })

  it("**reads a PDF's text layer through unpdf; a PDF with none is for an agent**", async () => {
    const found = await extractText(pdf("Invoice number 42"), hint("scan.pdf"), importEngine)
    expect(found).toMatchObject({ status: "extracted", extractor: expect.stringMatching(/^pdf:unpdf@/) })
    expect(found.status === "extracted" && found.text).toContain("Invoice number 42")
    expect(await extractText(pdf(), hint("scan.pdf"), importEngine)).toMatchObject({ status: "needs-agent" })
  })

  it("leaves photos to an agent and skips what has no text", async () => {
    expect(await extractText(text("jpeg"), hint("1-1.jpg", { kind: "photo" }), importEngine)).toEqual({
      status: "needs-agent",
    })
    expect(await extractText(text("ogg"), hint("voice.ogg", { kind: "voice" }), importEngine)).toEqual({
      status: "unsupported",
    })
  })

  it("**says which optional package is missing, instead of failing**", async () => {
    expect(await extractText(pdf("x"), hint("a.pdf"), without("unpdf"))).toEqual({
      status: "engine-missing",
      engine: "unpdf",
    })
    expect(await extractText(docx(["x"]), hint("a.docx"), without("mammoth"))).toEqual({
      status: "engine-missing",
      engine: "mammoth",
    })
    expect(engineHint("unpdf", "tg")).toContain("npm install -g unpdf")
  })

  it("lets any other loading failure through", async () => {
    const broken: LoadEngine = async () => {
      throw new Error("disk on fire")
    }
    await expect(extractText(pdf("x"), hint("a.pdf"), broken)).rejects.toThrow("disk on fire")
  })
})
