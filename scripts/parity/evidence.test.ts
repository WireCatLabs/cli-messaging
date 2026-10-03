import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { check, mcpSchemas, mountingEvidence, sandboxEnvironment, sourceEvidence } from "./evidence.ts"

const directory = () => mkdtempSync(join(tmpdir(), "parity-probe-test-"))
const server = (root: string, response: string) => {
  const path = join(root, "server.mjs")
  writeFileSync(
    path,
    `let buffer="";process.stdin.on("data",chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf("\\n"))>=0){const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(message.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{}})+"\\n");else if(message.method==="tools/list"){${response}}else if(message.method!=="notifications/initialized")throw Error("unexpected operation");}});`,
  )
  return path
}

describe("isolated parity evidence capture", () => {
  it("performs only initialize/list and reconstructs fragmented JSON before closing its own process", async () => {
    const root = directory()
    const bin = server(
      root,
      'const answer=JSON.stringify({jsonrpc:"2.0",id:2,result:{tools:[{name:"fake_read",inputSchema:{type:"object",required:["chat"]}}]}})+"\\n";process.stdout.write(answer.slice(0,7));setImmediate(()=>process.stdout.write(answer.slice(7)));',
    )
    await expect(mcpSchemas(bin, [], sandboxEnvironment(root))).resolves.toEqual([
      { name: "fake_read", inputSchema: { type: "object", required: ["chat"] } },
    ])
  })
  it("distinguishes a server error, early exit and malformed output from an empty tool list", async () => {
    for (const response of [
      'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,error:{message:"not configured"}})+"\\n");',
      "process.exit(2);",
      'process.stdout.write("not-json\\n");',
    ]) {
      const root = directory()
      await expect(mcpSchemas(server(root, response), [], sandboxEnvironment(root))).rejects.toThrow()
    }
  })
  it("terminates an unresponsive probe with its deadline instead of hanging the audit", async () => {
    const root = directory()
    await expect(mcpSchemas(server(root, ""), [], sandboxEnvironment(root), { timeoutMs: 1 })).rejects.toThrow(
      "timed out",
    )
  })
  it("does not pass credentials/user store paths to child processes", () => {
    const env = sandboxEnvironment("/tmp/synthetic-parity-home")
    expect(env.HOME).not.toBe(env.TMPDIR)
    expect(env.TMPDIR?.startsWith(`${env.HOME}/`)).toBe(false)
    expect(env.MAX_TOKEN).toBeUndefined()
    expect(env.TG_API_HASH).toBeUndefined()
    expect(env.XDG_RUNTIME_DIR).toBeUndefined()
    expect(env.MESSAGING_STORE).toBe(join("/tmp/synthetic-parity-home", "messages.db"))
  })
  it("keeps a failed check's exit status and log so it cannot be reported as a pass", async () => {
    const root = directory()
    const result = await check(
      root,
      "failing",
      [process.execPath, "-e", 'console.error("synthetic refusal");process.exit(7)'],
      join(root, "log"),
      sandboxEnvironment(root),
    )
    expect(result).toMatchObject({ name: "failing", exit: 7 })
  })
  it("reports mixed local mounts and unresolved aliases without inferring shared behaviour", () => {
    const root = directory()
    mkdirSync(join(root, "src/commands"), { recursive: true })
    writeFileSync(
      join(root, "src/program.ts"),
      'import { messagesCommand } from "./commands/messages.js"\nimport { chatsCommand } from "@leemour/cli-messaging/cli"\n',
    )
    writeFileSync(
      join(root, "src/commands/messages.ts"),
      'import { sendCommand } from "@leemour/cli-messaging/cli"\nexport const messagesCommand = () => group.command("download")\n',
    )
    const result = mountingEvidence(root, ["messages", "chats", "aliased"], sourceEvidence(root))
    expect(result[0]).toMatchObject({ group: "messages", file: "src/commands/messages.ts" })
    expect(result[0]?.sharedReferences).toHaveLength(1)
    expect(result[0]?.localRegistrations).toHaveLength(1)
    expect(result[1]?.verdict).toContain("semantics still require review")
    expect(result[2]?.verdict).toContain("unresolved")
  })
})
