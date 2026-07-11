# GeoVerse SAR — Spatial Application Runtime

**English** | [简体中文](./README.zh-CN.md)

An AI-native runtime for spatial applications, built above the [GeoVerse](https://github.com/) SDK on a strict hexagonal (ports-and-adapters) architecture: **the kernel does not know what a "map" is**.

> Status: architecture milestones M1–M4 of RFC-0008 are complete (145 unit tests, real-LLM end-to-end acceptance for both the Copilot entry and the autonomous Agent entry). Packages are **not yet published to npm** — see [Develop from source](#develop-from-source).

## Why SAR

Most agent frameworks orchestrate _conversations_. SAR orchestrates _application state_ — and treats the human UI, the AI Copilot, the autonomous Agent and external MCP clients as **the same runtime with different entries**:

- **Every ability is a Capability** — self-describing (Zod schema), discoverable, invocable, composable. A capability descriptor _is_ a Claude/MCP tool definition (`id ≡ name`, `inputJsonSchema ≡ input_schema`) — one projection backs the UI command palette, the AI tool catalog and MCP `tools/list`.
- **Every operation goes through one funnel** — `dispatcher.invoke`: middleware onion → permissions → service checks → Zod validation → handler → write routing → events. UI clicks, AI tool calls and MCP calls differ only by `caller.entry`. Cross-entry parity is pinned by tests, not by convention.
- **Domain-state undo is first class** — engines plug in through a generic diff port (`StateEngine<TEntity, TDiff>` + `DiffAlgebra{merge, invert, apply}`). Workflows pre-merge step diffs into **one undo unit** (macro undo) without touching the engine.
- **Writes are previewable** — `dryRun` returns "what would change" as a diff without applying it; the agent's approval gate shows this diff to a human before executing.
- **Governance lives in the kernel, not in the agent loop** — permission whitelists clip the catalog _and_ gate invocation with the same predicate; `createAuditLog` records every call across all entries; `AbortSignal` threads through the funnel (no half-applied writes); `createJournal`/`replayJournal` persist and replay transaction history with identical final state _and undo granularity_.
- **NL never enters the kernel** — natural-language routing lives in the `planner`/`agent` packages behind provider-agnostic ports (`LlmClient`, `AgentPolicy`); every one of the 145 tests runs without a real LLM.

## Architecture

```
Entries (zero domain logic: project the catalog out, route calls back in)
  program (kernel.invoke) · ui (toPaletteItems) · ai (skill) · planner (M3) · agent (M4) · mcp
        │                        caller.entry distinguishes; events are one shared stream
        ▼
@geoverse-sar/kernel  (depends on zod only — enforced by an ESLint dependency gate)
  Capability / Registry        read | write | action
  Dispatcher (single funnel)   middleware → permissions → validation → handler → write routing
  Workflow + TransactionGroup  inter-step dataflow + macro undo
  Governance                   AbortSignal · permissions · audit log · journal replay
  Self-diagnosis               runDoctor (assembly checks) · ErrorMonitor · explainError hints
        │   the only abstraction the kernel knows: StateEngine<TEntity, TDiff> + DiffAlgebra
        ▼
Engines                        engine-memory (reference) · engine-geo (wraps @geoverse/editor-core, zero changes)
Capability packs               capabilities-records (in-memory domain) · capabilities-geo (GeoJSON domain)
```

## Packages

| Package                                                                 | Role                                                                                                                       | Tests |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----- |
| [`@geoverse-sar/kernel`](./packages/kernel)                             | Pure mechanism: capability/registry/dispatcher/workflow/txgroup/events/permissions/doctor/audit/journal/store/`SarClient`  | 121   |
| [`@geoverse-sar/workspace`](./packages/workspace)                       | Lifecycle assembly: `openWorkspace` — restore (snapshot + journal tail), checkpoint (undo horizon), single-writer lock     | 26    |
| [`@geoverse-sar/server`](./packages/server)                             | Service form (Node-only): thin HTTP+WS layer — wire = `InvokeOutcome`, token → `CallerInfo`, EventBus bridged to WS        | 17    |
| [`@geoverse-sar/engine-memory`](./packages/engine-memory)               | Reference engine + diff algebra (fast-check algebraic laws)                                                                | 11    |
| [`@geoverse-sar/engine-geo`](./packages/engine-geo)                     | GeoVerse adapter: wraps `@geoverse/editor-core` `EditEngine` untouched + dual-channel `ChangeSetAlgebra` + geometry bridge | 8     |
| [`@geoverse-sar/capabilities-records`](./packages/capabilities-records) | Record-domain pack: 8 capabilities + a macro-undo workflow                                                                 | 12    |
| [`@geoverse-sar/capabilities-geo`](./packages/capabilities-geo)         | GeoJSON feature pack: 30+ capabilities incl. draw/split/merge, transforms, holes, query/analysis, spatial observer         | 32    |
| [`@geoverse-sar/skill`](./packages/skill)                               | AI entry: `toToolSpecs` + `handleToolCall` (+ `SarClient` twins, byte-for-byte parity; failures carry actionable hints)    | 18    |
| [`@geoverse-sar/planner`](./packages/planner)                           | NL→capability routing: tool-use loop, SSE streaming `LlmClient`, headless chat controller                                  | 11    |
| [`@geoverse-sar/agent`](./packages/agent)                               | Autonomous entry: observe→plan→act loop, `AgentPolicy` port, approval gate with dryRun diff preview                        | 11    |
| [`@geoverse-sar/mcp`](./packages/mcp)                                   | MCP entry: `tools/list` ≡ descriptor projection, `tools/call` → the same funnel                                            | 5     |

## Quick tour (playground)

Five pages, one runtime — `pnpm playground:dev` then open `http://localhost:8090`:

| Page           | What it shows                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `/index.html`  | Command palette (UI entry) + manual tool calls side by side, plus a one-click **doctor** report     |
| `/chat.html`   | Real LLM chat (DeepSeek) driving the in-memory domain — streaming, abort, macro undo                |
| `/geo.html`    | A real GeoVerse map (`GMap`): the LLM queries, draws, splits, merges features and switches basemaps |
| `/agent.html`  | The autonomous agent: observe→plan→act trace, approval gate toggle, live audit panel                |
| `/remote.html` | Remote mode: the whole page is one `createRemoteClient` — start `pnpm playground:server` first      |

LLM pages need a DeepSeek key: put `DEEPSEEK_API_KEY=...` in a repo-root `.env` (gitignored; the key is injected by the Vite dev proxy and never reaches the browser bundle).

## Develop from source

Prerequisites: **Node ≥ 20, pnpm ≥ 10**, and a sibling checkout of the `geoverse` repo (SAR links `@geoverse/editor-core` and `@geoverse/core-ol` via pnpm `file:` until they are published):

```
workspace/
├── geoverse/   # build it first: pnpm install && pnpm -r build
└── sar/        # this repo
```

```shell
pnpm install
pnpm build        # inter-package resolution goes through dist — build first
pnpm typecheck && pnpm lint && pnpm test
pnpm playground:dev
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development, debugging and **verification** guide (quality gates, smoke tests, real-LLM acceptance rules, commit conventions).

## Documentation

Reader guides live in [`docs/`](./docs/README.md): [concepts](./docs/concepts.md) · [writing capability packs](./docs/capabilities.md) · [workflows & macro undo](./docs/workflows.md) · [the entries](./docs/entries.md) · [NL planner & headless chat](./docs/planner.md) · [autonomous agent & governance](./docs/agent.md) · [bringing your own engine](./docs/engines.md) · [persistence](./docs/persistence.md) · [remote mode](./docs/remote.md) · [doctor & error analysis](./docs/doctor.md) — plus a README per package.

Design records: RFC-0008 / RFC-0009 and ADR-0010…0013 (shared design vault, not in this repo).

## License

MIT
