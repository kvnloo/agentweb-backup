# Cycle 033 — A-008 shim is not swarm’s unused barrel; LoopPorts is the bus

UTC: 2026-09-11T19:27Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). Expanded filter including `swarm/index` /
   `vendorMeteringCoverageGuard` / `loops/core/ports`: still only
   **#2563** → `sdkConstructionGuard.test.ts`. A-008 / A-007 target files
   empty.

2. **`services/swarm/index.ts` is the wrong A-008 analog.** L7–12 is a
   folder barrel (`export * from './types'` … `workerCoordinator`). **Zero**
   production `from '…/services/swarm'` importers. Tests import sibling
   files (`../taskFilter`, `../prioritySorter`, …), not the barrel. Citing
   it as “leave a re-export at the old path” would invent a pattern this
   tree does not use for path compatibility.

3. **Closest live analog: `socialPlatformService.ts` L8.** The file
   **stays** at `services/socialPlatformService.ts`, does
   `export * from './adapters/socialPlatformTypes'`, and keeps the registry
   object. Callers keep the old specifier:
   `socialPostsService.ts` L2; `connectedAccountsDb.ts` L1117
   `await import('./socialPlatformService')`; `agentModeService.ts`
   dynamic imports (~L35470+). A-008 first slice is **thinner**: after
   `git mv` to `services/creative/imageGeneration.ts`, the old path is a
   one-line shim `export * from './creative/imageGeneration'` so
   `normalizeImageModel` / `ImageService` / `imageService`
   (`imageGeneration.ts` L49 / L68 / L1568) keep resolving. Do not turn the
   shim into a registry like socialPlatformService. Do not add
   `services/creative/index.ts` as the only entry (that would force every
   importer to change).

4. **In-process composition bus already exists — `LoopPorts`.**
   `loops/core/ports.ts` L143–150 bundles six ports: `s3`, `dynamo`,
   `bedrock`, `slack`, `clock`, `logger`. Wired once at
   `loops/adapters/awsAdapters.ts` `productionLoopPorts()` L219–227
   (`aws-sdk` + Slack). Instances inject that factory; `loops/core` never
   imports AWS. That is Microsoft modular-monolith composition (logical
   nanoservices). A 60-tool HTTP mesh would redo this poorly. A-008 is a
   **folder + shim**, not a seventh port and not a fifth process.

5. **A-002 sibling precedent (secondary).**
   `vendorMeteringCoverageGuard.test.ts` L4: “Sibling to
   `sdkConstructionGuard.test.ts`”. AgentWeb already ratchets with a
   **new file**, not an append. Reinforces cycle 31: do not edit
   `sdkConstructionGuard.test.ts` while #2563 is open.

## DISCARD / rank

No rank change. A-008 stays **ready**; first_slice text is corrected
(swarm barrel → path shim). A-006 stays discard (LoopPorts already
composes host IO without HTTP). Product READY unchanged.

## Mapping evidence

`SERVICES_DAG.md` step 2. `COMPOSITION.md` A-008 line. `queue.json`
A-008 first_slice.

## Next

Cycle 34: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
