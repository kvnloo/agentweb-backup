# Cycle 57 — composition root is app.ts; #2271 owns the route table

**UTC:** 2026-09-11T20:38:00Z
**Kind:** collision + mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Method

`gh api repos/AgentWebPro/agentweb/pulls?state=open` — still **20** PRs.
File filter expanded with `app.ts` (cycle 52 missed this). This fork: #1
research, #2 Q-014, #3 A-002.

## Collision

AgentWebPro still **empty** on A-007 / Q-014 / A-002 targets:

`apiTools.ts`, `httpClient.ts`, `anonymousTransport.ts`, `mcpServerCore.ts`,
`imageGeneration.ts`, `loops/core`, `loops/index.ts`.

Still do not compete: `emma/tools.ts` **#2832 #1076 #689**;
`sdkConstructionGuard.test.ts` **#2563**.

**New citation:** **#2271** (WhatsApp Cloud API, ENG-273) edits
`backend/src/app.ts` **+7 / −0** — two imports and:

```
app.use("/api/webhooks/whatsapp", express.raw(...));
app.use("/api/webhooks/whatsapp", whatsappWebhookRoutes);
app.use("/api/messaging-channels", messagingChannelsRoutes);
```

Also: `services/slackChannelAdapter.ts`, `services/db.ts` (Harsha
data-plane). A-013 must not start at Slack **or** WhatsApp adapters.
Never pick up #2271.

## Mapping — where nanoservices already compose

`app.ts` is the **composition root** (Hermes gateway / OMP coding-agent
CLI):

| Wire | Citation |
|---|---|
| MCP HTTP server | L133 / L204 `setupMcpServer(app)` |
| MCP OAuth | L134 / L343 `setupMcpOAuth(app)` |
| Loops (explicit, not discover) | L118–120 imports; L475–491 `registerAiEvalFunnelForProduction`, `registerAiReadinessFunnel`, `registerAgentModeLoop` |

Cutting-edge 2026: grow that import list; do not add a mesh. A-007
attaches at `mcpServerCore.ts` L26 `import './apiTools'` — **not**
`app.ts` — so #2271 does not block the infrastructure extract. Do not
open an `app.ts` PR to “register a nanoservice.”

## Queue effect

None for product READY. A-007 still waits on kvnloo#2, still not
`app.ts`. A-013 first_slice: also not `whatsapp*` / `messagingChannels`.
A-016 still park on #3. A-006 stays discard.

## Next

Cycle 58: cheapest remaining mapping. Do not un-ready Q-001 / Q-014 /
Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
