# A-002 import-guard sketch (research only — do not land this PR yet)

`coding_unlocked` is false. This is the test to copy when unlocked.
Do **not** add `dependency-cruiser`. AgentWeb already has an AST import
guard: `backend/src/__tests__/sdkConstructionGuard.test.ts` (walks
`ts.createSourceFile`, records `import` / `export` / `require` /
dynamic `import()` string literals).

## Contract

Walk every `.ts` file under `backend/src/loops/core/` except `__tests__`.

Cycle 34 oracle (2026-09-11T19:30Z): **20** prod files, **35** import
specifiers (cycle 27 said 18 files; specifier count was already 35).
**Escapes from `loops/core/`:** only

| File | Line | Specifier |
|---|---|---|
| `orchestrator.ts` | 27 | `../index` |
| `instanceRunner.ts` | 22 | `../index` |

Zero `services/` / `emma/` / `db`. A first PR that fails on any *new*
escape (or on those two disappearing without a comment) is the ratchet.
`instanceRunner.ts` L8–11 documents `../index` as deliberate.

**Forbidden** module specifiers (after resolving relative paths against
the file, or as a substring on the raw specifier):

- `/services/` (except nothing — even relative `../../../services/db`)
- `/emma/`
- ending in `/db` or `/db.ts` that resolves to `services/db`

**Allowed:**

- relative imports that stay inside `loops/core/`
- `from '../index'` / `from '../index.ts'` (`orchestrator.ts`,
  `instanceRunner.ts` L14–22 — documented)
- `from './ports'`, `./types`, `./orchestrator`, etc.
- type-only imports of ports

**Not in scope for the first PR:** `loops/instances/**` (those *may*
import `services/db` — `onboarding/index.ts` L35 `userDb`;
`ai-eval-funnel/rcaEnricher.ts` L25 imports `agentModeService` and L227
calls `callLLM` — A-003 lane). `loops/adapters/awsAdapters.ts` is the
AWS host (cycle 28): implements `ports.ts` with `aws-sdk`, **must not**
be imported from `core/`. `loops/adapters/` is the AWS host.

## Why not dependency-cruiser

`backend/package.json` has no depcruise. A new npm dep is a review
surface. The sdkConstructionGuard pattern is already in CI and already
catches alias/`require` lies that a regex grep would miss.

## Second ratchet (A-008, not the same as loops/core)

Once `services/creative/` exists, forbid `creative/**` → `agentModeService`
(OMP `pi-ai ↛ pi-agent-core`). Until the folder exists, walk
`imageGeneration.ts` / `videoGeneration.ts` / `remotionService.ts`.

## Do not copy the loops/core rule onto `agentMode/core` (cycle 22)

`agentMode/core/**` does **not** import `agentModeService.ts` (no static
or `import()`). But `core/toolDispatch.ts` L28 imports
`../../agentToolGatewayService` (type-only). A “forbid all of `services/`”
walker would fail today.

The copied rule for core is narrower: **forbid only `agentModeService.ts`**
(the 40.5k monolith). Allow gateway, `utils/`, `observability/`.

**Prod outbound allowlist** (cycle 23, `agentMode/core/*.ts` excluding
`__tests__`):

| Specifier | File |
|---|---|
| `../../agentToolGatewayService` (type-only) | `toolDispatch.ts` L28 |
| `utils/toolErrorClassifier`, `toolResultError`, `citations`, `toolResponseS3Ref` | `toolDispatch.ts` |
| `observability/tracing`, `semconv` | `toolDispatch.ts` L39–41 (“NOT ports”; spans no-op without exporter) |
| `utils/turnTimeBudget`, `toolErrorClassifier` | `synthesisResidue.ts` |
| `crypto` | `geminiNativeClient.ts` |

`executeAgentStep` still throws (`agentStep.ts` L48–55). A-003 still park.

Do **not** walk all of `services/agentMode/` — `brandLogo.ts` L600–603
`await import('../agentModeService')` is a deliberate cycle break.
That file is outside `core/`.

## Acceptance

- New file e.g. `backend/src/__tests__/loopsCoreImportGuard.test.ts`
- Fails if anyone adds `import { userDb } from '../../services/db'` in
  `loops/core`
- Does not fail on today’s tree (cycle 34: 20 files, 35 specifiers, two
  `../index` escapes; no `services/` imports in `loops/core`)
- Does not touch `agentModeService.ts`

Collision cycle 31 (20 open PRs): still **no** open PR on `loops/core`,
`apiTools.ts`, `imageGeneration.ts`, `agentMode/core`, or `brandLogo.ts`.
**#2563** *does* edit `sdkConstructionGuard.test.ts` (+11 remnant
`not.toContain` on `vertex_client*` / `convertContentToAnthropicBlocks`).
It does **not** touch `findDirectProviderSdkImports` (L41–68). First
slice stays a **sibling** file — do not append to that describe while
#2563 is open. A-007 first-slice map is `A-007-split-map.md`.
