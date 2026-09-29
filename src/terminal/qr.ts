import { deflateSync } from "node:zlib"
import qrcode from "qrcode-generator"

const QUIET_ZONE = 4
// Dark modules on a light ground whatever the terminal's theme: a phone camera reads an inverted
// code unreliably, so the colours are forced even under NO_COLOR.
const BLACK_ON_WHITE = "\x1b[30;107m"
const RESET = "\x1b[0m"

const modules = (link: string) => {
  const code = qrcode(0, "M")
  code.addData(link)
  code.make()
  const count = code.getModuleCount()
  const size = count + QUIET_ZONE * 2
  const dark = (row: number, col: number) => {
    const r = row - QUIET_ZONE
    const c = col - QUIET_ZONE
    return r >= 0 && c >= 0 && r < count && c < count && code.isDark(r, c)
  }
  return { size, dark }
}

/**
 * The same code as a PNG, `scale` pixels a module, for a person or an agent to pass on as an image.
 * 8-bit greyscale, one filter-free row per pixel line: the smallest PNG any decoder reads.
 */
export const qrPng = (link: string, scale = 8): Uint8Array => {
  const { size, dark } = modules(link)
  const side = size * scale
  const pixels = Buffer.alloc((side + 1) * side, 0xff)
  for (let y = 0; y < side; y++) {
    pixels[y * (side + 1)] = 0
    for (let x = 0; x < side; x++) {
      if (dark(Math.floor(y / scale), Math.floor(x / scale))) pixels[y * (side + 1) + 1 + x] = 0
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0)
  header.writeUInt32BE(side, 4)
  header.set([8, 0, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * A QR code as text, two modules per character cell with half blocks, so it fits a terminal
 * without being twice as tall as it is wide. `width` is in columns, for deciding whether it fits.
 */
export const terminalQr = (link: string): { text: string; width: number } => {
  const { size, dark } = modules(link)

  const lines: string[] = []
  for (let row = 0; row < size; row += 2) {
    let line = ""
    for (let col = 0; col < size; col++) {
      const top = dark(row, col)
      const bottom = row + 1 < size && dark(row + 1, col)
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "
    }
    lines.push(`${BLACK_ON_WHITE}${line}${RESET}`)
  }
  return { text: lines.join("\n"), width: size }
}
