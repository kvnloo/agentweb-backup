# `loops/` — Closed-Loop Framework

A self-contained framework for building **self-improving closed loops** on any product surface. Based on the closed-loop pattern described in Tom Blomfield + Diana Hu's AI-native-company talks (sensor → policy → tools → quality gate → learning).

The framework's `core/` directory has zero imports from elsewhere in agentweb — all external dependencies arrive through the injected ports in `core/ports.ts`. This makes the framework portable.

## The 5 layers

| Layer | Interface | What it does |
|---|---|---|
| **1. Sensor** | `EventSource<TEvent>` | Reads events from wherever they live (DynamoDB array attribute, separate events table, webhook stream) and normalizes them. |
| **2. Policy** | `RuleSet<TEvent, TProposal>` | Evaluates a rule DSL over the event window and produces mutation proposals when conditions are met. |
| **3. Tools** | `MutationTools<TProposal>` | Turns a proposal into a concrete mutation — writing copy to S3, opening a Notion task for a code change, asking Emma a question. |
| **4. Quality gate** | `ApprovalGate` | Eval + human review for risky changes. Typical impl posts a Slack DM and polls reactions. |
| **5. Learning** | `LearningStore` | Records what was proposed, what shipped, and (later) whether it moved the metric. Refeeds into the next sensor read. |

A **loop instance** is a `LoopManifest` (see `MANIFEST_SCHEMA.md`) that names one implementation per layer + the parameters those implementations need.

## Add a loop in 4 steps

> This is the worked example. The detailed "what each step contains" is filled in in Phase 4 once both the onboarding and ai-eval instances are running. The steps themselves will not change.

1. **Write a manifest.** Create `instances/<your-loop-id>/manifest.ts`. Reference an existing instance for the shape. Fill in the target metric, mutation surface, threshold, generator/critic prompts, and approval channel.
2. **Author your rules.** Create `instances/<your-loop-id>/rules.ts`. Each rule is `{ id, when, then, priority, cooldownDays? }`. The `when` is a string in the policy DSL. The `then` describes what to propose.
3. **Register the loop.** In `instances/<your-loop-id>/index.ts`, call `registerLoop(manifest)` and any new sensor/tools/gate implementations specific to this loop. Most loops reuse the existing implementations.
4. **Wire telemetry.** If your surface fires events the framework doesn't already capture, point those firings at `POST /api/loop-events` (anonymous-friendly) or write to `user.onboardingEvents[]`-style attributes on whatever record makes sense.

Smoke-test the loop with the persona harness (`core/smoke-harness/`) before turning it on against real traffic.

## What's NOT in the framework

- Bedrock client implementation. Provided by the host through `BedrockPort`.
- Slack client implementation. Provided by the host through `SlackPort`.
- AWS S3 + DynamoDB clients. Provided by the host through `S3Port` + `DynamoPort`.
- The cron scheduler. The host's existing scheduler iterates `getRegisteredLoopIds()` and calls `runLoop(loopId)` / `runWatchdog(loopId)`.
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
