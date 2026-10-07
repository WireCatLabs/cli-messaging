import { analyse } from "chardet"
import iconv from "iconv-lite"

export type Decoded = { text: string; encoding: string } | { error: string }
const SAMPLE = 65_536

const invalidText = (text: string) => {
  for (const character of text) {
    const code = character.charCodeAt(0)
    if (code < 9 || code === 11 || (code > 13 && code < 32) || (code >= 127 && code <= 159)) return true
  }
  return false
}

const canonicalEncoding = (label: string): string => {
  try {
    return new TextDecoder(label).encoding
  } catch {
    const name = label.trim().toLowerCase()
    if (name === "iso-8859-9") return "windows-1254"
    if (name === "iso-8859-11") return "windows-874"
    if (!iconv.encodingExists(name)) throw new Error("unsupported_encoding")
    return name
  }
}

const decode = (bytes: Uint8Array, label: string): Decoded => {
  try {
    const encoding = canonicalEncoding(label)
    let decoder: InstanceType<typeof TextDecoder> | undefined
    try {
      decoder = new TextDecoder(encoding, { fatal: true })
    } catch {}
    const text = decoder
      ? decoder.decode(bytes)
      : iconv.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), encoding)
    if (!decoder && text.includes("\ufffd")) return { error: "invalid_encoding" }
    const binary = encoding.startsWith("utf-") ? text.includes("\u0000") : invalidText(text)
    return binary ? { error: "binary" } : { text, encoding }
  } catch {
    return { error: "invalid_encoding" }
  }
}

const bom = (bytes: Uint8Array): string | undefined => {
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) ||
    (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
  )
    return "unsupported"
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"
  return undefined
}

const sample = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length <= SAMPLE) return bytes
  const size = Math.floor(SAMPLE / 3)
  const result = new Uint8Array(size * 3)
  result.set(bytes.subarray(0, size))
  result.set(bytes.subarray(Math.floor((bytes.length - size) / 2), Math.floor((bytes.length - size) / 2) + size), size)
  result.set(bytes.subarray(bytes.length - size), size * 2)
  return result
}

export const decodeText = (bytes: Uint8Array): Decoded => {
  const marked = bom(bytes)
  if (marked === "unsupported") return { error: "unsupported_encoding" }
  if (marked) return decode(bytes, marked)
  const utf8 = decode(bytes, "utf-8")
  if (!("error" in utf8) || utf8.error === "binary") return utf8
  if (bytes.length < 32 || bytes.includes(0)) return { error: "encoding_ambiguous" }
  const candidates = new Map<string, number>()
  for (const match of analyse(sample(bytes))) {
    try {
      const name = canonicalEncoding(match.name)
      if (name.startsWith("utf-") || name === "iso-2022-jp") continue
      candidates.set(name, Math.max(candidates.get(name) ?? 0, match.confidence))
    } catch {}
  }
  const ranked = [...candidates].sort((a, b) => b[1] - a[1])
  const best = ranked[0]
  if (!best || best[1] < 80 || best[1] - (ranked[1]?.[1] ?? 0) < 15) return { error: "encoding_ambiguous" }
  return decode(bytes, best[0])
}

export const decodeXml = (bytes: Uint8Array): string => {
  const marked = bom(bytes)
  if (marked === "unsupported") throw new Error("unsupported_encoding")
  const declaration = new TextDecoder("ascii")
    .decode(bytes.subarray(0, 256))
    .match(/^\s*<\?xml[^>]*\bencoding=["']([^"']+)["']/i)
  const result = decode(bytes, marked ?? declaration?.[1] ?? "utf-8")
  if ("error" in result) throw new Error(result.error)
  return result.text
}
