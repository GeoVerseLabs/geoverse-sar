# GeoVerse SAR — Spatial Application Runtime

AI-native runtime for spatial applications, built above the GeoVerse SDK (hexagonal / ports-and-adapters: **the kernel does not know what a "map" is**).

- Every ability is a **Capability** — self-describing (Zod), discoverable, invocable, composable.
- Every operation goes through a single **`dispatcher.invoke`** funnel — UI clicks, AI tool calls and MCP calls only differ by `caller.entry`; cross-entry parity is pinned by tests.
- **Workflows** compose capabilities with inter-step dataflow and **macro undo** (`TransactionGroup` pre-merges step diffs via `DiffAlgebra.merge` and dispatches once — the engine is untouched).
- **Self-diagnosis built in**: `runDoctor` audits the assembly at startup (catalog / workflows / services / schemas / port smoke); `createErrorMonitor` + `explainError` aggregate runtime failures and feed actionable hints back to the model.
- **Governance built in (M4)**: `AbortSignal` threads through the funnel (no half-applied writes), permission whitelists clip the catalog *and* gate invoke with the same predicate, `createAuditLog` records every call across all entries, and `createJournal`/`replayJournal` persist and replay transaction history with identical final state and undo granularity.
- The kernel only depends on `zod` and the generic diff port `StateEngine<TEntity, TDiff>`; GeoVerse plugs in as just another adapter (`engine-geo` wraps `@geoverse/editor-core` untouched).

## Packages

| Package | Role |
|---|---|
| [`@geoverse-sar/kernel`](./packages/kernel/README.md) | Pure mechanism: Capability / Registry / Dispatcher / Workflow / TransactionGroup / EventBus / permissions / **doctor & diagnostics**. Zero domain, zero map. |
| [`@geoverse-sar/engine-memory`](./packages/engine-memory/README.md) | Reference engine: `InMemoryStateEngine<RecordEntity, RecordDiff>` + `RecordDiffAlgebra` (fast-check laws). |
| [`@geoverse-sar/engine-geo`](./packages/engine-geo/README.md) | GeoVerse adapter: `GeoStateEngine` wraps `@geoverse/editor-core` `EditEngine` (zero changes) + dual-channel `ChangeSetAlgebra`. |
| [`@geoverse-sar/capabilities-records`](./packages/capabilities-records/README.md) | Record-domain pack: query / add / translate / setProps / remove + history + view.focus + `highlightAndNudge` workflow. |
| [`@geoverse-sar/capabilities-geo`](./packages/capabilities-geo/README.md) | Feature-domain pack (GeoJSON): query/add + **draw/split/merge** (editor-core geometry operators mapped through the funnel) + view.focus/zoom/**setBase** — cross-engine isomorphism. |
| [`@geoverse-sar/skill`](./packages/skill/README.md) | AI entry: `toToolSpecs` (descriptor ≡ Claude tool definition) + `handleToolCall` (with `explainError` hints on failure). |
| [`@geoverse-sar/planner`](./packages/planner/README.md) | NL→capability routing (M3): provider-agnostic `LlmClient` port + tool-use loop with streaming progress events + headless chat controller. The kernel stays NL-free. |
| [`@geoverse-sar/agent`](./packages/agent/README.md) | Autonomous entry (M4): observe→plan→act loop with an `AgentPolicy` port, approval gate (dryRun diff preview), abort and budget — governance itself (permissions/audit) is enforced by the kernel. |
| [`@geoverse-sar/mcp`](./packages/mcp/README.md) | MCP entry: `tools/list` ≡ descriptor projection, `tools/call` → the same funnel (`caller.entry='mcp'`). |
| `examples/playground` | Four pages, one runtime: `/index.html` command palette + manual tool calls, `/chat.html` real LLM chat (DeepSeek, key injected by the dev proxy), `/geo.html` real map (GeoVerse `GMap`) driven by the LLM, `/agent.html` autonomous agent with approval gate + audit panel. |

## Docs

Guides live in [`docs/`](./docs/README.md): [concepts](./docs/concepts.md) · [writing capability packs](./docs/capabilities.md) · [workflows & macro undo](./docs/workflows.md) · [the four entries](./docs/entries.md) · [NL planner & headless chat](./docs/planner.md) · [autonomous agent & governance](./docs/agent.md) · [bringing your own engine](./docs/engines.md) · [doctor & error analysis](./docs/doctor.md).

Design records: RFC-0008, ADR-0010 ~ ADR-0013 (shared Obsidian vault `../docs`).

## Develop

```shell
pnpm install
pnpm build        # inter-package resolution goes through dist — build first
pnpm typecheck && pnpm lint && pnpm test
pnpm playground:dev   # port 8090; DeepSeek key: put DEEPSEEK_API_KEY in repo-root .env (never committed)
```
