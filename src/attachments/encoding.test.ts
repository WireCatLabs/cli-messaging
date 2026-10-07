import { describe, expect, it, vi } from "vitest"
import { decodeText, decodeXml } from "./encoding.js"

const legacy = (value: string, encoding: string): Uint8Array => {
  const decoder = new TextDecoder(encoding)
  const codes = new Map(Array.from({ length: 256 }, (_, code) => [decoder.decode(new Uint8Array([code])), code]))
  return new Uint8Array(
    [...value].map((character) => {
      const code = codes.get(character)
      if (code === undefined) throw new Error("fixture cannot encode character")
      return code
    }),
  )
}
const utf16 = (value: string, big = false) => {
  const bytes = new Uint8Array(2 + value.length * 2)
  bytes.set(big ? [0xfe, 0xff] : [0xff, 0xfe])
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < value.length; index++) view.setUint16(2 + index * 2, value.charCodeAt(index), !big)
  return bytes
}

describe("text encoding", () => {
  it("keeps UTF-8, Unicode and empty text unchanged", () => {
    const text = "Привет café 😀\tline\nnext"
    expect(decodeText(new TextEncoder().encode(text))).toEqual({ text, encoding: "utf-8" })
    expect(decodeText(new Uint8Array())).toEqual({ text: "", encoding: "utf-8" })
  })
  it("preserves valid Unicode log controls while still rejecting NUL", () => {
    const text = "\u001b[31mError\u001b[0m\u0007\n"
    expect(decodeText(new TextEncoder().encode(text))).toEqual({ text, encoding: "utf-8" })
    expect(decodeText(utf16(text, true))).toEqual({ text, encoding: "utf-16be" })
  })
  it.each([false, true])("decodes BOM-marked UTF-16, including surrogate pairs (%s)", (big) => {
    expect(decodeText(utf16("Привет 😀", big))).toEqual({ text: "Привет 😀", encoding: big ? "utf-16be" : "utf-16le" })
  })
  it.each(["windows-1251", "koi8-r", "windows-1252"])("detects a strong %s candidate", (encoding) => {
    const text = (
      encoding === "windows-1252"
        ? "Café français, déjà reçu. Une facture pour la coopération et les élèves. "
        : "Договор поставки оборудования. Получатель подтверждает получение документов и согласование условий оплаты. "
    ).repeat(20)
    const bytes = legacy(text, encoding),
      copy = bytes.slice()
    expect(decodeText(bytes)).toEqual({ text, encoding })
    expect(bytes).toEqual(copy)
  })
  it("samples long input and preserves the full decoded text", () => {
    const text =
      "Договор поставки оборудования. Получатель подтверждает получение документов и согласование условий оплаты. ".repeat(
        1000,
      )
    expect(decodeText(legacy(text, "windows-1251"))).toEqual({ text, encoding: "windows-1251" })
  })
  it("refuses short ambiguous data, binary controls, malformed BOM and UTF-32", () => {
    expect(decodeText(new Uint8Array([0xff, 0xff]))).toEqual({ error: "encoding_ambiguous" })
    expect(decodeText(new TextEncoder().encode("x\0y"))).toEqual({ error: "binary" })
    expect(decodeText(new Uint8Array([0xff, 0xfe, 65]))).toEqual({ error: "invalid_encoding" })
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0, 0, 65, 0, 0, 0]))).toEqual({ error: "unsupported_encoding" })
    expect(decodeText(new Uint8Array([0, 0, 0xfe, 0xff]))).toEqual({ error: "unsupported_encoding" })
    expect(decodeText(new Uint8Array([0xff, ...new Uint8Array(100)]))).toEqual({ error: "encoding_ambiguous" })
  })
  it("uses the portable decoder when a runtime lacks the legacy native decoder", () => {
    const text =
      "Договор поставки оборудования. Получатель подтверждает получение документов и согласование условий оплаты. ".repeat(
        20,
      )
    const bytes = legacy(text, "windows-1251")
    const Native = globalThis.TextDecoder
    vi.stubGlobal(
      "TextDecoder",
      class extends Native {
        constructor(...args: ConstructorParameters<typeof TextDecoder>) {
          if (args[0]?.toLowerCase() === "windows-1251") throw new RangeError("not available")
          super(...args)
        }
      },
    )
    try {
      expect(decodeText(bytes)).toEqual({ text, encoding: "windows-1251" })
      expect(decodeText(new Uint8Array([...bytes, 0x98]))).toEqual({ error: "invalid_encoding" })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("reads declared XML encodings and refuses unknown declarations", () => {
    const text = '<?xml version="1.0" encoding="windows-1251"?><root>Привет</root>'
    expect(decodeXml(legacy(text, "windows-1251"))).toBe(text)
    expect(decodeXml(utf16("<root>Привет</root>", true))).toBe("<root>Привет</root>")
    expect(() => decodeXml(new TextEncoder().encode('<?xml encoding="unknown-encoding"?><root/>'))).toThrow()
    expect(() => decodeXml(new Uint8Array([0, 0, 0xfe, 0xff]))).toThrow()
  })
})
