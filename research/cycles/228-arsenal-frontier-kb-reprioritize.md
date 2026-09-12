# Cycle 228 — Arsenal + Linear + frontier-kb re-rank

**Date:** 2026-09-12T05:58:00Z
**Question:** After scanning every owned repo, forks, stars, and
Linear issues that dump Kevin's past ideas, and re-reading
`kvnloo/frontier-kb`, does the AgentWeb product or architecture
order change? Ten agents fanned out.

**Answer:** **No rank inversion.** Implementation order stays
Q-014 → Q-004 → Q-001 → Q-003 and A-002 → A-019 → A-007 → A-008.
Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded. New parked hygiene: **Q-017** (MCP
`initialize` `instructions` + `additionalProperties: false` on
advertised roots) — after #2 and Q-001 smoke, not instead of
listing. Do not mint AgentWeb items for Homebase, OpenAvatar,
Pipeline Studio, Spatial Canvas, Ad Arena, Pythia, Paperclip,
SoL-Pi, AODL, Dash, Kerdoios, MCP Tasks, or crush RFC 9207.

## Evidence

### Linear (the past-ideas dump)

[PER-1522](https://linear.app/0ism/issue/PER-1522) (2026-09-12,
Todo, Company OS) plus Linear document
[Host-0 product lineage map](https://linear.app/0ism/document/host-0-product-lineage-map-a88b2a7a1758)
(same hour):

> **Narrow twins ship. Operating systems of everything do not.**

Four buckets only: twin, control-plane, identity/brain,
creative-loop. Homebase is the live narrow twin. zerOS /
`solarpunk` is a donor graveyard (~10 products in one git).
Captain: map, extract, iterate — do not resurrect the monolith.

AgentWeb is already a **narrow twin**: billed Emma marketing
operator + MCP server for Hermes. Turning it into zerOS,
Dash, Pipeline Studio, or an HTTP nanoservice mesh is the
failure mode PER-1522 named.

[PER-299](https://linear.app/0ism/issue/PER-299): Linear is the
human-viewable KB. Hermes Kanban is execution scratch. [PER-80](https://linear.app/0ism/issue/PER-80):
no zer0-company 26k dump. Development surface doc: talk in
OMP; Hermes is the inspectable runtime; Linear is the mind.
AgentWeb is not a fourth control plane.

Hermes lineage cards PER-150 / 161 / 164 / 174 / 199 / 200 /
207 are **meta syntheses** (private artifacts on host 0). They
do not contain a public idea list to port. PER-198 (zerOS /
Spatial / donor repos) is the same class.

MCP factory leaves (not AgentWeb first slices):

| ID | Idea | AgentWeb |
|---|---|---|
| PER-1257 | OMP MCP 2026-07-28 dual-stack + Tasks | DISCARD as AgentWeb item. OMP client. |
| PER-1355 | Hermes MCP Tasks + notifications | Same. Inbound CallTool already held via `mcpFetch` (`apiTools.ts` L2096–2108). |
| PER-620 | crush RFC 9207 unadvertised `iss` | crush/go-sdk. Do not rewrite `HERMES_MCP_OAUTH.md`. |
| PER-1074 | Codex needs `additionalProperties: false` | Q-017 park. `generate_image` schema L2081–2094 omits it. |
| PER-868 | MCP `initialize` `instructions` | Q-017 park. `createMcpServer` (`mcpServerCore.ts` L58–65) has none. |
| PER-1089 | `tools/list` staleness fanout | DISCARD. ListTools is ungated `getToolDefinitions()` (cycle 211). |

Creative / identity Linear (all DISCARD as AgentWeb items):
PER-1506 Flux ComfyUI stills (Humanity's Vault); PER-1488/1489
Homebase; PER-1458/1425 OpenAvatar; MEMORY titles Ad Arena /
Pipeline Studio / Spatial Canvas / Pythia / Paperclip retired.

### frontier-kb

| Note | AgentWeb |
|---|---|
| `perm-20260910-no-universal-harness-plugin` | Leapfrog is steal typed slots, not import OpenHands/OMP into Emma. |
| `perm-20260911-anti-slop-is-smallest-complete` | Q-014 listing, not schema unify (A-011) and not Q-017 in the listing PR. |
| `perm-20260911-hermes-pi-plugin-adapter-is-host-port-not-abi` | SoL-Pi is a **host port**. AgentWeb MCP is already the **external** composition bus. A-007/A-008 are the internal analog. |
| `perm-20260910-scaffold-tool-shape-dominates` | Editor ABI is a harness eval variable, not an Emma nanoservice. |
| `perm-20260817-orchestration-typed-dynamic-graph` | AODL IR is for Kevin's harnesses, not AgentWeb deploy units. |
| `literature/mcp-dual-stack.md` | Tasks bar is for OMP/Hermes factory, not AgentWeb's tool server. |

### Arsenal (28 owned / 172 forks / 504 stars)

Owned: `frontier-kb`, `verified-oss-loop`, `aodl`, `sol-pi-omp`,
`sol-pi-hermes`, `kerdoios`, `dash`, `openavatar`,
`homebase-pickleball`, `humanity-vault`, `hermes-keel`. Steal the
**protocol** (KEEP/DISCARD receipts). Do not port the products.

High-signal forks already mapped in `research/CONTEXT.md`:
Hermes, oh-my-pi, ComfyUI, HyperFrames, MPT, open-design,
headroom, mcp-bench-router, OpenHands, Archon, crush, GitNexus.
Ten agents: no new AgentWeb first slice among 134 agentic stars.

### Ten-agent consensus

All ten: **KEEP** Q-014 / Q-004 / Q-001 / Q-003; **DISCARD** A-006
and Q-012 / Q-013; **DISCARD** SoL-Pi / OpenHands / Archon / Dash /
AODL-as-scheduler / MCP Tasks / crush OAuth / GitNexus list
fanout / HyperFrames / MPT as AgentWeb items. Missed surface
ideas collapsed to two file-level gaps (Q-017), not a rank
change. One agent (Linear MCP) said **do not mint a Q-017 id**
— park notes only. We park Q-017 as an id so the next coding
pass can find it, and keep it **out** of
`implementation_order`.

## First-slice correction

Product `implementation_order` unchanged:
`["Q-014","Q-004","Q-001","Q-003"]`.

- Do **not** add `additionalProperties` or `instructions` in
  kvnloo#2 (A-011 still parks schema unify; listing is the
  smallest complete).
- Q-001 smoke: observe whether the host rejects schemas that
  omit `additionalProperties`; do not rewrite
  `HERMES_MCP_OAUTH.md` for RFC 9207 (PER-620).
- After #2 + smoke: Q-017 (park) then Q-006 / Q-015.
- A-019 first_slice unchanged except cycle 227 Do-nots already
  landed. Cycle 227's 5xx enhanced-health question remains the
  next **file-level A-019** cycle, not a product re-rank.
- Do **not** revive A-006. Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-002 / A-007 / A-008 stay the architecture order after #2+#3.
frontier-kb host-port + Dash "modules in one process" **reconfirm**
A-007 packaging, not HTTP split.

## Next cycle

If `stop_after` has passed: unsubscribe `agentweb-research-cycle`;
leave `briefing_ready`. Else file-level only: can A-019 HTTP 503
on `tools/call` trip enhanced-health **5xx** rules
(`04-disk-alarm.config` names 4xx only) during
`Terminating:Wait`? Do not 503 `/health`. Do not add A-021. Do
not un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.
