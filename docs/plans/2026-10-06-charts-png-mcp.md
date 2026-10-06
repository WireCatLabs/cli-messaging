# PNG chart export and MCP images

Status: approved by the owner on 2026-10-06; 🚧 `feat/charts-png-mcp`.

The existing `stats charts` command gains `.png` output beside `.svg`. The existing stored-only
`stats_charts` MCP tool gains optional `format: json|png`, default `json`; PNG returns image content
and the same chart data as JSON text. Both reuse a separate SVG-to-PNG encoder, keeping the
replaceable SVG renderer interface. No file is written by MCP and no messenger connection opens.

Use lazy `@resvg/resvg-js@2.6.2` and bundled Noto Sans Regular with its SIL OFL 1.1 license;
system fonts are disabled. Test Cyrillic labels, PNG pixels/dimensions, alternate SVG renderers,
CLI exclusive/private writes, unchanged default JSON, permission refusal and offline operation.
Verify the published font assets and Node/Bun behavior; CI checks Linux/macOS/Windows.
MAX adopts the published shared version; HTML reports remain a separate P3 item.
