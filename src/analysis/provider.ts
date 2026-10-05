import { CliError } from "@leemour/cli-core"
import { endpoint } from "./settings.js"

export interface AnalysisProvider {
  provider: "openai" | "anthropic"
  model: string
  baseUrl: string
  apiKey?: string
}
export interface AnalysisResponse {
  text: string
  tokens: number
}
export type AnalysisRequest = (system: string, input: string, maxTokens: number) => Promise<AnalysisResponse>
export const providerIdentity = (target: AnalysisProvider) => `${target.provider}:${target.baseUrl.replace(/\/+$/, "")}`

export const openAnalysis = (target: AnalysisProvider): AnalysisRequest => {
  if (!endpoint(target.baseUrl)) throw new CliError("validation_error", "invalid analysis endpoint")
  return async (system, input, maxTokens) => {
    try {
      if (target.provider === "anthropic")
        return await (await import("./anthropic.js")).analyze(target, system, input, maxTokens)
      const response = await fetch(`${target.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: target.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input },
          ],
          ...(new URL(target.baseUrl).hostname === "api.openai.com"
            ? { max_completion_tokens: maxTokens }
            : { max_tokens: maxTokens }),
        }),
        signal: AbortSignal.timeout(120_000),
        redirect: "error",
      })
      if (!response.ok) throw new Error("provider rejected request")
      const body = (await response.json()) as {
        choices?: { finish_reason?: string; message?: { content?: unknown } }[]
        usage?: { total_tokens?: number }
      }
      const choice = body.choices?.[0]
      if (
        choice?.finish_reason !== "stop" ||
        typeof choice.message?.content !== "string" ||
        !Number.isInteger(body.usage?.total_tokens) ||
        (body.usage?.total_tokens ?? 0) < 1
      )
        throw new Error("incomplete response")
      return { text: choice.message.content, tokens: body.usage?.total_tokens as number }
    } catch {
      throw new CliError(
        "invalid_response",
        "analysis provider failed or returned an incomplete response; this batch was not stored",
      )
    }
  }
}
