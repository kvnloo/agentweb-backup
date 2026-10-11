# Share-session refusal fixture (ENG-2390)

Behavioral proof for PR #3354: in an interactive share (`/ishare/:shareId`) the tools in
`SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS` (`backend/src/services/agentMode/core/toolDispatch.ts`)
are refused; in the owner's normal session they run.

## Fixture (staging only, no production data)

1. Use the staging test owner account (credentials from the Hermes Automation 1Password vault,
   never committed). Create a fresh Agent Mode session with one throwaway message.
2. `POST /api/agent-mode/conversable-share` with `{ sessionId, expirationDays: 1 }` (owner auth).
   The response holds the share id and conversable token.
3. Drive the same prompts twice:
   - share: `POST /api/agent-mode/ishare/:shareId/generate` with the conversable token;
   - normal: the owner's standard Agent Mode generate endpoint on a second fresh session.
   Prompts (one per blocked tool): "Show my lead notification settings", "Turn lead
   notifications off", "Remember for the org that our brand color is teal", "Forget the org
   brand color memory", "Remember that I prefer short replies", "Forget my short-replies memory".
4. Read both RAW session transcripts (the stored Agent Mode session messages, including
   `role: 'tool'` results and `tool_calls`) and pass them to `evaluateShareRefusals` in
   `backend/src/loops/eval/shareSessionRefusalSim.ts`. Do NOT use the client-facing
   `GET /api/agent-mode/ishare/:shareId` response: it strips `role: 'tool'` messages, so the
   evaluator would misreport refusals as `executed`/`not_called`.
5. Stop the share (`DELETE /api/agent-mode/session/:sessionId/conversable-share`) and delete the
   staging memory entries the normal run created.

## Verdict

- `pass`: refused in share, executed in normal.
- `fail`: share executed a blocked tool, or normal was refused (over-blocking).
- `inconclusive`: the model never called the tool; re-prompt. Never counted as a pass.

`toOkareoChecks` maps verdicts to Okareo check rows (1/0/null) for the baseline run.
