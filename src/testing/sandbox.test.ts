import { describe, expect, it } from "vitest"
import { sharedModelsDirectory } from "../speech/install.js"

describe("the test sandbox", () => {
  it("keeps the default model folder inside it when a test passes an env without overrides", () => {
    expect(sharedModelsDirectory("text", {}).startsWith(String(process.env.TMPDIR))).toBe(true)
  })
})
