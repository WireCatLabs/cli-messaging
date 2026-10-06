import { describe, expect, it } from "vitest"
import { echartsOption } from "./echarts-option.js"
import { CHART_SIZE, type ChartData, type ChartRenderer } from "./model.js"
import { chartRenderer } from "./render.js"

const chart: ChartData = {
  version: 1,
  kind: "bar",
  title: "Сообщения <клуба> & ответы",
  x: { type: "day", values: ["2026-09-01", "2026-09-02", "2026-09-03"] },
  series: [{ name: "Messages", values: [4, null, 2] }],
  unit: "messages",
  timezone: "Europe/Madrid",
  partial: true,
  reasons: ["store-incomplete"],
}

const textOf = async (value: ChartData) =>
  new TextDecoder().decode((await (await chartRenderer()).render(value, CHART_SIZE)).bytes)

describe("dark SVG rendering", () => {
  it("maps the neutral data without losing gaps, zeroes or partial evidence", () => {
    expect(echartsOption(chart)).toMatchObject({
      animation: false,
      backgroundColor: "#111827",
      title: { text: chart.title, subtext: "Europe/Madrid · Partial data — lower bounds" },
      xAxis: { type: "category", data: chart.x.values },
      yAxis: { min: 0, minInterval: 1 },
      series: [{ type: "bar", data: [4, null, 2] }],
    })
    expect(echartsOption({ ...chart, kind: "line", partial: false })).toMatchObject({
      title: { subtext: "Europe/Madrid" },
      series: [{ type: "line", connectNulls: false }],
    })
    expect(echartsOption({ ...chart, kind: "grouped-bar" })).toMatchObject({ color: ["#34d399", "#fb923c"] })
  })

  it("renders escaped Cyrillic labels, axes and exactly the observed bars", async () => {
    const svg = await textOf(chart)
    expect(svg).toContain('<svg width="800" height="400"')
    expect(svg).toContain('fill="#111827"')
    expect(svg).toContain("<title>Сообщения &lt;клуба&gt; &amp; ответы</title>")
    expect(svg).toContain("Partial data")
    for (const key of chart.x.values) expect(svg).toContain(key)
    expect(svg.match(/fill="#818cf8"/g)).toHaveLength(2)
    expect(svg).not.toMatch(/<script|<image|@font-face/)
  })

  it("renders empty and line charts, and can be replaced through the small interface", async () => {
    expect(await textOf({ ...chart, x: { type: "day", values: [] }, series: [] })).toContain("No data")
    expect(await textOf({ ...chart, kind: "line" })).toContain("<svg")
    const other: ChartRenderer = {
      render: async (_chart, size) => ({
        bytes: new TextEncoder().encode("<svg/>"),
        format: "svg",
        mimeType: "image/svg+xml",
        ...size,
      }),
    }
    expect(new TextDecoder().decode((await other.render(chart, CHART_SIZE)).bytes)).toBe("<svg/>")
  })
})
