# Microsoft Teams Contract

Last derived from code: 2026-09-29

Owner area: `ENG-272` (Anurag) — Azure/tenant provisioning is `ENG-1840` (Harsha)

Primary risk: `both Azure Bots are SingleTenant because Azure refused MultiTenant creation as deprecated, and current Microsoft guidance says a single-tenant bot paired with a multi-tenant app registration is the UNRELIABLE combination for reaching a customer's tenant — so cross-tenant delivery to a customer like Manifest Health is unproven.`

## Agent Summary

Teams is reached through **Azure Bot Service / Bot Framework**, not Microsoft Graph. Graph was
ruled out deliberately: `ChannelMessage.Send` is delegated-only (its application permission,
`Teamwork.Migrate.All`, is migration-only), so posts would attribute to a human rather than to
AgentWeb, and reading channel messages needs per-tenant Microsoft approval — fatal for a
self-serve product.

The bot is distributed as a **custom Teams app**: no Teams Store submission, no Microsoft
review. That premise is now in question — see Open Risks.

Authentication is delegated entirely to the `botbuilder` SDK. Do not hand-roll it: the Connector
requires seven separate verifications plus a separate Bot Framework Emulator path, and
Microsoft's own documentation warns that getting it wrong lets an attacker read messages sent to
the bot, impersonate the bot, and steal its keys.

## What AgentWeb Uses This For

| Capability | Supported? | Entry point | Notes |
| --- | --- | --- | --- |
| OAuth/connect | No | — | There is no per-customer OAuth handshake. A Teams admin installs the app; activities then arrive at the endpoint below. The earlier plan for a `teamsAuth.ts` mirroring `outlookAuth.ts` assumed the Graph path and is obsolete. |
| Inbound messages | Yes | `backend/src/routes/teamsMessages.ts` | Authenticated, logged, acknowledged. **No session wiring yet.** |
| Outbound reply | Yes (fixed text only) | same | Exercises tenant-scoped token acquisition and reuse of the inbound `serviceUrl`. |
| Conversation → Emma session | **Not yet** | — | Next slice: a `teamsChannelAdapter` over `services/conversation/channelPort.ts`. |
| Adaptive Cards / approvals | No | — | Optional for v1. |

## Code Pointers

| Area | Path | Purpose |
| --- | --- | --- |
| Route | `backend/src/routes/teamsMessages.ts` | `POST /api/teams/messages` |
| Adapter | `backend/src/services/teams/teamsBotAdapter.ts` | Memoized `CloudAdapter`, SingleTenant |
| Credentials | `backend/src/utils/secretsManager.ts` → `getTeamsBotCredentials()` | Env-or-secret, 5-min TTL cache |
| Mount | `backend/src/app.ts` | After `express.json()`, **not** in the raw-body block |
| Tests | `backend/src/__tests__/teamsMessages.test.ts`, `backend/src/__tests__/secretsManager.teamsBot.test.ts` | |
| Port (next slice) | `backend/src/services/conversation/channelPort.ts` | Contract a Teams adapter must implement |

## Stored Internal Shape

Nothing is persisted yet. No `connected_accounts` row, no `PlatformType` value, no
`MessagingChannel` entry — inbound needs none of them, and `MessagingChannel` is the separate
outbound-notification seam (`services/messagingChannelService.ts`).

The next slice will need its own thread binding, mirroring Slack's two load-bearing shapes
(`session.slackThread` and the `slack_thread_{channel}_{ts}` settings key) with Teams keys. The
port has no method for *reading* a binding, so the resume-an-existing-session lookup is
caller-side work.

## Credentials

Secret `dev|prod/AgentWeb/Microsoft/TeamsBot`, shaped `{ appId, appPassword, tenantId }`.
Overridable by a **complete** set of `TEAMS_BOT_APP_ID`, `TEAMS_BOT_APP_PASSWORD`,
`TEAMS_BOT_TENANT_ID`; a partial set is ignored with a warning rather than merged, so the dev
bot's appId can never pair with the prod bot's secret.

`tenantId` is required, not optional. A SingleTenant bot must request its Connector token from
`login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` rather than the shared
`botframework.com` endpoint; without it every outbound reply fails to authenticate.

**`prod/AgentWeb/Microsoft/TeamsBot` does not exist.** The provisioning identity lacked
`CreateSecret` on `prod/*`; the values are in 1Password (Hermes Automation, "Azure Teams Bot
(prod)"). Production therefore throws until it is created, and deliberately does not fall back to
the dev secret.

## Provisioned Resources (ENG-1840, 2026-09-28)

| Thing | Value |
| --- | --- |
| Resource group | `rg-agentweb-teams` (subscription `AgentWeb`, westus2) |
| Dev bot | `agentweb-teams-dev`, app `0a676380-0ede-4258-ab68-de59c42e8f63` |
| Prod bot | `agentweb-teams-prod`, app `b091fcf2-bc99-4ab6-830a-ca9fdd51e060` |
| Bot type | **SingleTenant**, home tenant `b2c5b49c-2f3c-4c89-ac3e-1a0e423acbc3` |
| App registrations | Sign-in audience `AzureADMultipleOrgs` (verified independently) |
| Tier / channel | F0, Teams channel enabled |
| Endpoint | `https://api.agentweb.pro/api/teams/messages` |
| Test user | `teams-test@harshaagentweb.onmicrosoft.com`, M365 Business Basic |

The dev bot's endpoint currently points at the **prod** URL; it needs repointing to a tunnel URL
for local testing.

## Open Risks

1. **Cross-tenant delivery is unproven, and this is the one that can derail a pilot.**
   Multi-tenant bot creation was deprecated after 2025-07-31. Microsoft guidance from 2026-05 on
   exactly our configuration (multi-tenant Entra app + SingleTenant Azure Bot) reports the ZIP
   install being rejected in the target tenant and proactive messages returning 401, and
   recommends AppSource/Teams Store distribution instead — which contradicts the "no Microsoft
   review" premise this integration was chosen for. An exception to create a multi-tenant bot is
   not self-service and not guaranteed.
   **The licensed test user is in the bot's own tenant, so no test we can run today settles this.**
   Settling it needs a second M365 tenant. Do not commit a pilot date before then.
2. **No prod secret** (above). Acceptable only because no one has installed the prod app.
3. **Tenant custom-app-upload policy** — a customer tenant may disable sideloading org-wide, in
   which case their admin must permit this app specifically. Never asked of Manifest Health.
4. **`botbuilder` adds 7 moderate advisories** (transitively via `@azure/msal-node`); no high or
   critical. Accepted over hand-rolling seven security checks.

## Verification

- Unit tests above.
- **Bot Framework Emulator** against `http://localhost:3001/api/teams/messages` with the dev
  `appId`/`appPassword` — needs no Azure, tenant or licence. The SDK handles the Emulator's
  separate issuer path.
- **Real Teams, same tenant only:** install for `teams-test@…`, message the bot, expect the fixed
  acknowledgement. Proves inbound validation and outbound auth. Proves nothing about
  cross-tenant.
