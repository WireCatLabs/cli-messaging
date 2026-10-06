import { bufferedInput } from "../input-policy.js"

/** All of stdin as text; nothing when it is a terminal, where nobody would press Ctrl-D. */
export const readAll = async (input: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> => {
  if (input.isTTY) return ""
  return (await bufferedInput(input)).toString("utf8")
}
