import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { ensureSqlite, relay, type SqliteRuntime } from "./sqlite-runtime.js"

const DISTRIBUTION_MAPS = "7f00 r-xp /usr/lib/x86_64-linux-gnu/libsqlite3.so.0.8.6\n7f01 r-xp /usr/lib/libnode.so.127"

const runtime = (overrides: Partial<SqliteRuntime> = {}): SqliteRuntime & { restarts: NodeJS.ProcessEnv[] } => {
  const restarts: NodeJS.ProcessEnv[] = []
  return {
    env: { LD_LIBRARY_PATH: "/opt/user" },
    platform: "linux",
    bun: false,
    maps: () => DISTRIBUTION_MAPS,
    capable: async () => false,
    library: async (musl) => ({
      path: `/pkg/lib/linux-x64-${musl ? "musl" : "gnu"}/libsqlite3.so.0`,
      version: "3.53.4",
    }),
    works: () => true,
    restart: async (env) => {
      restarts.push(env)
      return undefined as never
    },
    ...overrides,
    restarts,
  }
}

describe("ensureSqlite", () => {
  it("**restarts a distribution's Node on our SQLite** when the system's cannot hold the store", async () => {
    const node = runtime()
    await ensureSqlite(node)

    expect(node.restarts).toEqual([
      {
        LD_LIBRARY_PATH: "/pkg/lib/linux-x64-gnu:/opt/user",
        CLI_MESSAGING_SQLITE_RESTARTED: "1",
        CLI_MESSAGING_USER_LD_LIBRARY_PATH: "/opt/user",
      },
    ])
  })

  it("picks the musl build on a musl system", async () => {
    const node = runtime({ env: {}, maps: () => `${DISTRIBUTION_MAPS}\n7f02 r-xp /lib/ld-musl-x86_64.so.1` })
    await ensureSqlite(node)

    expect(node.restarts[0]?.LD_LIBRARY_PATH).toBe("/pkg/lib/linux-x64-musl")
    expect(node.restarts[0]).not.toHaveProperty("CLI_MESSAGING_USER_LD_LIBRARY_PATH")
  })

  it.each([
    ["Node builds SQLite in", { maps: () => "7f00 r-xp /usr/bin/node" }],
    ["the system's SQLite can hold the store", { capable: async () => true }],
    ["the package has no library for this system", { library: async () => undefined }],
    ["our library does not load here", { works: () => false }],
    ["it is not Linux", { platform: "darwin" as const }],
    ["it is Bun", { bun: true }],
  ])("**does not restart when %s**", async (_, overrides) => {
    const node = runtime(overrides)
    await ensureSqlite(node)

    expect(node.restarts).toEqual([])
  })

  it("**gives the restarted command the user's search path back**, so what it starts checks its own SQLite", async () => {
    const env: NodeJS.ProcessEnv = {
      LD_LIBRARY_PATH: "/pkg/lib/linux-x64-gnu:/opt/user",
      CLI_MESSAGING_SQLITE_RESTARTED: "1",
      CLI_MESSAGING_USER_LD_LIBRARY_PATH: "/opt/user",
    }
    const node = runtime({ env, capable: vi.fn() })
    await ensureSqlite(node)

    expect(env).toEqual({ LD_LIBRARY_PATH: "/opt/user" })
    expect(node.capable).not.toHaveBeenCalled()
  })

  it("leaves no search path behind when the user had none", async () => {
    const env: NodeJS.ProcessEnv = { LD_LIBRARY_PATH: "/pkg/lib/linux-x64-gnu", CLI_MESSAGING_SQLITE_RESTARTED: "1" }
    await ensureSqlite(runtime({ env }))

    expect(env).toEqual({})
  })
})

describe("relay", () => {
  const host = () => {
    const events = new EventEmitter()
    return Object.assign(events, { pid: 42, exit: vi.fn(), kill: vi.fn() })
  }
  const child = () => Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess

  it("**passes on what stops the parent**, and lets Ctrl-C reach the child from the terminal alone", () => {
    const parent = host()
    const command = child()
    void relay(command, parent as never)

    parent.emit("SIGTERM")
    parent.emit("SIGHUP")
    parent.emit("SIGINT")

    expect(command.kill).toHaveBeenCalledWith("SIGTERM")
    expect(command.kill).toHaveBeenCalledWith("SIGHUP")
    expect(command.kill).toHaveBeenCalledTimes(2)
  })

  it("**leaves with the child's code**, or by the child's signal", () => {
    const parent = host()
    const command = child()
    void relay(command, parent as never)

    command.emit("exit", 3, null)
    expect(parent.exit).toHaveBeenCalledWith(3)

    command.emit("exit", null, "SIGTERM")
    expect(parent.listenerCount("SIGTERM")).toBe(0)
    expect(parent.kill).toHaveBeenCalledWith(42, "SIGTERM")
  })
})
