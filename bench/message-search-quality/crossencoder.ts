import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const openCrossEncoder = async (directory: string) => {
  const manifest = JSON.parse(readFileSync(new URL("./reranker.json", import.meta.url), "utf8")) as {
    repository: string
    revision: string
    licence: string
    maxTokens: number
    files: { name: string; sha256: string; url: string }[]
  }
  for (const file of manifest.files)
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(directory, file.name)))
        .digest("hex"),
      file.sha256,
      `pinned reranker ${file.name}`,
    )
  const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8")) as {
    sbert_ce_default_activation_function: string
    id2label: Record<string, string>
  }
  assert.equal(config.sbert_ce_default_activation_function, "torch.nn.modules.linear.Identity")
  assert.equal(Object.keys(config.id2label).length, 1)
  const [{ Tokenizer }, ort] = await Promise.all([
    import("@huggingface/tokenizers"),
    import("@leemour/cli-messaging-onnx"),
  ])
  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(join(directory, "tokenizer.json"), "utf8")),
    JSON.parse(readFileSync(join(directory, "tokenizer_config.json"), "utf8")),
  )
  ort.env.wasm.numThreads = 8
  const model = manifest.files.find((file) => file.name.endsWith(".onnx"))
  assert.ok(model)
  const session = await ort.InferenceSession.create(readFileSync(join(directory, model.name)))
  assert.deepEqual([...session.inputNames].sort(), ["attention_mask", "input_ids"])
  assert.deepEqual(session.outputNames, ["logits"])
  return {
    model: {
      id: manifest.repository,
      revision: manifest.revision,
      licence: manifest.licence,
      files: manifest.files.map(({ name, sha256 }) => ({ name, sha256 })),
      threads: 8,
    },
    score: async (query: string, passage: string) => {
      const ids = tokenizer.encode(query, { text_pair: passage }).ids
      assert.ok(ids.length <= manifest.maxTokens, "benchmark pair must fit without truncation")
      const result = await session.run({
        input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
        attention_mask: new ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
      })
      const logits = result.logits
      assert.ok(logits)
      assert.equal(logits.data.length, 1)
      const score = Number(logits.data[0])
      assert.ok(Number.isFinite(score))
      return score
    },
    close: () => session.release(),
  }
}
