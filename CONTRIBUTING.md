# Contributing / 开发指南

This guide covers environment setup, day-to-day development, debugging and — most importantly — **how to verify a change**. 中文读者：架构与硬约束的中文详解见 [CLAUDE.md](./CLAUDE.md) 与 [docs/](./docs/README.md)，本文与其内容一致。

## 1. Environment

- **Node ≥ 20**, **pnpm ≥ 10** (`packageManager` pins `pnpm@10.11.0`).
- A sibling checkout of the **geoverse** repo, built at least once — SAR links `@geoverse/editor-core` (engine-geo) and `@geoverse/core-ol` (playground) via pnpm `file:` until they are published to npm:

```
workspace/
├── geoverse/        # git clone …; cd geoverse && pnpm install && pnpm -r build
└── sar/             # this repo
```

```shell
cd sar
pnpm install
pnpm build
```

> **`file:` dependencies are snapshots, not live links.** After rebuilding anything in `geoverse/`, run `pnpm install` here again to refresh the copied dist.

## 2. Repo layout & dependency direction

```
packages/
  kernel                 # pure mechanism — may import zod ONLY (ESLint-enforced)
  engine-memory          # reference engine            → kernel
  engine-geo             # GeoVerse adapter            → kernel (+ @geoverse/editor-core)
  capabilities-records   # record-domain pack          → kernel + engine-memory
  capabilities-geo       # GeoJSON feature pack        → kernel + engine-geo
  skill                  # AI entry                    → kernel
  planner                # NL routing + headless chat  → kernel + skill
  agent                  # autonomous loop             → kernel + skill + planner
  mcp                    # MCP entry                   → kernel + skill
examples/playground      # four demo pages (Vite MPA, aliases point at package src)
docs/                    # reader guides (one topic per file)
```

Dependency direction is **outer → inner only** and is enforced by ESLint (`pnpm lint` fails on violation). The kernel importing anything map-related is the falsifiable definition of "this is a runtime, not an SDK wrapper" — don't loosen the gate.

## 3. Everyday commands

```shell
pnpm build                                   # all packages (topological); dts + ESM via vite
pnpm typecheck / pnpm lint / pnpm test       # the gates (see §5)
pnpm --filter @geoverse-sar/kernel test      # one package
pnpm --filter @geoverse-sar/kernel exec vitest run tests/txgroup.test.ts   # one file
pnpm playground:dev                          # port 8090, four pages
```

**Build-order gotcha**: packages resolve each other **through `dist`**. After changing an inner package's public API, rebuild that package before running a dependent package's typecheck/tests — otherwise you get "Failed to resolve entry" or stale `.d.ts` types. The playground is the exception at runtime (Vite aliases point at `src`), but its `tsc --noEmit` still reads dist types.

## 4. Debugging

- **Playground first**: `/index.html` has a command palette wired to the same funnel plus a one-click **doctor** report (assembly health: catalog, tool-name bijection, schema derivation, service requirements, workflow references, port smoke).
- **LLM pages** (`/chat.html`, `/geo.html`, `/agent.html`): put `DEEPSEEK_API_KEY=...` in the repo-root `.env` (gitignored). The Vite dev proxy injects the Authorization header — the key never reaches the browser bundle, and production builds intentionally have no proxy.
- **Runtime failure analysis**: wire `createErrorMonitor()` middleware and inspect `report()` — it aggregates failures by capability, error code and the parameter paths models most often get wrong. `explainError` turns any failed outcome into an actionable hint (the AI entry attaches it automatically).
- **Audit**: `createAuditLog()` middleware records every invoke across all entries with caller attribution — the `/agent.html` page shows a live panel.

## 5. How to verify a change (the gates)

Every change must pass the four local gates, run from the repo root:

```shell
pnpm typecheck   # tsc --noEmit in every package
pnpm lint        # eslint (includes the dependency-direction gate)
pnpm test        # vitest, node environment — 145 tests and counting
pnpm build       # vite lib builds + d.ts generation must succeed
```

Additional verification, depending on what you touched:

| You changed… | Also verify |
|---|---|
| Anything user-visible in the playground | `pnpm playground:dev` and exercise the page; for built output run `pnpm --filter @geoverse-sar/playground build` and check the console for unresolved-import stubs |
| A capability or workflow | dryRun / undo / txgroup-projection tests for it; run doctor (playground button or `runDoctor(kernel)`) — descriptions shorter than 15 chars and broken step references are treated as assembly defects |
| LLM-facing behaviour (planner/agent/skill) | Unit tests use **scripted fake clients/policies** — determinism is mandatory; never make a unit test call a real LLM |
| End-to-end acceptance (milestone-level) | A throwaway real-LLM smoke script (see the pattern in git history: DeepSeek + assertions + delete after run). Real-LLM smoke is *evidence*, not CI — a failed assertion means rerun first, model nondeterminism is not a kernel bug |

**Invariants pinned by tests — do not break**: cross-entry parity (`invoke` ≡ `handleToolCall` ≡ MCP `tools/call`), macro-undo folding (`undoDepth === 1` after a multi-write workflow), schema parity (UI palette ≡ AI tool specs), dryRun leaves state and undo stack untouched, journal replay reproduces final state *and* undo granularity.

## 6. Testing philosophy

- Kernel tests use a **minimal in-repo Item engine** (`packages/kernel/tests/helpers.ts`), deliberately *not* engine-memory — proving domain neutrality.
- Diff algebras carry **fast-check property tests** (invert round-trip, merge ≡ sequential apply). Assertions must be key-order-independent deep equality.
- Nondeterminism (LLMs) is isolated behind ports (`LlmClient`, `AgentPolicy`); tests script the port.

## 7. Commits & changesets

- **Conventional Commits with Chinese subjects** (repo convention): `type(scope): 中文简述` — `feat/fix/refactor/docs/test/chore…`; scope is the package short name (`kernel`, `engine-geo`, `capabilities-geo`, `skill`, `planner`, `agent`, `mcp`, `playground`, `repo`), comma-separated when spanning packages. Group commits by feature batch.
- Cross-package source changes need a **changeset** (`.changeset/*.md`, patch-level for now), committed separately as `chore(changeset): …`.
- Never `--no-verify`; never skip hooks.

## 8. Known constraints (read before you fight them)

- `TDiff` must be JSON-serializable (journal/audit persistence contract).
- Geometry is **planar Euclidean** throughout — no CRS transforms in capabilities; coordinate units are the caller's business.
- Batch write capabilities fail **atomically** (any missing id rejects the whole command) — by design.
- View capabilities (`view.*`) are `action`s backed by host-injected services; missing services fail fast with `service_missing` (declared via `requires`).
