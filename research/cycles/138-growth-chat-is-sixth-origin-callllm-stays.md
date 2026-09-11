# Cycle 138 — `growth-chat/` is a sixth origin; the loop already shares `callLLM` in this process

**UTC:** 2026-09-12T00:02:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 137: customer-portal IA is an in-process list here.
`growth-chat/` is the other gitignored sibling (`.gitignore`
L122). Named in this Actions graph, or another missing
reporter? File-level.

## Finding

**Missing reporter for the UI repo. The agent loop is already
on this box.** `.github/workflows/` and
`merge-evidence.test.sh` grep empty for `growth-chat` /
`growth-genius`. `.gitignore` L121–122 lists `growth-chat/`
with customer-portal as “now independent.” README L367 /
L2214: deploy is
[AgentWebPro/growth-genius-chat](https://github.com/AgentWebPro/growth-genius-chat)
— name mismatch with the gitignore folder.

The loop did not leave with the frontend:

| Site | Citation |
|---|---|
| `app.ts` L369 | `app.use("/api/growth-genius", growthGeniusRoutes)` |
| `growthGeniusService.ts` L1 | `import { agentModeService } from './agentModeService'` |
| L85 / L125 / L207 | `agentModeService.callLLM` |
| usage test L3–5 | “delegates every turn to the shared gateway” |

Q-010’s strangler (`executeAgentStep`) is the extraction
path for that gateway. HTTP-splitting Emma (A-006) would
cut the gateway Growth Genius already shares, while the
gitignored UI stayed another origin. Same shape as cycle
136–137: another repo at the edge, policy in this process.

Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: one process, packages, not a sibling chat
frontend with a 40k import.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Q-010 stays **park**. Do not add A-021.
Q-001 stays **ready**. Q-014 stays **ready**.

## Next

Cycle 139: cheapest remaining. Candidate: Growth Genius
also `import { searchPlatformKnowledgeBase } from
'./chatbotService'` (L2 / L71) and exposes
`search_knowledge_base` as a tool (L133). Two god-objects
in one turn, still in-process. File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
