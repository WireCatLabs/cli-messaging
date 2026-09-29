import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

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
