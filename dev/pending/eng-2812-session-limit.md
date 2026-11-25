## ENG-2812: Per-session turn/spend limit enforced (2026-11-24)

- `backend/src/services/sessionLimit.ts` counts every agent-loop model call on the session item
  (`sessionLimitTurns`, `sessionLimitSpendMicroUsd`, atomic ADD) and pauses the loop before its next
  call once the window is used up. Window caps: 150 turns / $20 at the $80 Starter allowance, scaled by
  the tier's live `llmUsagePolicy.hardCostThresholdMicroUsd` (Pro/Super Premium 375 / $50, Max 1688 / $225,
  Sandbox 938 / $125; Free and unlimited tiers 150 / $20). No config row is written.
- A person replies "continue" (or keep going / yes / proceed ...) to open a fresh window; unattended
  scheduled runs cannot confirm and stop with `terminationReason: 'session_limit'`. The controller's
  media / work-plan auto-continuations and the verified-chat retry loop all stop on `pausedBySessionLimit`.
- 75% / 90% notices are appended once per window to the in-app reply (never on unattended or Slack runs),
  each claimed with a conditional write.
- Not covered: the owner's own Claude plan route (AgentWeb does not pay for those turns), Live Voice.
- Kill switch: `SESSION_LIMIT_ENFORCE=false`. Every DynamoDB error fails open.
