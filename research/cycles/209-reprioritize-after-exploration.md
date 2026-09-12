# Cycle 209 — Reprioritize after exploration

**Date:** 2026-09-12T03:40:00Z
**Question:** Kevin asked to re-think the whole
queue after cycles 1–208. What is the
implementation order *now*, and which
beliefs actually changed?

**Answer:** Score is still not shipping order.
Land what is already in flight, then the
one proof only Kevin can run, then the
drain gate that billed MCP images need.
Do **not** un-ready Q-001 / Q-014 / Q-003.
Do **not** revive A-006. Do **not** add
A-021. `product_queue_frozen` lifts because
Kevin asked.

## What did not change

| Item | Why it stays |
|---|---|
| Q-014 **ready**, score 34 | `apiTools.ts` L2077 is still `internal: true`. Listing is the Hermes discovery door. In flight: kvnloo#2. |
| Q-004 **ready**, score 32 | Same PR as Q-014. Hide `post_on_account` before listing a cost tool. Do not edit `emma/tools.ts` (#2832). |
| Q-001 **ready**, score 34 | Unique Kevin operator smoke on existing `HERMES_MCP_OAUTH.md`. No AgentWeb schema. |
| Q-003 **ready**, score 38 | Fail-open mapper, not a default flip. Cycle 170: flipping to `gpt-image-2` would land unspecified+logo+edit on Azure `[0]`. Cycle 180: onboarding already pins Gemini 3 so the mapper never sees Brick 8 ads. |
| A-006 **discard**, score 6 | 208 cycles of hop/drain/meter/C2PA/logo evidence. Thesis is the artifact (A-001). |
| A-011 **park** | Do not unify Emma camelCase vs MCP snake / `confirm` inside Q-014. Listing is thinner than Emma; that is accepted. |
| A-020 **park** | Ops `eb-deploy.sh` second `put-lifecycle-hook`. Not a coding-agent first slice. |
| Q-006 / Q-015 **ready**, not in the first four | Same `apiTools.ts` family as #2. Hygiene after #2 merges. |

## Beliefs that changed

### 1. Stop proving A-006

Nanoservices are settled **no**. Further
path-C/Referer/filename cycles were
diminishing. The artifact is
`sdlc/THESIS.md` (A-001), not another
matcher. Occupied files (`app.ts` #2271,
`emma/tools.ts` #2832, `agentModeService.ts`
pile) are why persist waits, not why we
would HTTP-split.

### 2. Q-014 listing is necessary and thinner than hoped

MCP schema is one line (`apiTools.ts`
L2080), required `prompt`+`filename`+
`category` (L2093), no `confirm`, no
unique-filename hint, no
`read_brand_guidelines`. Cycle 207:
`filename` is the **output** name, not the
brand `asset.filename`. Listing still
unblocks Hermes `tools/list`. Do **not**
expand Q-014 (A-011).

```2075:2094:backend/src/mcp/server/apiTools.ts
mcpToolRegistry.register({
  name: 'generate_image',
  internal: true,
  definition: {
    name: 'generate_image',
    description: 'Generate images using AI image generation models.',
    // required: ['prompt', 'filename', 'category']
```

### 3. Implementation order is in-flight → Kevin smoke → mapper

`queue.json` still said `Q-001, Q-014,
Q-003`. README already shipped Q-014
first because #2 is open. Make the JSON
match reality: **Q-014, Q-004, Q-001,
Q-003**. After #2, `tools/list` includes
`generate_image`, so Q-001 smoke is the
unique human proof. Q-003 mapper stays
ready and still highest by formula.

### 4. Q-005 park *why* is now filename identity

Old why: “prompt already requires parallel.”
Cycle 208: `extractGeneratedImageFilenames`
L5889 de-dupes on filename; test L268–274
pins `a.png` twice → one. N billed S3
objects named `logo.png` surface as **one**
already-made asset. Revisit is unique
output names (A-008 persist handle), not
an `n=` parameter. Occupied
`emma/tools.ts` #2832.

### 5. Q-016 park is stronger

Video Path C/D, keyframes Veo-only,
character Path D (cycles 195–197). Seedance
default is $1.55/8s vs image $0.04 (40×).
ENG-973 hid `generate_image` for cost;
listing video first repeats that. Product
axis 3→2 (score 26→25). Still park until
Q-014 ships **and** there is product intent
for Hermes ads-video.

### 6. A-008 value is persist unification, not the `git mv`

Cycles 162–208: three S3 writer families,
disagreeing matchers, Path A/B/C/D fetch,
pin with no UA/Referer/`ssrfGuard`,
filename vs URL identity. `git mv` is the
mergeable first slice. One `publicUrl` +
fetch-own-bucket + one UA + Referer policy
+ `ssrfGuard` + one LLM-facing URL handle
waits on the `agentModeService` / `app.ts` /
`emma/tools` pile. Product 2→3 (score
26→29). Implementation still **after**
A-007 packaging.

### 7. A-019 unparks: billed images need the drain gate

`CallTool` is still untracked
(`mcpServerCore.ts` L88–120; **zero**
`cronJobRegistry` imports in that file).
`track()` has no draining bit
(`cronJobRegistry.ts` L38–48).
`instanceState.ts` only has `cronEnabled`
(L14–21). Chat already wraps
(`server.ts` L301). After Q-014, a Hermes
`generate_image` during Immutable overlap
is a billed hop on a dying listen().
AgentWebPro scan 2026-09-12: empty on
`mcpServerCore.ts` / `cronJobRegistry.ts` /
`instanceState.ts` / `server.ts`. Slack
#2393 still occupies `slack.ts` — first
slice does **not** edit it. Status
**park → ready**. Score 27 unchanged.
Implementation after A-002 (in flight #3)
and after #2 merges.

```88:90:backend/src/mcp/server/mcpServerCore.ts
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
```

```38:48:backend/src/utils/cronJobRegistry.ts
  track<T>(jobName: string, promise: Promise<T>): Promise<T> {
    const runId = `${jobName}_${++this.counter}_${Date.now()}`;
    this.inFlight.set(runId, jobName);
    // no draining flag — inserts during runDrain
```

## New orders

**Product `implementation_order`:**
`Q-014` → `Q-004` → `Q-001` → `Q-003`

**Architecture `implementation_order_when_unlocked`:**
`A-002` → `A-019` → `A-007` → `A-008`

A-005 stays park (LOC ratchet vs seven
`agentModeService.ts` PRs). Removed from
the unlocked list.

## If we only do one thing

| Constraint | Do this |
|---|---|
| One product thing | **Q-014** — land kvnloo#2 |
| One Kevin-unique thing after #2 | **Q-001** smoke so `tools/list` includes `generate_image` |
| One architecture thing after #2 and #3 | **A-019** CallTool wrap + refuse `track()`/`tryClaim` while draining |

Not A-007 packaging. Not persist (occupied).
Not a default-model flip.

## Collision (unchanged)

`emma/tools.ts` #2832 #1076 #689. `app.ts`
#2271 #1814. `crm.ts` #1544 #1790.
`agentModeService.ts` #2871 #2861 #2832
#2563 #2060 #1584 #1076. Slack #2393.
Never **#2862 #2271 #2861**.

## Relation to A-002 / A-007 / A-008

A-002 stays first architecture (in flight
#3, empty on `loops/core`). A-019 is the
billed-image drain gate, not a packaging
PR. A-007 still waits on #2 (`apiTools.ts`).
A-008 git-mv after that; persist after the
pile shrinks. Not A-006.

## Next cycle candidate

Follow the new order. Do not start another
S3/Referer matcher. If #2 is still open,
the cheapest unique work is documenting
the A-019 wrap characterization (test
shape only, no product edit on this
branch). If `stop_after` passes,
unsubscribe `agentweb-research-cycle`.
)
