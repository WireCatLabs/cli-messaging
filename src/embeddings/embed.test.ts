import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { meanOf, openEmbedder, truncated, unit } from "./embed.js"
import type { TextModel } from "./models.js"

describe("embedding arithmetic", () => {
  it("**cuts a long text** to the model's limit, keeping the closing special token", () => {
    expect(truncated([101, 1, 2, 3, 4, 102], 4)).toEqual([101, 1, 2, 102])
    expect(truncated([101, 1, 102], 4)).toEqual([101, 1, 102])
  })

  it("averages the tokens' vectors", () => {
    expect(Array.from(meanOf(Float32Array.from([1, 2, 3, 4]), 2, 2))).toEqual([2, 3])
  })

  it("scales a vector to length one, so a dot product is the cosine", () => {
    expect(Array.from(unit(Float32Array.from([3, 4])))).toEqual([0.6000000238418579, 0.800000011920929])
    expect(Array.from(unit(new Float32Array(2)))).toEqual([0, 0])
  })
})

const tiny: TextModel = {
  id: "tiny",
  title: "a five-word model",
  languages: "test",
  licence: "none",
  dims: 4,
  maxTokens: 3,
  pooling: "mean",
  prefix: { query: "fish ", passage: "" },
  onnx: "onnx/model.onnx",
  files: [],
}

const rounded = (vector: Float32Array | undefined) => Array.from(vector ?? []).map((value) => value.toFixed(4))

describe("openEmbedder", () => {
  it("**runs a model through the WebAssembly runtime**: tokens, their mean, length one, the prefix, the limit", async () => {
    const embedder = await openEmbedder(tiny, fileURLToPath(new URL("./fixtures", import.meta.url)), { threads: 1 })
    try {
      const [cat, catDog, cut] = await embedder.embed(["cat", "cat dog", "cat dog fish dog"], "passage")
      expect(rounded(cat)).toEqual(["1.0000", "0.0000", "0.0000", "0.0000"])
      expect(rounded(catDog)).toEqual(["0.7071", "0.7071", "0.0000", "0.0000"])
      expect(rounded(cut)).toEqual(["0.4472", "0.8944", "0.0000", "0.0000"])
      expect(rounded((await embedder.embed(["cat"], "query"))[0])).toEqual(["0.7071", "0.0000", "0.7071", "0.0000"])
    } finally {
      await embedder.close()
    }
  })
})
