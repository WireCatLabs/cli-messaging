import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const guard = fileURLToPath(new URL("./network-guard.mjs", import.meta.url))

describe("synthetic audit network guard", () => {
  it.each([
    'await fetch("https://example.invalid")',
    'const { Socket } = await import("node:net"); new Socket().connect(1, "127.0.0.1")',
  ])("records even a swallowed connection failure: %s", (attempt) => {
    const result = spawnSync("node", ["--import", guard, "--input-type=module", "-e", `try { ${attempt} } catch {}`], {
      encoding: "utf8",
      timeout: 5000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("AUDIT_NETWORK_ATTEMPTS=1\n")
  })
})
