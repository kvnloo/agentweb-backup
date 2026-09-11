# Research protocol

## Purpose

Turn "what's the best way we can help AgentWeb" into a ranked, evidence-backed
queue that gets sharper every cycle. Implementation is a later phase.

## KEEP / DISCARD

An item is **KEEP** only if all of these are true:

- It sits on a real AgentWeb surface (code path, customer-visible behavior, or operator path).
- It is not already in-flight as an open PR doing the same job.
- It does not require a new Dynamo table/index/GSI unless we explicitly park it behind Harsha.
- We can name the file(s) and the acceptance check.

**DISCARD** when:

- The team already shipped it (example: usage runway exists; don't rebuild Kerdoios inside AgentWeb).
- It is a god-object rewrite (`agentModeService.ts` ~40k lines) as a first PR.
- It is factory-spray: drive-by lint, comment cleanup, or test-blessing.
- It belongs in customer-portal UI and this tree has no customer-portal (separate repo).
- Collision with Harsha/Argusoft open work is high and we have no unique angle.

## Scoring (source of truth: `queue.json`)

Each axis is 0–5.

| Axis | Meaning |
|---|---|
| `leverage` | Unique to Kevin's adjacent work (Hermes, DesignArena/LM-arena, ComfyUI, compute allotment, harness research) |
| `product` | Customer-visible quality, cost, reliability, or operator unblocking |
| `mergeability` | Bounded PR, characterization tests exist, no schema, low review load |
| `evidence` | We can prove it from this tree / docs / tests without production access |
| `collision` | 0 = clear, 5 = someone is already doing it or it fights a live program |

```
score = 3*leverage + 3*product + 2*mergeability + evidence - 2*collision
```

Ranks are the sorted `score`. Ties break toward higher `mergeability`, then higher `leverage`.

## Status

| Status | Meaning |
|---|---|
| `seed` | Named, not yet evidenced |
| `triage` | Evidence gathering |
| `keep` | Survived triage; needs an implementation sketch |
| `ready` | Sketch in `briefs/`, bounded, could code next |
| `park` | Good idea, wrong time (schema, collision, needs Harsha, needs other repo) |
| `discard` | Dead; receipt says why |

## Do not touch (invariants)

- Billing: `meterUserUsage` / `usageRecorderService` / `llmPricing` — one charge per success.
- C2PA strip default-on for generated images.
- Brand logo preservation (`logoImage` + CRITICAL LOGO prompt).
- Human-eval reviewer assignment (Matt = creative/landing, Fangfang = lead enrichment) without product intent.
- Database/data-plane without Harsha.
- `localStorage.getItem("token")` in any frontend.
- End-user pages in `partner-portal/` (customer-portal is the other repo).

## Collision watchlist (refresh each cycle)

Check `gh api repos/AgentWebPro/agentweb/pulls?state=open` before promoting anything.

Known live programs (bootstrap):

- OpenRouter gateway cutover (ENG-1413+)
- Evaluation workspaces (ENG-1870, just merged)
- Hermes MCP OAuth (ENG-1869)
- Usage runway / billing ledger
- Open PR: OpenRouter 429 retry (`toolErrorClassifier.ts`, not callLLM body) — #2862
- Open PR: X post ranking scores (`emma/tools.ts`) — #2832 — do not edit that file for Q-004
- Open PR: WhatsApp Cloud API — #2271
- Open PR: convert_to_pdf foundation tool — #2861
- Open PR: Slack conversation channel port — #2393 (ENG-272). Architecture
  A-013 must not start at `routes/slack.ts`.
- Open PR: autonomous report work plan — #2871
- Open PR: dead AgentMode transports — #2563
- Open PR: renewal-health alert — #2875
- Open PR: landing-page publish Tests gate — #2846 (`landingPageGeneration.ts` only; not first-slice)
- Open PR: dependabot GitHub Actions — #2856 (workflows only)

## Adjacent-work mapping rule

If Kevin already has a repo that solves 80% of a problem AgentWeb already
solved another way, **do not port it**. Either:

- adapter (DesignArena → Emma image routing), or
- operator path (Hermes → Emma MCP), or
- DISCARD (Kerdoios vs usage-runway: AgentWeb already meters and recommends cheaper models).

## Parallel track (from 2026-09-11T18:45Z)

Kevin asked for continuous research on **nanoservices / agentic SDLC**.
That work lives in `research/sdlc/` and must not rewrite product ranks
or un-ready Q-001 / Q-014 / Q-003. A-006 (HTTP-per-tool) is discard —
same family as Q-013.

## Cycle quality bar

A cycle that only restates `QUEUE.md` is a failed cycle. Each cycle must add
at least one of: a file-level citation, a DISCARD, a rank change, a new item,
or a parked item unblocked. Architecture-track cycles write `research/sdlc/`
and `cycles/NNN-*.md`.
