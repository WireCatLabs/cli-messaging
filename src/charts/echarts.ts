import { BarChart, LineChart } from "echarts/charts"
import { GraphicComponent, GridComponent, LegendComponent, TitleComponent } from "echarts/components"
import { init, use } from "echarts/core"
import { SVGRenderer } from "echarts/renderers"
import { echartsOption } from "./echarts-option.js"
import type { ChartRenderer } from "./model.js"

use([BarChart, LineChart, GraphicComponent, GridComponent, LegendComponent, TitleComponent, SVGRenderer])

export const echartsRenderer: ChartRenderer = {
  render: async (chart, size) => {
    const instance = init(null, undefined, { renderer: "svg", ssr: true, ...size })
    try {
      instance.setOption(echartsOption(chart))
      const title = chart.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      const svg = instance.renderToSVGString().replace(/<svg\b[^>]*>/, (opening) => `${opening}<title>${title}</title>`)
      return {
        bytes: new TextEncoder().encode(svg),
        format: "svg",
        mimeType: "image/svg+xml",
        ...size,
      }
    } finally {
      instance.dispose()
    }
  },
}
