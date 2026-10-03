import { describe, expect, it, vi } from "vitest"
import { type PackageUpgradePorts, upgradePackage } from "./package-upgrade.js"

const input = { current: "1.0.0", command: "synthetic", packageName: "@synthetic/cli", check: false }
const fake = (): PackageUpgradePorts => ({
  installer: () => "npm",
  latest: async () => "2.0.0",
  install: vi.fn(() => 0),
})

describe("upgrading an installed package", () => {
  it.each([
    { check: true, latest: "2.0.0", installer: "npm" as const, reason: "checked" },
    { check: false, latest: undefined, installer: "npm" as const, reason: "unavailable" },
    { check: false, latest: "1.0.0", installer: "npm" as const, reason: "up_to_date" },
    { check: false, latest: "2.0.0", installer: "checkout" as const, reason: "manual" },
  ])("does not install for $reason", async ({ check, latest, installer, reason }) => {
    const ports = fake()
    ports.latest = async () => latest
    ports.installer = () => installer
    ports.afterUpdate = vi.fn(() => ({ restarted: [], left: [] }))
    const outcome = await upgradePackage({ ...input, check }, ports)
    expect(outcome.reason).toBe(reason)
    expect(outcome.result).toMatchObject({ updated: false, restarted: [] })
    expect(ports.install).not.toHaveBeenCalled()
    expect(ports.afterUpdate).not.toHaveBeenCalled()
  })

  it("announces, installs once, then awaits the host lifecycle result", async () => {
    const order: string[] = []
    const ports = fake()
    ports.onInstall = () => {
      order.push("start")
    }
    ports.install = vi.fn((argv) => {
      expect(argv).toEqual(["npm", "install", "-g", "@synthetic/cli@latest"])
      order.push("install")
      return 0
    })
    ports.afterUpdate = async () => {
      await Promise.resolve()
      order.push("servers")
      return { restarted: ["synthetic"], left: ["manual"] }
    }
    const outcome = await upgradePackage(input, ports)
    expect(order).toEqual(["start", "install", "servers"])
    expect(outcome.result).toMatchObject({ updated: true, restarted: ["synthetic"], latest: "2.0.0" })
    expect(outcome.left).toEqual(["manual"])
    expect(ports.install).toHaveBeenCalledOnce()
  })

  it("does not restart or retry when the installer fails", async () => {
    const ports = fake()
    ports.install = vi.fn(() => 7)
    ports.afterUpdate = vi.fn(() => ({ restarted: [], left: [] }))
    await expect(upgradePackage(input, ports)).rejects.toThrow("npm exited with 7; synthetic is still 1.0.0")
    expect(ports.install).toHaveBeenCalledOnce()
    expect(ports.afterUpdate).not.toHaveBeenCalled()
  })

  it("does not repeat installation when a host lifecycle callback fails", async () => {
    const ports = fake()
    ports.afterUpdate = async () => {
      throw new Error("synthetic lifecycle failure")
    }
    await expect(upgradePackage(input, ports)).rejects.toThrow("synthetic lifecycle failure")
    expect(ports.install).toHaveBeenCalledOnce()
  })
})

it("installs successfully with no host restart capability", async () => {
  const ports = fake()
  const outcome = await upgradePackage(input, ports)
  expect(outcome.result).toMatchObject({ updated: true, restarted: [] })
  expect(outcome.left).toEqual([])
  expect(ports.install).toHaveBeenCalledOnce()
})
