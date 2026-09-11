# Feature queue

Source of truth: `queue.json`. Protocol score is research leverage.
**Implementation order** (first PRs): Q-001, Q-014, Q-003.
Land **Q-004 with or before Q-014**.

Artifact (findings + priorities at the top): [`README.md`](README.md).
Teach-in: `ARCHITECTURE.md`. Working agreement: `HOW_TO_HELP.md`.
`coding_unlocked: true`. `briefing_ready: true`.

## How Kevin can help (thesis)

Hermes operator + MCP creative discovery first. Then a fail-open
DesignArena → `SUPPORTED_MODELS` mapper (not mcp-bench-router's OpenRouter
chat map). Do not port HyperFrames, MoneyPrinterTurbo, or ComfyUI —
Remotion already owns intro/outro. Local logged-in browser is ENG-381.

## Ranked (by score)

| Rank | ID | Score | Status | Title |
|---|---|---|---|---|
| 1 | Q-003 | 38 | **ready** | DesignArena adapter — `briefs/Q-003-designarena-adapter.md` |
| 2 | Q-001 | 34 | **ready** | Emma-via-Hermes operator path — `briefs/Q-001-hermes-oauth.md` |
| 3 | Q-014 | 34 | **ready** | Expose generate_image on MCP tools/list — `briefs/Q-014-generate-image-mcp.md` |
| 4 | Q-004 | 32 | **ready** | post_on_account internalOnly — `briefs/Q-004-post-on-account-internalOnly.md` |
| 5 | Q-006 | 27 | **ready** | Hide edit_landing_page_file — `briefs/Q-006-hide-edit-landing-page.md` |
| 6 | Q-015 | 27 | **ready** | Hide admin MCP tools — `briefs/Q-015-hide-admin-mcp-tools.md` |

## Parked

| ID | Score | Why parked |
|---|---|---|
| Q-016 | 26 | MCP video after Q-014; $1.55/clip vs $0.04 image (ENG-973) |
| Q-011 | 26 | Hermes as ENG-381 local-agent successor; confirm ownership; not #2271 |
| Q-007 | 24 | Intro/outro already in BrandedVideo; do not port HyperFrames/MPT |
| Q-002 | 23 | Offline Model: parser only; live router is Q-003; no new eval attribute |
| Q-005 | 22 | Tool prompt already requires parallel variant calls |
| Q-008 | 22 | Eval workspace just shipped (ENG-1870) |
| Q-009 | 21 | ComfyUI backend — ops-heavy; Remotion is the existing graph node |
| Q-010 | 19 | callLLM strangler — Harsha gravity; target loop is Hermes-shaped |

## Discarded

| ID | Why |
|---|---|
| Q-012 | Kerdoios duplicates usage runway |
| Q-013 | God-object rewrite cannot merge |

## First coding (when unlocked)

1. **Q-001** — Kevin operator smoke on the existing `HERMES_MCP_OAUTH.md`
   recipe (not another in-repo doc PR).
2. **Q-014** — list `generate_image` on MCP (metering unchanged).
3. **Q-003** — fail-open DesignArena mapper; Matt before flipping the
   production default to `gpt-image-2`.
4. **Q-006 / Q-015 / Q-004** — MCP hygiene. Land **Q-004 with or before
   Q-014** so listing `generate_image` does not leave live social publish
   in the same `tools/list`.

None of these needs a database change.

## Architecture / SDLC (parallel; not product ranks)

Kevin asked to research breaking the repo into nanoservices and
comparing Hermes / Oh My Pi. **Do not HTTP-split Emma.** See
`sdlc/THESIS.md`. Track queue: `sdlc/QUEUE.md`. First SDLC coding
(after unlock, not instead of Q-014): A-002 then A-007 then A-008.
Cycle 46: parent is I/O, worker is compute; chatbot still `executeTool`
on the parent. Cycle 47: three catalogs for `generate_image`; A-014
parks copying page/skill gates onto MCP. Cycle 50: A-015 leak still
cannot spend (`httpClient.ts` `lookupUser`). Cycle 51: copying the
Emma meter is not that door (`anon_*` is allow-listed). Cycle 53: MCP
image execute cannot skip `lookupUser` via ENG-1596. Cycle 54: A-007
copies workflowTools **shape**, not admin identity. A-006 stays discarded.
Q-001 / Q-014 / Q-003 stay ready.
