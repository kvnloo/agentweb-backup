# Cycle 56 — mcp/client ↛ mcp/server already; do not HTTP-split an acyclic DAG

**UTC:** 2026-09-11T20:36:00Z
**Kind:** mapping (+ parked item)
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Oh My Pi’s quality is an **acyclic package DAG** (`pi-ai` ↛ `pi-agent-core`).
Does AgentWeb’s MCP tree already have that arrow, and would a fifth HTTP
process improve it?

## Finding

**The folders are already acyclic. There is no process to extract.**

Prod imports (tests only mention the other side in comments):

| From | To | Result |
|---|---|---|
| `mcp/client/**` | `mcp/server` | **none** |
| `mcp/server/**` | `mcp/client` | **none** |

Shared parent: `mcp/anonymousToolAccess.ts` (ENG-822 predicate used by
`server/registry.ts` L2 and `client/toolRegistry.ts` L2). That is OMP
`pi-telemetry`: a leaf both sides may import, not a cycle.

Hermes is MCP **client only** (`mcp_tool.py`). AgentWeb is client **and**
server in one repo, but the two faces do not import each other. Cycle 29
already skipped self-MCP `"agentweb-tools"` as circular. This cycle: the
folder layout already encodes that skip.

`backend/package.json` still has **no** `workspaces` and **no**
`dependency-cruiser`. The arrow is true in the tree and **unenforced**.
A-002 is the first CI ratchet (`loops/core`). Do not open a second guard
PR while kvnloo#3 is in flight. Do not HTTP-split client vs server — they
already compose like OMP packages inside one process.

`mcp/server` **does** import host `services/` (`httpClient.ts` L63 `db`,
`registry.ts` L1 `evaluationPolicy`). That is the host adapter, not a
reason to add Kubernetes. A-007 `infrastructure.ts` stays mcpFetch through
that client.

## Queue effect

Park **A-016** (score 23): after A-002 merges, sibling
`mcpFolderImportGuard.test.ts` — walk `mcp/client` (forbid `mcp/server`)
and `mcp/server` (forbid `mcp/client`). Allow `../anonymousToolAccess`.
Do **not** forbid `services/` on `mcp/server`. Do not do this instead of
Q-014 / A-007.

Q-001 / Q-014 / Q-003 stay **ready**. A-006 stays discard (you would split
an already-acyclic DAG into a network cycle — cycle 29’s skip).

## Next

Cycle 57: collision or cheapest remaining mapping. Do not un-ready
Q-001 / Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
