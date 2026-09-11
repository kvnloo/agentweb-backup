# Cycle 043 — Loop composition root is three controller exports; #2393 owns Slack

UTC: 2026-09-11T19:54Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). **#2393** ENG-272 already adds
   `services/conversation/channelPort.ts`, `sessionResponder.ts`,
   `slackChannelAdapter.ts` and edits `routes/slack.ts`. Do not compete.

2. **The agent loop’s inbound composition root is not MCP and not a
   fifth process.** `agentModeController.ts` (14,929 lines) already
   exports the three application-service functions:

   | Export | Line | Role |
   |---|---|---|
   | `runVerifiedChat` | L5019 | Headless / scheduled / eval / Slack revision |
   | `runScheduledChat` | L5362 | Cron envelope around verified chat |
   | `generateSessionResponse` | L7908 | Interactive turn (web, email, Slack thread, GTM) |

   Comment at L5015 already lists five `runVerifiedChat` call sites.
   Additional `generateSessionResponse` adapters: `emmaEmailService.ts`
   L291, `routes/slack.ts` L204 / L887, `routes/gtmPlan.ts` L1494,
   `routes/admin.ts` L4748. `executeAgentStep` still throws (A-003) —
   this controller *is* the live loop.

3. **#2393 is the Hermes/OMP move already in flight.** Channel port +
   Slack adapter, same Node process. That is hexagonal composition, not
   HTTP-splitting `generateImage`. A-013 must **not** start at
   `routes/slack.ts`. After #2393, email/eval can implement the same port.
   Kevin’s unique slice stays Q-001 / Q-014, not a second Slack adapter.

4. **Q-014 still lists MCP `generate_image`, not this root.** Slack
   revisions use `runVerifiedChat` + `revisionService` `confirm=true`
   (cycle 42). Hermes listing does not need that path.

## DISCARD / rank

A-013 collision 3→4 (score 18→16) because #2393 owns Slack. Product
READY unchanged. A-006 stays discard.

## Mapping evidence

`COMPOSITION.md` three-export table. `queue.json` A-013. #2393 file
list.

## Next

Cycle 44: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
