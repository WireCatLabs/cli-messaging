export const toMs = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

export const toIso = (ms: unknown): string | null => (typeof ms === "number" ? new Date(ms).toISOString() : null)

export const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value))

export const parsed = <T>(text: unknown): T | undefined =>
  typeof text === "string" ? (JSON.parse(text) as T) : undefined

export const present = <T extends Record<string, unknown>>(entries: T) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== null && value !== undefined))
