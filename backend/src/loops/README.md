# `loops/` — Closed-Loop Framework

A self-contained framework for building **self-improving closed loops** on any product surface. The active path is sensor → policy → tools → learning. Review and execution policy live in Linear and the executor pipeline rather than a second in-process approval gate.

The framework's `core/` directory has zero imports from elsewhere in agentweb — all external dependencies arrive through the injected ports in `core/ports.ts`. This makes the framework portable.

## The 4 layers

| Layer | Interface | What it does |
|---|---|---|
| **1. Sensor** | `EventSource<TEvent>` | Reads events from wherever they live (DynamoDB array attribute, separate events table, webhook stream) and normalizes them. |
| **2. Policy** | `RuleSet<TEvent, TProposal>` | Evaluates a rule DSL over the event window and produces mutation proposals when conditions are met. |
| **3. Tools** | `MutationTools<TProposal>` | Turns a proposal into a concrete mutation — writing copy to S3, opening a Notion task for a code change, asking Emma a question. |
| **4. Learning** | `LearningStore` | Records what was proposed, what shipped, and (later) whether it moved the metric. Refeeds into the next sensor read and advances the linked Linear issue. |

A **loop instance** is a `LoopManifest` (see `MANIFEST_SCHEMA.md`) that names one implementation per layer + the parameters those implementations need.

## Add a loop in 4 steps

> This is the worked example. The detailed "what each step contains" is filled in in Phase 4 once both the onboarding and ai-eval instances are running. The steps themselves will not change.

1. **Write a manifest.** Create `instances/<your-loop-id>/manifest.ts`. Reference an existing instance for the shape. Fill in the target metric, mutation surface, thresholds, generator/critic prompts, and digest destination.
2. **Author your rules.** Create `instances/<your-loop-id>/rules.ts`. Each rule is `{ id, when, then, priority, cooldownDays? }`. The `when` is a string in the policy DSL. The `then` describes what to propose.
3. **Register the loop.** In `instances/<your-loop-id>/index.ts`, call `registerLoop(manifest)` and any new sensor/tools implementations specific to this loop. Most loops reuse the existing implementations.
4. **Wire telemetry.** If your surface fires events the framework doesn't already capture, point those firings at `POST /api/loop-events` (anonymous-friendly) or write to `user.onboardingEvents[]`-style attributes on whatever record makes sense.

Smoke-test the loop with the persona harness (`core/smoke-harness/`) before turning it on against real traffic.

## Design guardrails — keep the loop honest (avoid local maxima)

A loop is gradient descent: it hill-climbs to the best version of whatever basin
it starts in. By itself it converges to a *local* maximum — "the best version of
a mediocre flow" — never a global one, because a global jump requires moving
*through* a worse intermediate, which hill-climbing won't do. Escaping local
maxima needs **exploration** (big jumps), which the loop does not do. Three
guardrails keep every loop instance trending toward the global maximum, not just
polishing a local one:

1. **Don't lock the loop into micro-edits.** A loop whose `mutationSurface` is
   only "rewrite the headline" can *only ever* reach "best copy on this flow" —
   architecturally welded into one basin. Keep the surface able to express
   **structural** changes (different step order, fewer steps, a different
   first-value moment), so basin-jumps are at least possible.

2. **Keep a human (and real users) as the basin-jumper.** The loop does
   *exploitation* (perfect the current basin). *Exploration* — proposing a
   fundamentally different approach — comes from founder insight + user
   conversations + first-principles redesign, NOT from the loop. Don't outsource
   basin-jumping to the loop; it structurally can't do it. (At scale, add
   explicit exploration *into* the loop — several distinct approaches running in
   parallel = random restarts, occasional deliberately-radical variants =
   simulated-annealing temperature, keep-the-best-basin.)

3. **Climb the right hill.** Point `targetMetric` at the true downstream outcome
   you can attribute (activation / retention / revenue), NOT a proxy (clicks,
   "completed onboarding"). Optimizing a proxy climbs to the *proxy's* peak,
   which can be miles from the real goal. Wrong hill → guaranteed wrong summit,
   no matter how well the loop climbs.

You never *prove* you're at the global max — you keep an escape hatch alive. At
seed stage the escape hatch is the founder; don't burn cycles making the loop
search globally, just honor these three so future-you isn't trapped.

## What's NOT in the framework

- Bedrock client implementation. Provided by the host through `BedrockPort`.
- Slack client implementation. Provided by the host through `SlackPort`.
- AWS S3 + DynamoDB clients. Provided by the host through `S3Port` + `DynamoPort`.
- The cron scheduler. The host's existing scheduler runs loop ticks and the generic attribution pass.
- Loop-specific business knowledge (ICP definitions, brand voice, competitor names). Lives in the manifest's prompts and business rules.

## Architecture diagram

See `MANIFEST_SCHEMA.md` for the full data model + the AWS resources the framework expects.

## Status (2026-05-25)

- ✅ Phase 0 — spec + coordination
- 🚧 Phase 1 — framework skeleton (types, ports, registry, docs)
- ⏳ Phase 2 — port existing onboarding loop into the framework
- ⏳ Phase 3 — anon-event infra + first non-onboarding loop instance (`/ai-eval`)
- ⏳ Phase 4 — smoke harness scenarios + this README's "4 steps" worked example
- ⏳ Phase 5 — mega PR to `main`

Tracking task: [Templatize Loop Apparatus + Instance for /ai-eval](https://www.notion.so/36b09247c95181dfafa6e80e949ae314)
