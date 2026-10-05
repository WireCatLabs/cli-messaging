import Anthropic from "@anthropic-ai/sdk"
import type { AnalysisProvider, AnalysisResponse } from "./provider.js"

export const analyze = async (
  target: AnalysisProvider,
  system: string,
  input: string,
  maxTokens: number,
): Promise<AnalysisResponse> => {
  const client = new Anthropic({
    apiKey: target.apiKey ?? "",
    authToken: null,
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
    baseURL: target.baseUrl,
    maxRetries: 0,
    logLevel: "off",
    timeout: 120_000,
  })
  const response = await client.messages
    .stream({ model: target.model, system, messages: [{ role: "user", content: input }], max_tokens: maxTokens })
    .finalMessage()
  if (response.stop_reason !== "end_turn") throw new Error("incomplete analysis")
  return {
    text: response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    tokens:
      response.usage.input_tokens +
      response.usage.output_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0),
  }
}
