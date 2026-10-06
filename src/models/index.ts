import { CliError } from "@leemour/cli-core"
import { endpoint } from "./endpoint.js"
import { openai } from "./openai.js"
import type { ModelAdapter, ModelAnswer, ModelRequest, ModelTarget } from "./types.js"

export type { ModelSettings } from "./settings.js"
export { modelTarget } from "./settings.js"
export type { ModelAdapter, ModelAnswer, ModelRequest, ModelTarget } from "./types.js"

export interface GatewayDeps {
  resolve: (purpose: string) => ModelTarget | undefined
  consent: (request: ModelRequest, target: ModelTarget) => boolean | Promise<boolean>
  key?: (provider: string, target: ModelTarget) => string | undefined | Promise<string | undefined>
  adapters?: Readonly<Record<string, ModelAdapter>>
  fetch?: typeof fetch
  signal?: AbortSignal
}

export const modelGateway = (deps: GatewayDeps) => ({
  complete: async (request: ModelRequest): Promise<ModelAnswer> => {
    if (deps.signal?.aborted) throw new CliError("cancelled", "model request cancelled")
    const target = deps.resolve(request.purpose)
    if (!target || target.provider === "off")
      throw new CliError(
        "configuration_error",
        `models.${request.purpose}.provider is not configured; no model was called`,
      )
    if (
      !request.purpose ||
      !Number.isSafeInteger(request.maxTokens) ||
      request.maxTokens < 1 ||
      typeof request.prompt !== "string"
    )
      throw new CliError("validation_error", "a model request needs a purpose, prompt and positive whole maxTokens")
    let adapter = deps.adapters?.[target.provider]
    if (!adapter && target.provider === "openai") adapter = openai
    if (!adapter && target.provider === "anthropic") adapter = (await import("./anthropic.js")).anthropic
    if (!adapter) throw new CliError("validation_error", `no model adapter for ${target.provider}`)
    const options = adapter.validate(request.options ?? {})
    const baseUrl = target.baseUrl ?? adapter.baseUrl
    if (!target.model.trim() || !endpoint(baseUrl))
      throw new CliError(
        "validation_error",
        "a model target needs a model and an HTTP/S endpoint without credentials, query or fragment",
      )
    if (!(await deps.consent(request, { ...target, baseUrl })))
      throw new CliError("permission_error", `model consent for ${request.purpose} is missing; no data was sent`)
    const apiKey = await deps.key?.(target.provider, target)
    if (deps.signal?.aborted) throw new CliError("cancelled", "model request cancelled")
    const fetcher = deps.fetch ?? fetch
    const cancellable: typeof fetch = (input, init) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      return fetcher(input, {
        ...init,
        signal: deps.signal ? AbortSignal.any([deps.signal, ...(signal ? [signal] : [])]) : signal,
      })
    }
    try {
      const answer = await adapter.complete({ ...target, baseUrl }, request, options, apiKey, cancellable)
      if (deps.signal?.aborted) throw new Error("cancelled")
      if (typeof answer.text !== "string" || !Number.isSafeInteger(answer.tokens) || answer.tokens < 1)
        throw new Error("incomplete")
      return { ...answer, provider: target.provider, model: target.model }
    } catch {
      throw new CliError(
        "invalid_response",
        `${request.purpose} provider failed or returned an incomplete response; no result was stored`,
      )
    }
  },
})
