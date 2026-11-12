## ENG-2935: ClickUp connected by an org owner but invisible to teammates (2026-11-12)

**Symptom:** XCures owner (agentwebintegration@xcures.com) sees ClickUp as connected; the rest of the org doesn't.

**Root cause:** `getAccessToken` prefers `org.secrets.clickup_access_token` and falls back to the caller's personal token. XCures' org record has no ClickUp secret; the owner's token lives only in his user `secrets`. Nothing promotes a personal token to the org (org create / `joinOrg` don't; only the one-shot `migrate-clickup-to-org.ts` did, and not for this org). The UI also hid Connect (status said connected via the fallback), and Disconnect only cleared the already-empty org secret, so the owner could not repair it.

**Code fix:** Sharing is explicit, never silent (copying a token org-wide lets every member read and act through Emma as that person). `GET /api/oauth/clickup/status` is read-only and reports `scope` (`solo|org|personal`) and `canShare`; a lookup failure there degrades to no scope instead of "disconnected". New `POST /api/oauth/clickup/share-with-org` lets an org admin/KB editor share their own verified personal token, via a conditional write (`orgDb.setOrgSecretIfAbsent`) so it never overwrites. Org-admin Disconnect also clears the caller's personal token (idempotent, retry-safe, says so if only half completed). Status failures carry `reason` (`invalid_token` vs `unavailable`). KnowledgeBase page: "Only you can see this" banner with a confirm-before-share dialog, member guidance, reason-specific messages and Try again.

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
