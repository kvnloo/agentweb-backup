# Cycle 67 — scale-out template is Dynamo metadata, not a fifth listen()

**UTC:** 2026-09-11T21:04:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 66: `keyedMutex.ts` L12–15 assumes different processes never
write the same session. Is that a fleet fact (sticky / size=1), or
does this tree already have a scale-out pattern — and is it HTTP
nanoservices?

## Finding

**The tree already knows EB is multi-instance with no sticky
routing. The shipped scale-out template is Dynamo *metadata* +
in-process rehydrate (ENG-114). Not a fifth `listen()`.**

### No sticky routing (MCP)

`mcpSessionRehydration.ts` L3–8 (ENG-114): a tool-call POST can
land on an instance that did **not** create the session
(“multi-instance deploy, **no sticky routing**”). Live
`StreamableHTTPServerTransport` objects “cannot be serialized”
(`mcpSessionStore.ts` L7–8). What is shared: user id + internal
flag in Dynamo when `MCP_SESSION_STORE=dynamo` (L16–19). Default
store is still in-memory. Rehydrate **in-process**, serve, close
(L16–18: no lingering SSE).

`mcpServer.ts` L187–196: live transports stay a process-local `Map`;
the durable mirror is `sessionStore`.

### Other cross-instance claims (Dynamo, not HTTP)

| Surface | Citation | Pattern |
|---|---|---|
| MCP session | ENG-114 above | metadata + rehydrate |
| Meta OAuth | `metaAuth.ts` L17–18 | `AW-OAuthSessions` “behind the load balancer” |
| Drip enrollments | `dripSequenceWorker.ts` L49–58 | `claimEnrollment(..., INSTANCE_ID)` |

### Process-local, with a pin comment

`socialPosts.ts` L16–21: cooldown `Map` is “process-local by
design… sufficient as long as the backend runs a single instance
(currently pinned at MinSize=MaxSize=1 in production). If
auto-scaling is ever turned on… DynamoDB conditional write.”

`docs/disaster-recovery-investigation.md` L112 says ASG
**MinSize=1, MaxSize=4**. Do not treat either line as live AWS
truth this cycle. The **pattern** is agreed: live objects
process-local; share a Dynamo row when the fleet requires it.

Agent Mode `activeSessionGenerations` (cycle 66) is the
socialPosts-shaped pin, not ENG-114. `sseProgress` Maps (cycle 65)
are the same. Do not copy MCP’s Dynamo session store onto generate
locks (Harsha / `AW-ChatSessions` adjacent). Do not HTTP-split
`generateImage` to “prepare for MaxSize=4” — MCP already shows the
move: **rehydrate in-process**.

Hermes/OMP: one process. AgentWeb’s cutting-edge scale-out is
ENG-114, not Kubernetes-per-tool.

## Queue effect

A-006 stays **discard** (scale-out ≠ fifth listen(); citation
ENG-114). Cycle 66 lock argument is **per-instance**, not
fleet-wide; discard still holds on meter/C2PA/drain/lookupUser.
A-017 stays park. Product READY unchanged.

## Next

Cycle 68: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
