## ENG-2935: ClickUp connected by an org owner but invisible to teammates (2026-11-12)

**Symptom:** XCures owner (agentwebintegration@xcures.com) sees ClickUp as connected; the rest of the org doesn't.

**Root cause:** `getAccessToken` prefers `org.secrets.clickup_access_token` and falls back to the caller's personal token. XCures' org record has no ClickUp secret; the owner's token lives only in his user `secrets`. Nothing promotes a personal token to the org (org create / `joinOrg` don't; only the one-shot `migrate-clickup-to-org.ts` did, and not for this org). The UI also hid Connect (status said connected via the fallback), and Disconnect only cleared the already-empty org secret, so the owner could not repair it.

**Code fix:** `GET /api/oauth/clickup/status` now reports `scope` (`solo|org|personal`) and promotes an org admin/KB-editor's working personal token to the org when the org has none (conditional re-check, never overwrites). Org-admin Disconnect also clears the caller's personal token. KnowledgeBase page shows a "only you can see this" banner with Reconnect, tells members to ask an admin, and surfaces status-check failures.

**Data repair (needs Harsha / data-plane approval, NOT yet run):**
```
cd backend
# 1. preview (no writes)
NODE_ENV=production npx ts-node src/scripts/migrate-clickup-to-org.ts --org-id=3583d005-434b-449f-901d-1b250452d19d --dry-run
# 2. apply to XCures only
NODE_ENV=production npx ts-node src/scripts/migrate-clickup-to-org.ts --org-id=3583d005-434b-449f-901d-1b250452d19d
# 3. (optional) preview every other affected org
NODE_ENV=production npx ts-node src/scripts/migrate-clickup-to-org.ts --dry-run
```
Prefers the org owner's token; never overwrites an existing org token; safe to re-run. Foreplay has the same personal-fallback shape (`migrate-foreplay-to-org.ts`) and was not checked.
