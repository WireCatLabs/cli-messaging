import type { ChartRenderer } from "./model.js"

export const chartRenderer = async (): Promise<ChartRenderer> => (await import("./echarts.js")).echartsRenderer
