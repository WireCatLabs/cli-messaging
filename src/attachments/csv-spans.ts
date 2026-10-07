export interface CellSpan {
  row: number
  column: number
  start: number
  end: number
}

/** Character ranges into unchanged CSV/TSV text, including quoted multiline fields. */
export const delimitedSpans = (
  text: string,
  delimiter: string,
  maxCells = 10_000,
): { cells: CellSpan[]; truncated: boolean } => {
  const cells: CellSpan[] = []
  let row = 1,
    column = 1,
    start = 0,
    quoted = false,
    truncated = false
  const finish = (end: number) => {
    if (cells.length < maxCells) cells.push({ row, column, start, end })
    else truncated = true
  }
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (char === '"') {
      if (quoted && text[at + 1] === '"') {
        at++
        continue
      }
      quoted = !quoted
    } else if (!quoted && char === delimiter) {
      finish(at)
      start = at + 1
      column++
    } else if (!quoted && (char === "\n" || char === "\r")) {
      finish(at)
      if (char === "\r" && text[at + 1] === "\n") at++
      start = at + 1
      row++
      column = 1
    }
  }
  if (quoted) throw new Error("unclosed CSV field")
  if (start < text.length) finish(text.length)
  return { cells, truncated }
}
