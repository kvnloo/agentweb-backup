# Cycle 66 — one session, one process (the lock is the composition boundary)

**UTC:** 2026-09-11T21:02:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 65: `sseProgress` Maps are parent-heap only. Is that a
one-off, or is *concurrency* itself in-process — so a fifth
`listen()` would race the lock?

## Finding

**The tree already documents the invariant: different processes never
write the same session. `tryClaimSessionGeneration` is an in-memory
Set. A fifth image process would break that unless it shared the
Set (Redis / Dynamo — Harsha).**

### The documented assumption

`utils/keyedMutex.ts` L12–15 (ENG-510):

> In-process only, which is sufficient here: a session's generation
> is guarded by `tryClaimSessionGeneration` to a single in-flight
> run, so all of a session's concurrent appends originate in one
> process. **Different processes/instances never write the same
> session concurrently.**

The mutex (`tails` Map L17) exists so parallel image-variant
appends do not collide on `messageIndex`. It is not a distributed
lock.

### The claim is a synchronous Set

`agentModeController.ts` L936–956: `activeSessionGenerations` is a
`Set<string>`. `tryClaimSessionGeneration` is check-and-set in one
synchronous function so an `await` cannot be inserted between
`has()` and `add()`. 409 on conflict. `releaseSessionGeneration` L963
is idempotent.

The **worker fork** is still the same session's process family: the
parent holds the Set, then `runInWorker`. A second `/generate` on
another EB instance is assumed not to happen (sticky / one
claimant). The comment at L12–15 treats that as given, not as a
Redis todo.

### Same family (do not merge, do not extract)

| Structure | File | Role |
|---|---|---|
| `activeSessionGenerations` | controller L936 | one generate per session |
| `keyedMutex` `tails` | `keyedMutex.ts` L17 | serialize appends *given* the claim |
| `sseProgress` Maps | cycle 65 | SSE callbacks, same heap |
| `cronEnabled` | `instanceState.ts` L10–11 | no Redis |
| `cronJobRegistry.inFlight` | `cronJobRegistry.ts` L30 | drain (ENG-1189) |

Hermes keeps the agent in one process. OMP session state is
in-process. AgentWeb's cutting-edge SDLC move is **folders + AST
guards** (A-002), not a lock service. Do not HTTP-split
`generateImage` (A-006): the claim + mutex assume the leaf runs
where the session was claimed. A-017 (`getIo()`) does not touch
these Sets.

## Queue effect

None. A-017 stays park (Socket.IO only). A-006 stays discard (new
citation: `keyedMutex.ts` L12–15). Product READY unchanged.

## Next

Cycle 67: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
