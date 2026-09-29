import { execFileSync, spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths, writeSecurely } from "@leemour/cli-core"
import type { AppIdentity } from "../app.js"
import { alive } from "./serve-command.js"

export interface Job {
  id: string
  chat: string
  profile: string
  pid: number
  startedAt: string
  max: number
  log: string
  progress?: { fetched: number; chatId: string; oldest: number }
  finishedAt?: string
  result?: Record<string, unknown>
  error?: { code: string; message: string }
  cancelRequestedAt?: string
}

export type JobState = "running" | "done" | "failed" | "cancelled" | "died"

/** Starts `<cli> <argv>` apart from this process, writing to `log`, and answers its PID. Tests hand one in. */
export type SpawnJob = (argv: string[], env: NodeJS.ProcessEnv, log: string) => number

export const spawnDetached: SpawnJob = (argv, env, log) => {
  const out = openSync(log, "a", 0o600)
  try {
    const child = spawn(process.execPath, [realpathSync(process.argv[1] ?? ""), ...argv], {
      detached: true,
      stdio: ["ignore", out, out],
      env,
    })
    child.unref()
    return child.pid ?? 0
  } finally {
    closeSync(out)
  }
}

export const jobsDir = (app: AppIdentity, env: NodeJS.ProcessEnv): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "backfill")

const jobPath = (dir: string, id: string) => join(dir, `${id}.json`)

export const saveJob = (dir: string, job: Job): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeSecurely(jobPath(dir, job.id), `${JSON.stringify(job, null, 2)}\n`, 0o600)
}

export const readJob = (dir: string, id: string): Job | undefined => {
  if (!/^[\w-]+$/.test(id) || !existsSync(jobPath(dir, id))) return undefined
  try {
    return JSON.parse(readFileSync(jobPath(dir, id), "utf8")) as Job
  } catch {
    return undefined
  }
}

export const updateJob = (dir: string, id: string, change: Partial<Job>): void => {
  const job = readJob(dir, id)
  if (job) saveJob(dir, { ...job, ...change })
}

/** Newest first. */
export const listJobs = (dir: string): Job[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => readJob(dir, name.slice(0, -".json".length)) ?? [])
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    : []

/** A job that is gone without saying how it ended was killed, or crashed before it could — its log says which. */
export const stateOf = (job: Job): JobState => {
  if (job.finishedAt !== undefined) {
    if (job.cancelRequestedAt) return "cancelled"
    return job.error ? "failed" : "done"
  }
  if (isJob(job)) return "running"
  return job.cancelRequestedAt ? "cancelled" : "died"
}

/**
 * Whether the recorded PID is still **this job** — a PID is handed out again once its process is
 * gone, after a crash or a reboot, and `cancel` must never signal somebody else's process. The job
 * carries its id in its environment (`<PREFIX>_BACKFILL_JOB`), which only its owner may read.
 */
export const isJob = (job: Job): boolean => {
  // PID 0 would ask about this whole process group.
  if (job.pid <= 0 || !alive(job.pid)) return false
  const marker = `_BACKFILL_JOB=${job.id}`
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${job.pid}/environ`, "latin1")
        .split("\0")
        .some((entry) => entry.endsWith(marker))
    }
    if (process.platform === "darwin") {
      return execFileSync("ps", ["eww", "-o", "command=", "-p", String(job.pid)], { encoding: "utf8" }).includes(marker)
    }
  } catch {
    return false
  }
  return false
}
