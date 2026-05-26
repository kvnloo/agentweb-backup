# Self-Service SEO / GA / Clarity Analytics Config — Playwright Test Cases

> Manual + Playwright-MCP test plan for the org-wide analytics configuration feature.
> Run against the **cloud test environment** after deploying both PRs
> (agentweb #1603, customer-portal #812) and running the migration script.
>
> Spec: `docs/superpowers/specs/2026-05-22-seo-analytics-config-design.md`
> Plan: `docs/superpowers/plans/2026-05-22-seo-analytics-config.md`

---

## 1. Scope

Covers the self-service **Analytics & SEO** Settings tab, the **Organization Sharing**
analytics row, the org-aware resolution matrix, the GA4 test-connection endpoint,
delegation, and regression coverage for the four bugs (A–D).

| Surface | Where |
|---|---|
| Analytics & SEO tab | Customer Portal → Settings → Analytics & SEO |
| Org Sharing analytics row | Customer Portal → Settings → Organization Sharing |
| `/seo` dashboard + User Journey Funnel | Customer Portal → `/seo` |
| Configure SEO/AEO dialog | Partner Portal → Admin → Users |

---

## 2. Test environment & accounts

### 2.1 Environment

1. Launch / refresh the cloud test environment: `./test-env/test-env.sh launch` then `./test-env/test-env.sh sync`.
2. Record the URLs (set these placeholders before running):
   - `CUSTOMER_URL` = customer portal base URL
   - `PARTNER_URL` = partner portal base URL
3. The backend must be on the branch build **and** the migration script
   (`src/scripts/migrate-analytics-config.ts`) must have been run once
   (`--dry-run` first, then apply). TC-13.x verifies the un-migrated fallback too.

### 2.2 Accounts required

| Alias | Role | Notes |
|---|---|---|
| `ADMIN` | Platform admin | `test@example.com` / `Test123!` — also an **org owner** in test data |
| `OWNER` | Org owner | The org owner whose org is used for sharing tests (may be `test@example.com`) |
| `EDITOR` | Org member listed in `analytics.editors` | Must be added via TC-6.x before editor tests |
| `MEMBER` | Plain org member (not owner, not editor) | Same org as `OWNER` |
| `SOLO` | User with **no** `orgId` | `test1@example.com` / `Test123!` (Basic) or any non-org user |

> If `EDITOR` / `MEMBER` accounts do not exist, create two members in `OWNER`'s
> org first (Partner Portal → Admin, or org invite flow). Note their emails here.

### 2.3 GA4 test data

- `GA_GRANTED` — a GA4 numeric property ID the shared analytics service account
  **has** Viewer access to (for the "connection OK" path). If none exists, grant
  the service-account email shown in the GA4 card to a throwaway GA4 property.
- `GA_DENIED` — a GA4 numeric property ID the service account does **not** have
  access to (e.g. `429408795` from the original bug report).
- `GA_BADFORMAT` — a non-numeric string, e.g. `G-ABC123`.

---

## 3. Playwright execution notes

- Drive with the `mcp__playwright__browser_*` tools.
- Prefer `browser_snapshot` (accessibility tree) over screenshots for assertions;
  use `browser_take_screenshot` for evidence on failures.
- Locate controls by visible text / role (cards have headings "Google Analytics 4",
  "SEO Domains", "Microsoft Clarity"; buttons "Save Google Analytics", "Add property",
  "Test", "Set primary"/"Primary").
- For each portal switch, use a fresh context or `browser_navigate` + re-login to
  avoid session bleed between roles.
- After every save, assert the success toast AND re-load the page to confirm the
  value persisted server-side (not just local state).
- Token handling: log in through the UI — do not inject tokens.

---

## 4. Test suites

Priority: **P1** = critical / blocks release, **P2** = important, **P3** = edge.

---

### TS-1 — Analytics & SEO tab: visibility & access control

**TC-1.1 — Owner sees the tab** · P1
- Pre: logged in as `OWNER`.
- Steps: Navigate `CUSTOMER_URL/settings` → look at the Settings tab strip.
- Expected: an **"Analytics & SEO"** tab is present.

**TC-1.2 — Analytics editor sees the tab** · P1
- Pre: `EDITOR` is in `analytics.editors` (TC-6.3 done); logged in as `EDITOR`.
- Steps: open `CUSTOMER_URL/settings`.
- Expected: the "Analytics & SEO" tab is present.

**TC-1.3 — Plain member does NOT see the tab** · P1
- Pre: logged in as `MEMBER` (not owner, not editor).
- Steps: open `CUSTOMER_URL/settings`.
- Expected: **no** "Analytics & SEO" tab in the strip.

**TC-1.4 — Solo user sees the tab** · P2
- Pre: logged in as `SOLO`.
- Steps: open `CUSTOMER_URL/settings`.
- Expected: the tab is present (solo users always edit their own config).

**TC-1.5 — Direct-URL navigation guard for members** · P1
- Pre: logged in as `MEMBER`.
- Steps: navigate directly to `CUSTOMER_URL/settings/analytics-seo`.
- Expected: redirected to `CUSTOMER_URL/settings/profile`; no blank tab, no console error.

**TC-1.6 — Tab loads the three cards** · P1
- Pre: logged in as `OWNER`; open the Analytics & SEO tab.
- Steps: wait for load (skeletons disappear).
- Expected: three cards render — "Google Analytics 4", "SEO Domains", "Microsoft Clarity".
  The GA4 card shows the service-account email to grant Viewer access to.

---

### TS-2 — GA4 Properties card

**TC-2.1 — Add a GA4 property and save** · P1
- Pre: `OWNER`, Analytics & SEO tab.
- Steps: click "Add property" → enter Label `Main Site`, Property ID `GA_GRANTED`
  → click "Save Google Analytics".
- Expected: success toast "Google Analytics settings saved". Reload the page →
  the property persists with the entered label and ID.

**TC-2.2 — Set primary property** · P1
- Pre: at least two GA4 properties saved.
- Steps: on the second row click "Set primary".
- Expected: that row's button shows "Primary"; the others show "Set primary".
  Save → reload → the same row is still "Primary".

**TC-2.3 — Remove a GA4 property** · P2
- Steps: click the trash icon on a property row → Save.
- Expected: the row disappears; after reload it stays removed.

**TC-2.4 — Reject non-numeric Property ID** · P1
- Steps: add a property with Property ID `GA_BADFORMAT` → Save.
- Expected: save fails with a "Save failed" toast describing an invalid GA4 Property ID;
  nothing persists (reload shows the prior state).

**TC-2.5 — Reject duplicate Property ID** · P2
- Steps: add two rows with the same Property ID → Save.
- Expected: save fails with a duplicate-ID error toast.

**TC-2.6 — Filtered domains & product domain persist** · P2
- Steps: enter `internal.acme.com` in "Filtered domains", `app.acme.com` in
  "Product domain" → Save → reload.
- Expected: both values persist.

**TC-2.7 — Reject invalid product domain** · P3
- Steps: set Product domain to `bad domain` (with a space) → Save.
- Expected: save fails with an invalid-product-domain error.

**TC-2.8 — Primary auto-clears when its property is removed** · P3
- Pre: a property is marked Primary.
- Steps: delete that property row → Save → reload.
- Expected: no save error; the deleted property is not primary (primary is unset or
  the first remaining property — must not reference a non-existent property).

---

### TS-3 — SEO Domains card

**TC-3.1 — Add and save SEO domains** · P1
- Steps: "Add domain" → `acme.com`; "Add domain" → `https://blog.acme.com/` → "Save SEO Domains".
- Expected: success toast; reload → both persist.

**TC-3.2 — Remove an SEO domain** · P2
- Steps: trash a domain row → Save → reload.
- Expected: the domain is gone.

**TC-3.3 — Reject malformed domain** · P1
- Steps: add `not a domain` → Save.
- Expected: save fails with an invalid-domain-format error toast.

---

### TS-4 — Clarity Projects card

**TC-4.1 — Add and save a Clarity project** · P1
- Steps: "Add project" → Label `Main Site`, Project ID `ul13e4f7fe` → "Save Microsoft Clarity".
- Expected: success toast; reload → persists.

**TC-4.2 — Dashboard link appears** · P2
- Pre: a Clarity project with a non-empty Project ID.
- Steps: inspect the row.
- Expected: a "Dashboard" link to `https://clarity.microsoft.com/projects/view/<id>/dashboard`
  (opens in a new tab).

**TC-4.3 — Reject invalid Clarity Project ID** · P2
- Steps: add a project with Project ID `no` (too short) → Save.
- Expected: save fails with an invalid-Clarity-ID error.

**TC-4.4 — Remove a Clarity project** · P3
- Steps: trash a project row → Save → reload.
- Expected: removed.

---

### TS-5 — GA4 "Test connection" button

**TC-5.1 — Test a granted property → success** · P1
- Pre: a GA4 row with Property ID `GA_GRANTED`.
- Steps: click "Test" on that row.
- Expected: a spinner, then a green check (connection OK).

**TC-5.2 — Test a denied property → permission denied** · P1
- Pre: a GA4 row with Property ID `GA_DENIED`.
- Steps: click "Test".
- Expected: a red X and an inline message about permission denied — instructing to
  grant the service account Viewer access.

**TC-5.3 — Test a non-numeric ID → invalid** · P2
- Pre: a GA4 row with Property ID `GA_BADFORMAT`.
- Steps: click "Test".
- Expected: an error indication (the request is rejected as invalid; no spinner hang).

**TC-5.4 — Rate limit on rapid repeats** · P2
- Steps: click "Test" on the same row twice within ~2 seconds.
- Expected: the second attempt is rate-limited (no second live probe; the UI does
  not crash). Wait >2s → "Test" works again.

**TC-5.5 — Member cannot reach the test endpoint** · P2
- Pre: `MEMBER` (who cannot see the tab). Using browser devtools/Playwright,
  `POST CUSTOMER_URL/api/seo/config/ga/test` with `{ propertyId: "123" }` and the member's token.
- Expected: HTTP 403.

---

### TS-6 — Organization Sharing: analytics toggle & editors

**TC-6.1 — Analytics row present for owner** · P1
- Pre: `OWNER` → Settings → Organization Sharing tab.
- Expected: an **"Analytics"** row with an enable toggle and an editors picker,
  rendered like the other feature rows (e.g. "Funnels").

**TC-6.2 — Enable analytics sharing** · P1
- Steps: toggle "Analytics" ON → save (per the tab's save model) → reload.
- Expected: the toggle stays ON.

**TC-6.3 — Add an analytics editor** · P1
- Steps: in the Analytics row's editors picker, add `EDITOR` from the org member list → save → reload.
- Expected: `EDITOR` persists as an analytics editor. (This is the precondition for TC-1.2.)

**TC-6.4 — Remove an analytics editor** · P2
- Steps: remove `EDITOR` from the picker → save → reload.
- Expected: `EDITOR` is gone. (Re-add afterwards to restore TC-1.2 precondition.)

**TC-6.5 — Disable analytics sharing** · P1
- Steps: toggle "Analytics" OFF → save → reload.
- Expected: the toggle stays OFF. (Used by TS-7 sharing-OFF cases.)

**TC-6.6 — Non-owner cannot change org share settings** · P2
- Pre: `MEMBER`. The Organization Sharing tab is owner-only — confirm `MEMBER`
  cannot reach it, or that the analytics toggle is not editable for them.
- Expected: no write path for a non-owner (403 if attempted via API).

---

### TS-7 — Org-aware resolution matrix (core)

> The heart of the feature. For each row, set the sharing state via TS-6, then
> verify what the user sees. "Sees org config" = the GA4/SEO/Clarity values
> configured on the **owner's** org record appear; "empty" = none appear.

| TC | Logged in as | Sharing | Expected in Analytics & SEO tab | Expected on `/seo` |
|---|---|---|---|---|
| TC-7.1 | `OWNER` | ON | Editable org config | Dashboard with org data |
| TC-7.2 | `OWNER` | OFF | Editable org config (owner always) | Dashboard with org data |
| TC-7.3 | `EDITOR` | ON | Editable org config | Dashboard with org data |
| TC-7.4 | `EDITOR` | OFF | Editable org config (editor always — Decision 11) | Dashboard with org data |
| TC-7.5 | `MEMBER` | ON | (no tab) — but `/seo` shows org analytics | Dashboard with org data, read-only |
| TC-7.6 | `MEMBER` | OFF | (no tab) | "Not Configured" / empty — no org data leaks |
| TC-7.7 | `SOLO` | n/a | Editable own config | Dashboard with own data |

**TC-7.1–7.7 detailed steps (repeat per row):**
1. As `OWNER`, set the sharing state via TS-6.
2. Log in as the row's user.
3. Open Settings → Analytics & SEO (if expected) — confirm the config shown matches "Expected in tab".
4. Open `/seo` — confirm "Expected on `/seo`".
5. For editors/members, confirm the cards are read-only (no Save buttons) when they can view but not edit — i.e. members never see the tab; an editor sees Save buttons.

**TC-7.8 — Member with sharing OFF gets no data via API** · P1
- Pre: `MEMBER`, sharing OFF.
- Steps: `GET CUSTOMER_URL/api/seo/config` with the member's token.
- Expected: `config` arrays empty, `canEdit: false`, `scope: "org"`. No owner data leaks.

---

### TS-8 — Bug A regression: Partner Portal "Configure SEO/AEO" dialog

**TC-8.1 — Dialog populates existing GA4 properties** · P1
- Pre: `OWNER`'s org has ≥1 GA4 property configured (TC-2.1).
- Steps: log in to `PARTNER_URL` as `ADMIN` → Admin → Users → find `OWNER` →
  open "Configure SEO/AEO".
- Expected: the GA4 list shows the **existing** properties immediately (NOT empty,
  NOT requiring "+ Add" first). SEO domains and Clarity projects also pre-populate.

**TC-8.2 — Dialog populates for an org member** · P1
- Steps: open "Configure SEO/AEO" for `MEMBER`.
- Expected: the dialog shows the **org-wide** resolved config (the same as `OWNER`'s),
  with an org-wide note under the title.

**TC-8.3 — Save from the dialog writes the org record** · P1
- Steps: in `OWNER`'s dialog, add a GA4 property → Save → reopen.
- Expected: the new property persists; opening `OWNER`'s customer-portal Analytics & SEO
  tab shows the same property (admin and self-service share one source of truth).

**TC-8.4 — Loading state** · P3
- Steps: open the dialog and observe before the fetch resolves.
- Expected: the Save button is disabled while loading; no stale data from a
  previously-opened user.

---

### TS-9 — Bug B regression: `/seo` User Journey Funnel section

**TC-9.1 — Funnel section visible to a member with org GA** · P1
- Pre: `MEMBER`, sharing ON, the org has a GA4 property configured.
- Steps: open `CUSTOMER_URL/seo`.
- Expected: the **"User Journey Funnel"** section renders.

**TC-9.2 — Funnel section hidden when no GA anywhere** · P2
- Pre: a user (e.g. `SOLO`) with no GA4 property configured.
- Steps: open `/seo`.
- Expected: the funnel section is absent — and there is **no stray "0"** rendered
  where the section would be (boolean-coercion regression check).

**TC-9.3 — Funnel section visible to the owner** · P2
- Pre: `OWNER` with org GA configured.
- Expected: the funnel section renders.

---

### TS-10 — Bug C regression: shared-funnel metrics

**TC-10.1 — Shared funnel metrics load without PERMISSION_DENIED** · P1
- Pre: `OWNER` has created/shared ≥1 funnel; org analytics sharing ON; the org's
  primary GA4 property is one the service account can access (verify via TC-5.1).
- Steps: log in as `MEMBER` → `/seo` → User Journey Funnel → select a shared funnel
  → load its metrics.
- Expected: metrics load and render. **No `7 PERMISSION_DENIED`** error.

**TC-10.2 — Funnel owner and viewer see consistent metrics** · P2
- Steps: note the metrics `OWNER` sees for a funnel; compare with what `MEMBER` sees
  for the same shared funnel and timeframe.
- Expected: the same numbers (both resolve to the same org GA4 property).

**TC-10.3 — Funnel metrics surface a real GA permission error gracefully** · P3
- Pre: the org's primary GA4 property is one the service account does NOT have
  access to.
- Steps: as `MEMBER`, load a shared funnel's metrics.
- Expected: a clear, handled error message — not an unhandled crash.

---

### TS-11 — Bug D regression: `/seo` "Not Configured" screen

**TC-11.1 — Member with shared analytics lands on a working dashboard** · P1
- Pre: `MEMBER`, sharing ON, org has SEO domains + GA configured.
- Steps: open `CUSTOMER_URL/seo` with **no** `?domain=` query param.
- Expected: the SEO dashboard loads — **not** the "SEO/AEO Not Configured" screen.
  A default domain (from the org's `seoDomains`) is selected automatically.

**TC-11.2 — Member with sharing OFF sees the Not-Configured screen** · P1
- Pre: `MEMBER`, sharing OFF, the member has no own config.
- Steps: open `/seo`.
- Expected: the "Not Configured" screen IS shown (correct — they have no access).

**TC-11.3 — Default domain fallback chain** · P2
- Pre: `MEMBER`, sharing ON; org has `seoDomains`.
- Steps: open `/seo` with no `?domain=`.
- Expected: the dashboard defaults to the first org SEO domain. Then open
  `/seo?domain=<another org domain>` → that domain is used instead.

---

### TS-12 — Delegation

**TC-12.1 — Admin delegated into an org user sees the correct config** · P1
- Pre: `ADMIN` uses "delegate access" into `MEMBER` (or `OWNER`).
- Steps: from the partner portal, delegate into the customer account → open the
  customer portal under delegation → Settings / `/seo`.
- Expected: the analytics config shown is the **target customer's** resolved config
  (org config for an org user) — `req.user` is the target, so resolution is the
  target's. Editing permission matches the target's role (owner/editor can edit,
  plain member cannot).

**TC-12.2 — Delegated `/api/seo/config` resolves the target** · P2
- Steps: under a delegated session, `GET /api/seo/config`.
- Expected: `scope` and `config` reflect the **target** user, not the admin.

---

### TS-13 — Migration & un-migrated fallback

**TC-13.1 — Migrated org reads from the Organization record** · P1
- Pre: the migration script has run.
- Steps: as `OWNER`, confirm the Analytics & SEO tab shows the migrated config;
  inspect the Organization record (or `GET /api/seo/config` `scope: "org"`).
- Expected: config is served from the org record; values match what the owner had
  pre-migration.

**TC-13.2 — Un-migrated org falls back to the owner record** · P2
- Pre: an org whose `analyticsConfigSource` is unset (not yet migrated) — or test
  before running the migration.
- Steps: as a `MEMBER` of that org with sharing ON, open `/seo`.
- Expected: analytics still resolve (resolver falls back to the owner's user record);
  no downtime / empty dashboard.

**TC-13.3 — Migration is idempotent** · P3
- Steps: run `migrate-analytics-config.ts --dry-run` a second time after applying.
- Expected: it reports 0 changed / all skipped (already-migrated orgs are no-ops).

**TC-13.4 — Migrated org with deliberately empty GA list stays empty** · P3
- Pre: an org migrated with an empty `googleAnalyticsProperties` array.
- Steps: as `OWNER`, open the Analytics & SEO tab.
- Expected: the GA4 list is empty — no fallback to the owner's user record
  overrides a deliberately-empty org config.

---

## 5. Results template

| TC | Result (Pass/Fail/Blocked) | Notes / evidence |
|---|---|---|
| TC-1.1 | | |
| TC-1.2 | | |
| ... | | |

Record failures with: the step that failed, expected vs actual, a
`browser_take_screenshot`, and any browser-console errors (`browser_console_messages`).

---

## 6. Suggested execution order

1. TS-13.2 (un-migrated fallback) — **before** running the migration, if testing migration.
2. Run the migration script.
3. TS-6 (set up sharing + editors) — establishes preconditions for TS-1 / TS-7.
4. TS-1 → TS-5 (self-service config, as `OWNER`).
5. TS-7 (resolution matrix — toggles sharing repeatedly).
6. TS-8 (Partner Portal, as `ADMIN`).
7. TS-9 → TS-11 (bug regressions, as `MEMBER`).
8. TS-10 (shared-funnel metrics).
9. TS-12 (delegation).
10. TS-13.1 / .3 / .4 (migration verification).

P1 cases are the release gate; P2/P3 can follow.
