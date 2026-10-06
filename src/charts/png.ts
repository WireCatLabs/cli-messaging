import { fileURLToPath } from "node:url"
import type { ChartSize, RenderedChart } from "./model.js"

export interface RenderedPng extends ChartSize {
  bytes: Uint8Array
  format: "png"
  mimeType: "image/png"
}

export const chartPng = async (svg: RenderedChart): Promise<RenderedPng> => {
  const { renderAsync } = await import("@resvg/resvg-js")
  const image = await renderAsync(Buffer.from(svg.bytes), {
    font: {
      fontFiles: [fileURLToPath(new URL("./fonts/NotoSans-Regular.ttf", import.meta.url))],
      loadSystemFonts: false,
      defaultFontFamily: "Noto Sans",
      sansSerifFamily: "Noto Sans",
    },
  })
  return { bytes: image.asPng(), format: "png", mimeType: "image/png", width: image.width, height: image.height }
}
