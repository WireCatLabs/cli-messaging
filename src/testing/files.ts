import { crc32 } from "node:zlib"

const encoder = new TextEncoder()

const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff]
const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]

/** A zip with stored (uncompressed) entries — enough for a Word reader, and nothing from an office app. */
export const zip = (entries: Record<string, string>): Uint8Array => {
  const local: number[] = []
  const central: number[] = []
  for (const [name, content] of Object.entries(entries)) {
    const path = [...encoder.encode(name)]
    const data = encoder.encode(content)
    const crc = crc32(data)
    const offset = local.length
    const header = [...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length)]
    local.push(...u32(0x04034b50), ...header, ...u32(data.length), ...u16(path.length), ...u16(0), ...path, ...data)
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...header,
      ...u32(data.length),
      ...u16(path.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...path,
    )
  }
  const count = Object.keys(entries).length
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(count),
    ...u16(count),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0),
  ]
  return new Uint8Array([...local, ...central, ...end])
}

const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** A minimal Word document, one paragraph per line. */
export const docx = (paragraphs: string[]): Uint8Array =>
  zip({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
      .map((one) => `<w:p><w:r><w:t>${escaped(one)}</w:t></w:r></w:p>`)
      .join("")}</w:body></w:document>`,
  })

/** A one-page PDF; with `text`, a text layer in Helvetica (Latin only), without it a page with nothing on it. */
export const pdf = (text?: string, image = false): Uint8Array => {
  const stream = image
    ? "q 144 0 0 144 72 500 cm /Im1 Do Q"
    : text === undefined
      ? ""
      : `BT /F1 12 Tf 72 712 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> ${image ? "/XObject << /Im1 6 0 R >>" : ""} >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  if (image)
    objects.push(
      "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nff0000>\nendstream",
    )
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return encoder.encode(body)
}
