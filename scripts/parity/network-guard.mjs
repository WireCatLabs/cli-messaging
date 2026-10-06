import { Socket } from "node:net"

let attempts = 0
const refused = () => {
  attempts++
  throw new Error("synthetic audit forbids network access")
}
Socket.prototype.connect = refused
globalThis.fetch = refused
process.on("exit", () => {
  if (attempts) process.stderr.write(`AUDIT_NETWORK_ATTEMPTS=${attempts}\n`)
})
