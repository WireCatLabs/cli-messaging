import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isolatedRegex } from "./legacy-regex.js"

const fake = (event?: string, payload?: unknown) => {
  const emitter = new EventEmitter()
  const terminate = vi.fn(async () => 0)
  const worker = () => {
    if (event) queueMicrotask(() => emitter.emit(event, payload))
    return Object.assign(emitter, { terminate }) as unknown as Worker
  }
  return { worker, emitter, terminate }
}
afterEach(() => vi.useRealTimers())
describe("isolated legacy JavaScript regex", () => {
  it("preserves JS flags/full-body semantics and resets state per body", async () => {
    expect(await isolatedRegex(/inv(oice)?\s+\d+/iu, ["Invoice 123", "invoice nope", "prefix inv 456 suffix"])).toEqual(
      [0, 2],
    )
    expect(await isolatedRegex(/alpha/g, ["alpha", "alpha"])).toEqual([0, 1])
  })
  it.each([
    ["message", "invalid"],
    ["error", new Error("synthetic worker failure")],
    ["exit", 1],
  ])("terminates on %s without leaking message bodies", async (event, payload) => {
    const worker = fake(event, payload)
    await expect(isolatedRegex(/a/, ["a"], { worker: worker.worker })).rejects.toThrow("regex worker")
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it("cleans up the timer and worker after success", async () => {
    vi.useFakeTimers()
    const worker = fake("message", [0])
    expect(await isolatedRegex(/a/, ["a"], { worker: worker.worker })).toEqual([0])
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("terminates runaway execution on the deadline", async () => {
    vi.useFakeTimers()
    const worker = fake()
    const promise = isolatedRegex(/(a+)+$/u, [`${"a".repeat(100)}!`], { worker: worker.worker, timeoutMs: 1 })
    const rejected = expect(promise).rejects.toThrow("time budget")
    await vi.advanceTimersByTimeAsync(2)
    await rejected
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("handles abort before start and while running", async () => {
    const aborted = new AbortController()
    aborted.abort()
    await expect(isolatedRegex(/a/, ["a"], { signal: aborted.signal })).rejects.toThrow("aborted")
    const controller = new AbortController(),
      worker = fake()
    const promise = isolatedRegex(/a/, ["a"], { signal: controller.signal, worker: worker.worker })
    const rejected = expect(promise).rejects.toThrow("aborted")
    controller.abort()
    await rejected
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it("rejects budgets before creating a worker", async () => {
    const worker = fake()
    await expect(isolatedRegex(new RegExp("a".repeat(1025)), [], { worker: worker.worker })).rejects.toThrow("pattern")
    await expect(
      isolatedRegex(
        /a/,
        Array.from({ length: 50001 }, () => ""),
        { worker: worker.worker },
      ),
    ).rejects.toThrow("candidate rows")
    await expect(isolatedRegex(/a/, ["a".repeat(8388609)], { worker: worker.worker })).rejects.toThrow("body bytes")
    expect(worker.terminate).not.toHaveBeenCalled()
  })
})
