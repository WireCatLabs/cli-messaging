import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const SQLITE_VERSION = "3.53.4"

const here = dirname(fileURLToPath(import.meta.url))

export const libraryFor = ({ platform = process.platform, arch = process.arch, musl = false } = {}) => {
  const path =
    platform === "darwin"
      ? join(here, "lib", "darwin", "libsqlite3.dylib")
      : platform === "linux"
        ? join(here, "lib", `linux-${arch}-${musl ? "musl" : "gnu"}`, "libsqlite3.so.0")
        : undefined
  return path !== undefined && existsSync(path) ? path : undefined
}
