# Reply and model adoption complete

Status: 2026-10-06, shared implementation and consumer adoption merged; no live operations.
SDK 0.156.0 published with provenance from ca6b812. Shared features: #621, #622, #628;
publication #632. MAX #433 (eaf48e6), Telegram #303 (e906382) pin 0.156.0.
New reply command/option rows are present in both consumer command trees and marked all.

Consumer checks: lint, typecheck, full tests, parity, docs, generated discovery and argv matrices.
MAX 1463 passed / 2 existing skips; Telegram 1133 passed / 1 existing skip. Matrix gaps: zero.
All exact-head Linux/macOS/Windows/Bun/package/install checks passed. Native MAX task opening,
purpose settings/source reporting and all new reply options were driven through isolated CLIs.
No real account or external model calls. Consumer npm publication remains separate.
