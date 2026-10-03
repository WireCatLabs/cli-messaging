import { describe, expect, it } from "vitest"
import { dateEndpoint, dateRange, dayBoundary, timezoneOf } from "./dates.js"

const span = { start: 0, end: 10 }
describe("typed calendar boundaries", () => {
  it.each([
    ["2026-03-29", 23, "2026-03-28T23:00:00.000Z"],
    ["2026-10-25", 25, "2026-10-24T22:00:00.000Z"],
  ])("handles DST day %s", (day, hours, expected) => {
    const range = dateRange(day, day, true, true, "Europe/Madrid", span)
    expect(new Date(range.lower as number).toISOString()).toBe(expected)
    expect((Number(range.upper) - Number(range.lower)) / 3600000).toBe(hours)
    expect(range).toMatchObject({ lowerInclusive: true, upperInclusive: false })
  })
  it("handles inclusive/exclusive day and exact timestamp endpoints separately", () => {
    expect(dateEndpoint("2026-01-01", "UTC", "lower", false, span)).toEqual({
      time: Date.parse("2026-01-02T00:00:00Z"),
      inclusive: true,
    })
    expect(dateEndpoint("2026-01-01", "UTC", "upper", false, span)).toEqual({
      time: Date.parse("2026-01-01T00:00:00Z"),
      inclusive: false,
    })
    expect(dateEndpoint("2026-01-01T10:00:00+02:00", "UTC", "lower", false, span)).toEqual({
      time: Date.parse("2026-01-01T08:00:00Z"),
      inclusive: false,
    })
    expect(dateRange("*", "*", true, true, "UTC", span)).toEqual({ lowerInclusive: true, upperInclusive: true })
    expect(dayBoundary("2024-02-29", "UTC", true, span)).toBe(Date.parse("2024-03-01T00:00:00Z"))
    expect(dayBoundary("0099-01-01", "UTC", false, span)).toBe(Date.parse("0099-01-01T00:00:00Z"))
    expect(dayBoundary("0000-01-01", "UTC", false, span)).toBe(Date.parse("0000-01-01T00:00:00Z"))
    expect(dayBoundary("9999-12-31", "UTC", true, span)).toBe(Date.parse("+010000-01-01T00:00:00Z"))
  })
  it.each([
    "2026-02-29",
    "2026-13-01",
    "2026-01-32",
    "7d",
    "2026-01-01T25:00:00Z",
    "2026-01-01T10:00:00",
    "2026-02-30T10:00:00Z",
  ])("rejects invalid/unqualified date %s", (value) =>
    expect(() => dateEndpoint(value, "UTC", "lower", true, span)).toThrow(),
  )
  it("refuses nonexistent calendar days and timezone typos", () => {
    expect(() => dayBoundary("2011-12-30", "Pacific/Apia", false, span)).toThrow("does not exist")
    expect(() => timezoneOf("Europe/Imaginary")).toThrow("IANA timezone")
    expect(timezoneOf("UTC")).toBe("UTC")
    expect(timezoneOf()).toBeTruthy()
  })
})
