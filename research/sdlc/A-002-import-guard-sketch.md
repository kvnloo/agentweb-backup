# A-002 import-guard sketch (research only — do not land this PR yet)

`coding_unlocked` is false. This is the test to copy when unlocked.
Do **not** add `dependency-cruiser`. AgentWeb already has an AST import
guard: `backend/src/__tests__/sdkConstructionGuard.test.ts` (walks
`ts.createSourceFile`, records `import` / `export` / `require` /
dynamic `import()` string literals).

## Contract

Walk every `.ts` file under `backend/src/loops/core/` except `__tests__`.

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
import `services/db` — onboarding already does). `loops/adapters/`
is the AWS host.

## Why not dependency-cruiser

`backend/package.json` has no depcruise. A new npm dep is a review
surface. The sdkConstructionGuard pattern is already in CI and already
catches alias/`require` lies that a regex grep would miss.

## Second ratchet (same PR or A-008)

Once `services/creative/` exists, the same walker forbids
`creative/**` → `agentModeService` (OMP `pi-ai ↛ pi-agent-core`).
Until the folder exists, walk `imageGeneration.ts` /
`videoGeneration.ts` / `remotionService.ts` instead.

## Acceptance

- New file e.g. `backend/src/__tests__/loopsCoreImportGuard.test.ts`
- Fails if anyone adds `import { userDb } from '../../services/db'` in
  `loops/core`
- Does not fail on today’s tree (cycle 18/20 greps: no `services/`
  imports in `loops/core`)
- Does not touch `agentModeService.ts`

Collision this cycle: **no** open PR on `loops/core`, `apiTools.ts`,
`imageGeneration.ts`, `usageRecorderService.ts`, or `llmClients.ts`.
