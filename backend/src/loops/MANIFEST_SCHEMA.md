# Loop Manifest Schema

A **loop manifest** is the configuration object that tells the framework how to run one closed-loop instance. It names one implementation per layer + the parameters those implementations need.

This document is the authoritative reference for what a manifest contains. For runnable examples see `instances/onboarding/manifest.ts` (Phase 2) and `instances/ai-eval-funnel/manifest.ts` (Phase 3).

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `loopId` | `LoopId` (branded string) | yes | Stable identifier. Used as S3 key prefix (`s3://agentweb-loops/<loopId>/`) and DynamoDB partition key in the runs + learning tables. |
| `displayName` | `string` | yes | Human-readable name shown in Slack DMs. |
| `paused` | `boolean` | yes | When true, the orchestrator returns immediately without doing anything. |
| `pauseReason` | `string` | optional | Surfaced in Slack DMs when paused. |
| `targetMetric` | `TargetMetric` | yes | The north-star ratio this loop optimizes. |
| `allowedEventTypes` | `readonly string[]` | yes | Event types the ingestion route will accept for this loop. Rejection is at the boundary, not in the policy layer. |
| `mutationSurface` | `readonly { key, kind }[]` | yes | Keys the tools layer is allowed to write variants for. Anything outside this list is a business-rules violation. |
| `sensorImpl` | `string` | yes | Key into the sensor registry (e.g. `'userArrayEventSource'`, `'eventTableEventSource'`). |
| `rulesetImpl` | `string` | yes | Key into the ruleset registry. Usually `'<loopId>-rules'`. |
| `toolsImpl` | `string` | yes | Key into the tools registry. |
| `gateImpl` | `string` | yes | Key into the gate registry (e.g. `'slackReactionGate'`). |
| `learningImpl` | `string` | yes | Key into the learning registry. |
| `thresholds` | `LoopThresholds` | yes | Promote/retire/watchdog cutoffs. |
| `generator` | `GeneratorConfig` | yes | Bedrock model + system prompt for the Generator agent. |
| `critic` | `CriticConfig` | yes | Bedrock model + rubric for the Critic agent. |
| `approval` | `ApprovalConfig` | yes | Slack DM template + auto-ship parameters. |
| `businessRules` | `readonly Record<string, unknown>[]` | yes | Free-form business-rule entries; the policy DSL parses these alongside the main rule list. |
| `implParams` | `Record<string, unknown>` | optional | Free-form parameter bag passed to the chosen implementations. They cast and validate. |

## `TargetMetric`

```ts
{
  name: string                    // e.g. 'eval_to_signup_rate'
  numeratorEvent: string          // e.g. 'signed_up'
  denominatorEvent: string        // e.g. 'form_submitted'
  windowDays: number              // typically 7
}
```

## `LoopThresholds`

| Field | Default | Meaning |
|---|---|---|
| `promoteLiftPct` | `15` | A treatment is promoted to control if it lifts the metric by ≥ this % over control. |
| `promoteMinNPerArm` | `80` | Promotion requires this many events per arm. Lower for lower-volume surfaces. |
| `retireLiftPct` | `-10` | A treatment is retired if it lags control by ≥ this %. |
| `retireMinNPerArm` | `50` | Retirement requires this many events per arm. |
| `watchdogRollbackPct24h` | `20` | Watchdog auto-retires a variant if its 24h lift drops by this %. |
| `watchdogPausePct7d` | `10` | Watchdog pauses the whole loop if 7d metric drops by this %. |
| `maxActiveArmsPerKey` | `5` | Hard cap on simultaneously-active variants per mutation key. |
| `maxTokensPerCycleUsd` | `5` | Daily Bedrock budget cap. Cron exits early if exceeded. |

## `GeneratorConfig`

```ts
{
  candidatesPerCycle: number      // typically 30-50
  model: string                   // 'claude-opus-4-7' or 'claude-sonnet-4-6'
  systemPrompt: string            // loop-specific voice + ICP context
}
```

## `CriticConfig`

```ts
{
  model: string                   // typically 'claude-sonnet-4-6'
  rubric: readonly string[]       // criteria the Critic scores against
  minScore: number                // 0-1; variants below this are filtered out
}
```

## `ApprovalConfig`

```ts
{
  slackUserId?: string            // DM target for personal approval
  slackChannel?: string           // alternative to user DM
  dmTitleTemplate: string         // e.g. '🌅 {displayName} — {date}'
  autoShipCutoffHourPT?: number   // typically 18 (6pm PT)
  autoShipConditions?: readonly string[]  // e.g. ['signal_trending_up_or_flat', 'no_business_rule_violations']
}
```

## `businessRules`

Free-form array of business-rule entries. The policy DSL parser interprets each entry based on its `enforcement` field. Standard enforcement types (defined in Phase 1b):

- `keyword_blacklist` — proposals containing any of `keywords[]` are rejected.
- `forbidden_path_prefix` — proposals touching paths under `pathPrefixes[]` are rejected. Used to keep loops away from billing/auth/payment surfaces.
- `account_exclusion_list` — proposals will not be served to accounts in `accounts[]`.
- `protect_control` — control variant cannot be retired unless a winner is statistically established.
- `weekend_freeze` — no new variants ship Friday 5pm PT through Monday 9am PT.
- `max_active_arms_per_step` — covered by `thresholds.maxActiveArmsPerKey`.
- `daily_budget_cap` — covered by `thresholds.maxTokensPerCycleUsd`.
- `min_event_volume` — proposals are held if the affected step has < N events in the last 7d.
- `image_quality_floor` — image-prompt proposals require vision-LLM score ≥ N.
- `max_copy_length` — copy proposals exceeding N chars are rejected.

## S3 location

Each loop's manifest persists at:
```
s3://agentweb-loops/<loopId>/config.json
```

The bucket has versioning enabled; every PutObject is an immutable snapshot. The framework uses `If-Match` on PutObject (matched against the read VersionId) so concurrent writers don't clobber each other.

## DynamoDB tables the framework uses

| Table | PK | SK | Purpose |
|---|---|---|---|
| `Dev-AW-LoopRuns` | `loopId` | `runAt` | Audit log of every loop tick. Written by the orchestrator. |
| `Dev-AW-LoopEvents` | `loopId` | `<ts ISO>#<sessionId>` | Anonymous-funnel events. Written by `POST /api/loop-events`. (Phase 3) |
| `Dev-AW-LoopLearning` | `loopId` | `runAt#mutationId` | What was proposed, what shipped, and (later) the observed lift. |

GSIs:
- `Dev-AW-LoopEvents` has a GSI on `(loopId, eventType, ts)` so the eventTableEventSource can query by type cheaply.
