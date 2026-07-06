# GeoVerse SAR — Spatial Application Runtime

AI-native runtime for spatial applications, built above the GeoVerse SDK (hexagonal / ports-and-adapters: the kernel does not know what a "map" is).

- Every ability is a **Capability** — self-describing (Zod), discoverable, invocable, composable.
- Every operation goes through a single **`dispatcher.invoke`** funnel — UI clicks, AI tool calls and MCP calls only differ by `caller.entry`.
- **Workflows** compose capabilities with inter-step dataflow and **macro undo** (`TransactionGroup` pre-merges step diffs via `DiffAlgebra.merge` and dispatches once — the engine is untouched).
- The kernel only depends on `zod` and the generic diff port `StateEngine<TEntity, TDiff>`; GeoVerse plugs in later as just another adapter.

## Packages

| Package | Role |
|---|---|
| `@geoverse-sar/kernel` | Pure mechanism: Capability / Registry / Dispatcher / Workflow / TransactionGroup / EventBus / permissions. Zero domain, zero map. |
| `@geoverse-sar/engine-memory` | MVP engine: `InMemoryStateEngine<RecordEntity, RecordDiff>` + `RecordDiffAlgebra`. |
| `@geoverse-sar/capabilities-records` | Capability pack over point records: query / add / translate / setProps / undo / redo / focus + `highlightAndNudge` workflow. |
| `@geoverse-sar/skill` | AI entry: `toToolSpecs` (descriptor ≡ Claude tool definition) + `handleToolCall`. |
| `examples/playground` | One domain, two panels: command palette (UI entry) + Copilot tool-call panel (AI entry) over the same kernel. |

Design docs: RFC-0008, ADR-0010 ~ ADR-0013 (shared Obsidian vault `../docs`).

## Develop

```shell
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm playground:dev
```
