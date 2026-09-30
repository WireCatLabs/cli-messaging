import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, readlinkSync } from "node:fs"

/** Signal 0 checks that the process exists without touching it. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Whether `pid` is alive **and** carries `marker` (`NAME=value`) in its environment. A PID is handed
 * out again once its process is gone — after a crash or a reboot a recorded number may belong to
 * somebody else, who must never be signalled. Only the owner of a process may read its environment.
 */
export const carries = (pid: number, marker: string): boolean => {
  // PID 0 would ask about this whole process group.
  if (pid <= 0 || !alive(pid)) return false
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/environ`, "latin1")
        .split("\0")
        .some((entry) => entry.endsWith(marker))
    }
    if (process.platform === "darwin") {
      return execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes(marker)
    }
  } catch {
    return false
  }
  return false
}

/**
 * The other processes that have any of `paths` open, whichever app they belong to — a `serve` keeps
 * its lock under its own app's directory, where the other CLI cannot look. `undefined` when this
 * system cannot tell: no `/proc`, no `lsof`. `paths` must be real paths, as the kernel reports them.
 */
export const holdersOf = (paths: string[]): number[] | undefined => {
  if (process.platform === "linux") {
    const wanted = new Set(paths)
    return readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)
      .filter((pid) => {
        try {
          return readdirSync(`/proc/${pid}/fd`).some((fd) => {
            try {
              return wanted.has(readlinkSync(`/proc/${pid}/fd/${fd}`))
            } catch {
              return false
            }
          })
        } catch {
          return false
        }
      })
      .map(Number)
  }
  const pids = (listed: string) =>
    listed
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid)
  try {
    return pids(execFileSync("lsof", ["-t", "--", ...paths], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))
  } catch (error) {
    // lsof exits 1 when some file is open by nobody, and fails to start when it is not installed.
    const { status, stdout } = error as { status?: number; stdout?: string }
    return status === 1 ? pids(stdout ?? "") : undefined
  }
}
