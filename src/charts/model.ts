export const CHART_KINDS = ["messages", "active", "membership"] as const
export type ChartKind = (typeof CHART_KINDS)[number]
export type ChartPeriod = "day" | "week"

export interface ChartData {
  version: 1
  kind: "bar" | "line" | "grouped-bar"
  title: string
  x: { type: ChartPeriod; values: string[] }
  series: { name: string; values: (number | null)[] }[]
  unit: "messages" | "people"
  timezone: string
  partial: boolean
  reasons: ("store-incomplete" | "events-incomplete")[]
}

export interface ChartSize {
  width: number
  height: number
}

export interface RenderedChart extends ChartSize {
  bytes: Uint8Array
  format: "svg"
  mimeType: "image/svg+xml"
}

export interface ChartRenderer {
  render: (chart: ChartData, size: ChartSize) => Promise<RenderedChart>
}

export const CHART_SIZE: Readonly<ChartSize> = { width: 800, height: 400 }
