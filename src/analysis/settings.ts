import * as v from "valibot"

export const endpoint = (value: string): boolean => {
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}
const model = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))
const url = v.pipe(v.string(), v.check(endpoint, "use an HTTP/S endpoint without credentials, query or fragment"))
export const AI_ENTRIES = {
  embeddingProvider: v.optional(v.picklist(["local", "openai"])),
  embeddingModel: v.optional(model),
  embeddingBaseUrl: v.optional(url),
  embeddingDims: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65536))),
  analysisProvider: v.optional(v.picklist(["agent", "openai", "anthropic"])),
  analysisModel: v.optional(model),
  analysisBaseUrl: v.optional(url),
}
export type AISettings = v.InferOutput<v.ObjectSchema<typeof AI_ENTRIES, undefined>>
export const AI_DEFAULTS: AISettings = { embeddingProvider: "local", analysisProvider: "agent" }
