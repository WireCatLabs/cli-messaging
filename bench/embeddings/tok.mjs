import { Tokenizer } from "@huggingface/tokenizers"
import { readFileSync } from "node:fs"
for (const m of ["e5", "minilm", "gemma", "granite"]) {
  const t = new Tokenizer(JSON.parse(readFileSync(`../models/${m}/tokenizer.json`)), JSON.parse(readFileSync(`../models/${m}/tokenizer_config.json`)))
  const e = t.encode("Привет, как дела? Hello there.")
  console.log(m, e.ids.length, e.ids.join(","), e.tokens.join("|"))
}
