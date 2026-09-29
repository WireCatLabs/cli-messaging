/** All of stdin as text; nothing when it is a terminal, where nobody would press Ctrl-D. */
export const readAll = async (input: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> => {
  if (input.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}
