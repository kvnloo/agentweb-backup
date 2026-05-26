# Organization-wide Analytics Sharing — Design Spec

**Date:** 2026-05-21
**Branch:** `harshit/org-wide-analytics-sharing`
**Status:** Approved for planning

---

## 1. Background & Goal

Today GA4 / analytics data is strictly per-user. Each user's SEO/Analytics
dashboard, Product analytics page, and agent-mode context are driven by that
user's own configuration (`googleAnalyticsProperties`, `seoDomains`, etc.),
which is set by a platform admin in the partner-portal. There is no way for an
organization's members to see a single shared set of analytics.

This spec adds **two independent features** to close that gap:

- **Part 1 — Org-wide Analytics sharing.** A platform-admin flag makes every
  org member inherit the **org owner's** analytics configuration (override
  model — members see *only* the org analytics while active).
- **Part 2 — Org-wide Funnel sharing.** User-journey funnels become a 6th
  fan-out shareable resource in the existing Organization Sharing framework,
  alongside Knowledge Base, Skills, etc.

The two parts are architecturally distinct (admin-controlled config inheritance
vs. customer-controlled fan-out) and can ship as two phases.

### Decisions locked during brainstorming

| Question | Decision |
|---|---|
| Sharing model for analytics | Shared org config (the org owner's), **org-only override** |
| What members see when org analytics is active | Org config only — personal config ignored |
| Scope of the override | Everywhere analytics is read (SEO dashboard, Product page, agent-mode) |
| Who controls the toggle | Platform admin, in partner-portal |
| Funnel behaviour | A 6th fan-out shareable resource ("like Knowledge Base"); editors + org owner can edit |

---

## 2. Part 1 — Org-wide Analytics Sharing

### 2.1 Model

- The org's shared analytics config **is the org owner's** per-user analytics
  configuration. It continues to be set by a platform admin in the
  partner-portal — no new customer-facing analytics config surface.
- **Override model:** while sharing is active, an org member's analytics
  surfaces are driven *entirely* by the org owner's config. The member's own
  personal config is ignored (not merged).
- Sharing is gated by a single **admin-controlled** flag on the organization.

### 2.2 The analytics bundle that travels (Review item #1)

"GA4 config" is not a single field. The analytics pipeline reads a cluster of
user fields, several of which are interpreted *relative to the GA4 property*:

| Field | Read at | Notes |
|---|---|---|
| `googleAnalyticsProperties[]` | `getGoogleAnalyticsProperties` — `seoService.ts:441` | GA4 properties (new array form) |
| `googleAnalyticsPropertyId` | legacy single-value fallback | DEPRECATED but still the only field some paths read (see #3) |
| `gaFilteredDomains[]` | `seoService.ts:498`, `seo.ts:388` | hostname-exclusion filter — meaningless apart from its property |
| `productDomain` | `seo.ts:937 / 976 / 995` | Product analytics = GA4 `runReport` filtered to this hostname |
| `seoDomains[]` | `fetchSearchConsoleMetrics` — `seoService.ts:190` | Search Console domains |
| `clarityProjects[]` / `clarityProjectId` | `getClarityProjects` — `seoService.ts:457` | Microsoft Clarity |

**Decision: share the whole analytics bundle, not just GA4.** A half-org /
half-personal dashboard (org traffic numbers next to the member's own Search
Console data) is incoherent and a guaranteed support burden, and the partner
admin already configures all of these fields in a single per-user dialog
(`admin.ts:1137-1142`). All six field groups travel together as one unit.

Consequently the flag is named for analytics, not GA4 specifically:

- New field: **`Organization.shareAnalyticsWithOrg?: boolean`** (default
  `false`). Standalone field — deliberately *not* inside `OrgShareSettings`,
  which is customer-controlled via an owner-only PATCH; keeping this
  admin-controlled flag separate prevents the customer route from ever
  clobbering it.

### 2.3 The resolver (Review item #3)

A single async resolver produces a structured config object:

```ts
// services/analyticsConfigResolver.ts (new)
export interface ResolvedAnalyticsConfig {
  properties: Array<{ propertyId: string; label: string }>;
  primaryPropertyId: string | null;   // properties[0]?.propertyId ?? null
  gaFilteredDomains: string[];
  productDomain?: string;
  seoDomains: string[];
  clarityProjects: Array<{ projectId: string; label: string }>;
  source: 'org' | 'self';             // drives the "Showing organization analytics" indicator
}

export async function resolveAnalyticsConfig(
  user: User,
): Promise<ResolvedAnalyticsConfig>;
```

Resolution logic:

1. If `user.orgId` is set, load the org. If `org.shareAnalyticsWithOrg === true`
   **and** the org owner (`org.ownerUserId`) has at least one GA4 property,
   build the bundle from the **org owner's** user record → `source: 'org'`.
2. Otherwise build the bundle from `user` itself → `source: 'self'`.
3. `primaryPropertyId` = first of `properties` (normalised through the existing
   `getGoogleAnalyticsProperties` legacy fallback), or `null`.

The resolver is **async** (needs `orgDb.getOrgById` + owner `userDb.getUserById`)
where the existing `getGoogleAnalyticsProperties` was synchronous. It accepts an
already-fetched `user` object so callers that already have the user don't
re-fetch it.

### 2.4 Pre-existing bug fixed by this work (Review item #3)

`getGoogleAnalyticsProperties` (`seoService.ts:441`) already normalises
legacy→array, but two code paths **bypass it and read the raw legacy scalar**
`user.googleAnalyticsPropertyId` directly:

- **Funnel** — `seo.ts:682` (`if (user.googleAnalyticsPropertyId && funnelId)`)
  and `seo.ts:725` (passed to `calculateFunnelMetrics`).
- **Product analytics** — `seo.ts:937` (configured-gate) and `seo.ts:976`
  (`propertyId = user.googleAnalyticsPropertyId`).

**Bug:** a user with only the new `googleAnalyticsProperties[]` array and no
legacy `googleAnalyticsPropertyId` gets **no funnel and no Product analytics
today** — both silently no-op. This is load-bearing for Part 1: the org-shared
property arrives in array form on the owner, so unless these paths stop reading
the raw scalar, the feature will not reach them. The fix (routing both through
`resolved.primaryPropertyId`) is in scope.

### 2.5 Call-site changes

| Location | Change |
|---|---|
| `seo.ts` main GA path (~`339`) + `gaFilteredDomains` (`388`) | use `resolved.properties` / `resolved.gaFilteredDomains` |
| `seo.ts` funnel (`682`, `725`) | use `resolved.primaryPropertyId` *(also fixes #3 bug)* |
| `seo.ts` Product analytics (`937`, `976`, `995`, `1048`, `1112`, `1232`) | use `resolved.primaryPropertyId` + `resolved.productDomain` *(also fixes #3 bug)* |
| `seo.ts:33` configured-gate | `resolved.properties.length || resolved.seoDomains.length` |
| `utils/userConfigContext.ts` | use `resolved.*`; becomes async or takes the resolved config as a param |
| `seoService.ts` `fetchGoogleAnalyticsMetrics`, `fetchSearchConsoleMetrics`, `fetchClarityProjectInfo` | resolve internally (see §2.6); accept an optional pre-resolved config to avoid a double org/owner lookup when the caller already resolved |
| `routes/auth.ts` `/api/auth/me` | add a computed `effectiveAnalyticsConfig` (the resolver output) so the customer-portal can gate correctly |

To avoid a double org/owner lookup in the `seo.ts` metrics route (which both
resolves the bundle *and* calls the `seoService` fetch functions), the fetch
functions take an **optional** `resolvedConfig` parameter: when supplied they
use it; when omitted (agent-mode tools, §2.6) they resolve internally.

### 2.6 Agent-mode coverage (Review item #9 — verified)

Verified: agent-mode **does** have analytics tools. `emma/tools.ts:5537`
(`get_seo_metrics`) calls `fetchSearchConsoleMetrics`, and `emma/tools.ts:5591`
calls `fetchGoogleAnalyticsMetrics`. Both pass only a `userId`.

Because the resolver is applied **inside** `fetchGoogleAnalyticsMetrics`,
`fetchSearchConsoleMetrics`, and `fetchClarityProjectInfo` (which already fetch
the user internally), agent-mode tools inherit org-wide sharing automatically —
no per-tool change required. `utils/userConfigContext.ts` (the agent-mode config
context string) is updated separately per §2.5.

### 2.7 Admin control — partner-portal (Review item #7)

- **Backend route:** new `PATCH /api/admin/orgs/:orgId/analytics-sharing`,
  admin-only, body `{ enabled: boolean }` → sets
  `Organization.shareAnalyticsWithOrg`. Returns `404` for an unknown org.
- **Admin user payload:** the admin user list (`admin.ts:521-535`) currently
  batch-fetches only `org.name` into `orgMap`. Extend `orgMap` to also carry
  `ownerUserId`, and set a computed **`user.isOrgOwner`** boolean on each
  sanitised user (`org.ownerUserId === user.userId`). The partner-portal needs
  this to decide whether to show the checkbox.
- **Partner-portal UI:** add a **"Share analytics with organization"** checkbox
  to the existing per-user SEO/analytics dialog in `AdminDashboard.tsx`. The
  checkbox is shown **only when the edited user `isOrgOwner`** (with an
  explanatory hint otherwise — resolution reads the owner's config). On save it
  calls the new admin route with the user's `orgId`.

### 2.8 Customer-portal

- `SEO.tsx` / `Product.tsx`: the `isConfigured` / `isSeoConfigured` gates switch
  to the `effectiveAnalyticsConfig` from `/api/auth/me` (no resolution logic
  duplicated client-side). When org analytics is active a member sees org
  metrics instead of the "contact your administrator" message.
- A small **"Showing organization analytics"** indicator on the SEO/Analytics
  page when `effectiveAnalyticsConfig.source === 'org'`. The indicator is shown
  to members only — **not** to the org owner, whose data is their own.
- No customer-facing toggle.

---

## 3. Part 2 — Org-wide Funnel Sharing

### 3.1 Model — a 6th fan-out resource

User-journey funnels become the 6th toggleable resource in the existing
Organization Sharing framework, behaving exactly like Knowledge Base / Skills:
`{ enabled, editors }`, fan-out across org members, "Shared by [name]" badges,
editors + org owner can edit.

Funnels are stored in the `AW-Settings` table keyed `funnels_<userId>` — a
single item holding that user's funnels as a map `{ [funnelId]: FunnelConfig }`.
CRUD lives in `routes/funnel.ts` (`/api/funnels`).

### 3.2 Data model

Add `funnels` to `OrgShareSettings` (`db.ts`):

```ts
export interface OrgShareSettings {
  knowledgeBase: { enabled: boolean; editors: string[] };
  htmlTemplates: { enabled: boolean; editors: string[] };
  landingPages:  { enabled: boolean; editors: string[] };
  workPlans:     { enabled: boolean; editors: string[] };
  skills:        { enabled: boolean; editors: string[] };
  funnels:       { enabled: boolean; editors: string[] };   // NEW
  brandGuidelines:   { editors: string[] };
  marketingStrategy: { editors: string[] };
}
```

- `orgShareService.ts`: add `"funnels"` to the `ToggleableFeature` union and to
  the `TOGGLEABLE_FEATURES` array.
- `db.ts` `updateShareSettings` (~`7454`): default `funnels` to
  `{ enabled: false, editors: [] }` for orgs created before this change.
- The owner-only share-settings PATCH validation must accept `funnels`.
- All read paths / `OrgSharingTab` must tolerate a missing `funnels` (default
  off).

### 3.3 API changes — `routes/funnel.ts`

- **`GET /api/funnels`** — fan-out: caller's funnels plus, when the feature is
  effectively enabled for the caller, every org member's funnels. Each funnel in
  the response is tagged with `ownerUserId` and the owner's display name for a
  "Shared by [name]" badge. Reuse the existing `listOrgVisibleItems` helper /
  member-fanout cap pattern (`MEMBER_FANOUT_CAP = 100`).
- **`GET / PUT / DELETE /api/funnels/:configId`** — resolve the owning user,
  then gate with `canViewItem` / `canEditItem` from `orgShareService.ts`.
  Editors + org owner may edit; **delete = owner or org owner only**. To avoid
  an O(members) scan, the client passes the `ownerUserId` (it has it from the
  list response) as a parameter; the route falls back to the caller's own funnel
  map when `ownerUserId` is absent.

### 3.4 `seo.ts` funnel-metrics lookup must be org-aware

`seo.ts:~694` looks the funnel up in `funnels_${req.user.userId}` — the
**viewer's own** map. A shared funnel owned by another member would appear in the
selector but `funnels?.[funnelId]` would be `undefined` → funnel shows, metrics
blank. The metrics route must resolve the funnel for the **owning** member
(client passes `funnelOwnerId`, consistent with §3.3) and gate it with
`canViewItem`. It must also use `resolved.primaryPropertyId` from Part 1's
resolver instead of the raw `user.googleAnalyticsPropertyId` (`seo.ts:725`).

### 3.5 Member removal (Review item #5)

When an org member is removed, they must be stripped from `funnels.editors` and
their funnels handled like other shareable items:

- `db.ts` `pruneEditorListsForUser` (`7445`) explicitly enumerates every feature
  when rebuilding `OrgShareSettings` — add a `funnels` line so removed members
  lose funnel-editor rights.
- `routes/orgMemberRemoval.ts`: add `funnels` to the feature enumeration
  (`removal-preview` `itemCounts`, line ~`33-49`) and to the transfer / delete
  per-feature handling so a removed member's funnels are transferred or deleted
  with the rest.

### 3.6 Customer-portal

- `OrgSharingTab.tsx` (Settings → Organization → Sharing): new "Funnels" row —
  enable toggle + editors multi-select, identical to the other 5 toggleable
  features.
- `SEO.tsx` funnel selector: show "Shared by [name]" badges (reuse the existing
  `SharedByBadge.tsx`); non-editors see shared funnels read-only;
  `FunnelConfig.tsx` editing is gated by edit permission.

---

## 4. Interaction Between Part 1 and Part 2

The two toggles are **independent**. A fanned-out funnel runs against whatever
GA4 property the *viewer* resolves to — the org owner's (Part 1 on) or the
viewer's own (Part 1 off). The two features are most coherent together but work
independently.

Known limitation (call out in UI copy): a funnel's stages reference GA4 event
names that exist inside a *specific* property. A shared funnel only produces
meaningful numbers when it is viewed against the property it was authored for —
otherwise the existing "Insufficient data" handling applies.

---

## 5. Out of Scope / Deferred

**Out of scope (v1):**

- Legacy `GET/PUT /api/seo/funnel-config` + `user.funnelConfig` — orphaned
  (no frontend consumer; not read by the metrics path). Sharing them would be an
  invisible no-op. Optional dead-code cleanup, separate commit, not this feature.
- No customer-facing self-service analytics config surface — analytics config
  remains admin-managed in partner-portal.
- No auto-seeding of funnel configs.

**Deferred — known risks accepted out of v1** (raised in CTO review, explicitly
not addressed here per scoping decision; recorded so they are not lost):

- **Funnel-blob write concurrency (#2).** `saveUserFunnels` does a whole-blob
  `put`; fan-out editing by multiple org editors against the same member's blob
  can lose updates. Recommended follow-up: switch to nested-attribute updates
  (`SET funnels.#fid = :f` / `REMOVE funnels.#fid`). Test FS-24 documents the
  risk as a known-fail.
- **O(members) scans (#4).** Mitigated where cheap by passing `ownerUserId` /
  `funnelOwnerId` from the client (§3.3, §3.4); the fan-out `GET /api/funnels`
  scan itself is inherent to the model.
- **Contractor access (#6).** Whether contractor org members should receive
  org analytics / funnels is not decided here.

---

## 6. Testing (TDD — per CLAUDE.md)

Backend tests written before implementation; CI requires ≥95% coverage.

**Part 1**
- `resolveAnalyticsConfig`: in-org + flag on + owner has GA4 → owner bundle
  (`source: 'org'`); flag off → self; no org → self; flag on but owner has no
  GA4 → defensive fallback to self; legacy-only owner (`googleAnalyticsPropertyId`
  only) normalises into `properties` / `primaryPropertyId`; the bundle carries
  `gaFilteredDomains` / `productDomain` / `seoDomains` / `clarityProjects` from
  the resolved source.
- Funnel + Product paths resolve via `primaryPropertyId` (regression test for
  the #3 bug: array-only user gets a funnel and Product analytics).
- `PATCH /api/admin/orgs/:orgId/analytics-sharing`: admin-only (403 for
  non-admin), 404 for unknown org, persists the flag.
- `/api/auth/me` returns `effectiveAnalyticsConfig`.
- Admin user payload exposes `isOrgOwner`.

**Part 2**
- `OrgShareSettings.funnels` default backfill on read / `updateShareSettings`.
- `GET /api/funnels` fan-out merge + owner tagging; `canView` / `canEdit` for
  editor vs. non-editor vs. owner; delete restricted to owner / org owner.
- `seo.ts` funnel metrics resolves a shared funnel by `funnelOwnerId` + gates
  with `canViewItem`.
- `pruneEditorListsForUser` strips a removed user from `funnels.editors`.
- `orgMemberRemoval` includes `funnels` in preview counts and transfer/delete.

---

## 7. End-to-End Test Plan (Playwright, cloud test environment)

These scenario tests are executed with the Playwright MCP browser tools
(`mcp__playwright__browser_*`) against an ephemeral cloud test environment
(`./test-env/test-env.sh launch`, then `./test-env/test-env.sh sync` after every
code change). They complement — not replace — the backend unit tests in §6.

### 7.1 Test environment & accounts

- Partner-portal and customer-portal URLs taken from the active test-env.
- **Platform admin** — `test@example.com` / `Test123!` (partner-portal access).
- The remaining personas do not exist by default — create them in §7.3:

| Persona | Role | Used for |
|---|---|---|
| **Owner** | Org owner (`orgRole = "owner"`) | Source of the shared analytics bundle |
| **Member A** | Org member, funnel **editor** | Editor-permission scenarios |
| **Member B** | Org member, **plain** member (never an editor) | Plain-member scenarios |
| **Member C** | Org member, **disposable** | Destructive removal tests only (§7.6 Group K) — never depended on by any other test |
| **Solo** | User with no `orgId` | Non-org regression |
| **Outsider** | Owner of a *different* org | Cross-org isolation |

`Member C` exists solely so the destructive member-removal tests cannot corrupt
the fixture the other tests depend on.

### 7.2 Execution protocol

- **Single browser, explicit persona switches.** Playwright MCP drives one
  browser. Every persona change = log out through the UI, confirm the redirect
  to the login page, then log in as the next persona. Never assume a carried-over
  session. (`browser_tabs` with separate contexts is an acceptable alternative.)
- **Token capture for API tests.** After logging in as each persona, capture the
  JWT (`browser_evaluate` → `localStorage.getItem('token')`) and keep it labelled
  for §7.7's direct API calls.
- **Async waits.** Metric panels load asynchronously — use
  `browser_wait_for` (network idle or a specific element/text) before asserting;
  never assert immediately after navigation.
- **Self-contained preconditions.** Each test's **Pre** column lists the exact
  state to establish *before* the test (`Set: …`). The executor establishes it
  explicitly — no test relies on a previous test having left the right state.
- **State hygiene.** Any test that flips `shareAnalyticsWithOrg` or funnels
  sharing **restores the prior value** as its final step.
- **Run order.**
  1. §7.3 test-data setup
  2. §7.5 Part 1 (AS-*)
  3. §7.6 Part 2 Groups E–J (FS-01 … FS-25)
  4. §7.7 API authorization (API-*)
  5. §7.8 Interaction (IN-*)
  6. §7.6 Part 2 **Group K** (FS-26 … FS-28) — destructive, **Member C**, runs last
  7. §7.9 regression sweep

### 7.3 Test data setup (run once per fresh environment)

1. As the platform admin, create the 6 personas above.
2. Create an organization owned by **Owner**; invite **Member A**, **Member B**,
   and **Member C**; accept all three invites so each has `orgId` set.
3. Create a second organization owned by **Outsider**.
4. As the platform admin, configure the analytics bundle on **Owner**: **two**
   GA4 properties (new array form, both readable by the service account — needed
   for AS-22), `gaFilteredDomains`, `productDomain`, `seoDomains`, and a Clarity
   project.
5. Configure a *different* GA4 property + `productDomain` on **Member A** (so an
   override is visually distinguishable from personal config).
6. Leave **Member B** and **Member C** with no analytics configuration.
7. Have **Owner**, **Member A**, **Member B**, and **Member C** each create ≥2
   named funnels; give Owner and Member A one funnel with an identical name
   ("Main Funnel") for AS/FS collision testing.

### 7.4 Assertion strategy

The cloud test-env calls the real Google APIs through the shared service
account, so live metric *values* are non-deterministic and may be empty. **Every
`Expected` below is an objectively checkable signal — never a number:**

- the **property ID / label** the page renders (`SEO.tsx` shows
  `Property ID: {id}` and a property selector when there are several);
- presence/absence of a named element — the **"Showing organization analytics"**
  indicator, the **"contact your administrator"** not-configured panel, a
  **per-property error** message, the **funnel-metrics** panel;
- **funnel selector** option count + **"Shared by [name]"** badge text;
- the funnel form's **read-only vs. editable** state (inputs disabled / no Save);
- request URLs, request bodies, and **HTTP status codes** via
  `mcp__playwright__browser_network_requests` (e.g. `effectiveAnalyticsConfig.source`,
  the `/api/funnels` response, `funnelId` / `funnelOwnerId` query params).

**Not E2E-verifiable — covered by §6 unit tests instead:** the
`gaFilteredDomains` hostname exclusion is applied server-side in the
backend→Google call and is not observable from the browser; it is asserted in
the `resolveAnalyticsConfig` unit tests (§6), not here.

### 7.5 Part 1 — Analytics sharing scenarios

**Group A — Admin checkbox & save (#7)**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| AS-01 | Checkbox shown for org owner | Setup done | Admin → partner-portal → users → open **Owner**'s SEO/analytics dialog | A "Share analytics with organization" checkbox element is present and enabled |
| AS-02 | Checkbox hidden for non-owner | — | Admin → open **Member A**'s SEO/analytics dialog | Checkbox element is **absent** (or present-but-disabled with hint text "applies to the org owner") |
| AS-03 | Checkbox hidden for solo user | — | Admin → open **Solo**'s SEO/analytics dialog | Checkbox element is **absent** |
| AS-04 | Admin save round-trips (S7) | Set: flag OFF | Admin opens **Owner**'s dialog, ticks the checkbox, saves; close dialog; reopen it | Save request `PATCH /api/admin/orgs/:orgId/analytics-sharing` returns **200**; on reopen the checkbox is **checked** |

**Group B — Enabling (override behaviour)**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| AS-05 | Member with own config is overridden | Set: flag ON; Member A has own GA4 | Member A → customer-portal → SEO/Analytics page | Rendered `Property ID` equals **Owner's** GA4 ID and **≠** Member A's; "Showing organization analytics" indicator element present |
| AS-06 | Unconfigured member sees org analytics | Set: flag ON; Member B has no config | Member B → SEO/Analytics page | No "contact your administrator" panel; a GA metrics panel is rendered; indicator present |
| AS-07 | Owner sees own analytics, no indicator (N3) | Set: flag ON | Owner → SEO/Analytics page | Owner's own `Property ID` shown; the "Showing organization analytics" indicator is **absent** (owner's data is their own) |
| AS-08 | Product analytics inherits bundle (#3) | Set: flag ON | Member B → Product analytics page | Page is **not** in the "contact administrator" state; the Product analytics view renders; a product-metrics request is issued |
| AS-09 | Funnel runs against org property (#3) | Set: flag ON; Owner GA4 is array-only | Member B → SEO page → select any funnel; `browser_wait_for` the funnel panel | A metrics request carries a `funnelId`; the funnel-metrics panel reaches a terminal state — either rendered stages or an explicit "Insufficient data" message — it is **not absent** |
| AS-10 | Search Console inherits | Set: flag ON | Member B → SEO page → Search Console section | Section is populated (not the not-configured message); reflects Owner's `seoDomains` |
| AS-11 | Clarity inherits | Set: flag ON | Member B → SEO page → Clarity section | Clarity project ID shown equals **Owner's** |
| AS-12 | Agent-mode inherits — both tools (#9) | Set: flag ON | Member B → Agent Mode → (a) "show my Search Console metrics" (b) "show my GA4 analytics" | Both replies reference **Owner's** configured property/domain; neither says "not configured" |
| AS-13 | `/api/auth/me` exposes `source: org` | Set: flag ON | Member B → load any page; inspect `/api/auth/me` via `browser_network_requests` | Response JSON: `effectiveAnalyticsConfig.source === "org"`; `properties` contains Owner's property ID |

**Group C — Disabling (revert)**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| AS-14 | Member with own config reverts | Set: flag ON, then admin disables it | Member A → SEO page | Rendered `Property ID` equals **Member A's own**; indicator absent; `/api/auth/me` → `effectiveAnalyticsConfig.source === "self"` |
| AS-15 | Unconfigured member reverts | Set: flag OFF | Member B → SEO page | "Contact your administrator" panel is present again |

**Group D — Edge cases**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| AS-16 | Flag ON, owner has no GA4 → fallback | Set: clear Owner's GA4; flag ON | Member A → SEO page; Member B → SEO page | Member A sees **own** property; Member B sees "contact administrator". **Restore Owner's GA4 afterwards.** |
| AS-17 | Legacy single-property owner | Set: Owner has only legacy `googleAnalyticsPropertyId`; flag ON | Member B → SEO page | Owner's legacy property ID is shown (normalised). **Restore Owner to array config afterwards.** |
| AS-18 | Solo user unaffected | Set: flag ON | Solo → SEO page | Shows Solo's own state only; Owner's property ID never appears |
| AS-19 | Cross-org isolation | Set: flag ON for the org | Outsider → SEO page | Owner's property ID never appears; Outsider sees only their own config/state |
| AS-20 | Delegation resolves target | Set: flag ON | Admin → delegate into **Member A** → open SEO page | Page shows **Owner's** property ID (resolver runs on the delegated target user) |
| AS-21 | Staleness after a mid-session flag flip (S1) | Set: flag OFF; Member B logged in on the SEO page | Admin flips flag ON → Member B (a) navigates away and back to SEO (b) does a hard refresh | After the **hard refresh** `/api/auth/me` is re-fetched and the page shows org analytics. Record whether (a) plain navigation also updates; if it shows stale data, log it as a defect to fix in implementation |
| AS-22 | Multiple GA4 properties (S5) | Set: Owner has 2 GA4 properties; flag ON | Member B → SEO page | The property selector renders **2** options with Owner's two labels |
| AS-23 | GA API failure path (S3) | Set: Owner has one property the service account **cannot** access; flag ON | Member B → SEO page | That property shows a graceful per-property error message; the page does not crash; any other property still renders. **Restore Owner's config afterwards.** |

### 7.6 Part 2 — Funnel sharing scenarios

**Group E — OrgSharingTab**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| FS-01 | Funnels row present | Setup done | Owner → Settings → Organization → Sharing | A "Funnels" row exists with an enable toggle + an editors multi-select |
| FS-02 | Enable + add editor persists | Set: funnels sharing OFF | Owner enables Funnels sharing, adds **Member A** as editor, saves; reload the page | After reload the toggle is ON and Member A is listed as an editor |
| FS-03 | Share settings owner-only | Set: funnels sharing configured | Member A → Settings → Organization → Sharing | The Funnels toggle and editors control are **read-only/disabled** for a non-owner |

**Group F — Fan-out visibility**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| FS-04 | Plain member sees all when ON | Set: sharing ON | Member B → SEO page → funnel selector | Selector lists Member B's own funnels **plus** every other org member's funnels |
| FS-05 | Editor sees all when ON | Set: sharing ON | Member A → funnel selector | Selector lists all org members' funnels |
| FS-06 | Plain member sees only own when OFF | Set: sharing OFF | Member B → funnel selector | Selector lists **only** Member B's own funnels |
| FS-07 | Editor still sees all when OFF | Set: sharing OFF; Member A is editor | Member A → funnel selector | Selector still lists all org members' funnels (editors always do) |
| FS-08 | Owner still sees all when OFF | Set: sharing OFF | Owner → funnel selector | Selector still lists all org members' funnels |
| FS-09 | Badge correctness (S6) | Set: sharing ON | Member B → funnel selector | Member B's **own** funnels show **no** "Shared by" badge; every other funnel shows a badge whose name matches its actual owner (Owner / Member A) |
| FS-10 | Name-collision disambiguation | Set: sharing ON; Owner & Member A both have "Main Funnel" | Member B → funnel selector | Both "Main Funnel" entries appear, each disambiguated by its "Shared by" badge |
| FS-11 | Empty state (S4) | Set: sharing ON; pick an org member with zero funnels viewing | A member with no own funnels opens the SEO funnel selector | Selector shows shared funnels (if any) and renders an explicit empty/placeholder state instead of crashing; with sharing OFF and zero own funnels it shows the "no funnels" empty state |
| FS-12 | Cross-org isolation | Set: sharing ON | Outsider → funnel selector | None of this org's funnels appear |

**Group G — Edit / delete permissions**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| FS-13 | Editor edits another's funnel | Set: sharing ON; Member A is editor | Member A opens **Member B's** funnel, edits a stage, saves | `PUT /api/funnels/:id` returns 200; on reload the change persists |
| FS-14 | Plain member is read-only | Set: sharing ON | Member B opens **Member A's** shared funnel | The funnel form inputs are disabled; no Save action is available |
| FS-15 | Owner edits any funnel | Set: sharing ON | Owner opens a member's funnel, edits, saves | `PUT` returns 200; change persists |
| FS-16 | Member edits own funnel | Set: any sharing state | Member B edits their **own** funnel, saves | `PUT` returns 200; change persists |
| FS-17 | Plain member CRUD on own funnel when sharing ON (S2) | Set: sharing ON; Member B is a plain member | Member B creates a new funnel, then deletes it | Create `POST /api/funnels` returns 200 and the funnel appears; delete returns 200 and it disappears — a plain member never loses control of their own funnels |
| FS-18 | Editor cannot delete another's funnel | Set: sharing ON; Member A is editor | Member A attempts to delete **Member B's** funnel | No delete control is offered; a direct `DELETE` returns **403** (also asserted in API-05) |
| FS-19 | Owner deletes any funnel | Set: sharing ON | Owner deletes a member's funnel | `DELETE` returns 200; funnel removed |
| FS-20 | Funnel owner deletes own | Set: sharing ON | Member B deletes their own funnel; Member A refreshes the selector | `DELETE` returns 200; the funnel disappears from all members' selectors |

**Group H — Funnel metrics (§3.4)**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| FS-21 | Shared funnel computes metrics | Set: sharing ON | Member B selects a funnel **owned by Member A**; `browser_wait_for` the panel | The metrics request carries `funnelOwnerId = Member A`; the funnel-metrics panel reaches a terminal rendered state — **not blank/absent** |
| FS-22 | Shared funnel uses resolved property | Set: sharing ON; analytics flag ON | While viewing a shared funnel, inspect the metrics request | Funnel is computed against the **resolved** GA4 property (Owner's, per Part 1) |

**Group I — Staleness & concurrency**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| FS-23 | Mid-session sharing toggle (S9) | Set: sharing ON; Member B on the SEO page viewing a shared funnel | Owner disables Funnels sharing → Member B refreshes the SEO page | The shared funnel is no longer in Member B's selector; no stale-state crash |
| FS-24 | Concurrency — known-fail (S10, #2) | Set: sharing ON | Member A and Owner each edit **different funnels belonging to Member B** in close succession, then reload Member B's funnel list | Both edits should survive. **This test is expected to FAIL (`xfail`) while the deferred whole-blob `put` (#2) stands** — it documents the data-loss risk and becomes a pass once #2 is fixed |

**Group J — Delegation (S8)**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| FS-25 | Funnels under delegation | Set: sharing ON; Member A is editor | Admin delegates into **Member B** → open a shared funnel (read-only expected); end delegation; delegate into **Member A** → edit a shared funnel | As Member B the funnel form is read-only; as Member A the edit saves (200) — delegation resolves funnel permissions to the target user |

**Group K — Member removal (#5) — destructive, Member C, runs LAST**

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| FS-26 | Removal-preview counts funnels | Set: Member C has ≥2 funnels | Owner → remove **Member C** → open the removal preview | The preview `itemCounts` includes a non-zero **funnels** count |
| FS-27 | Removal strips funnel-editor | Set: Member C is a Funnels editor | Owner completes removal of Member C → Owner → Sharing tab → Funnels editors | Member C is **no longer** listed as a Funnels editor |
| FS-28 | Removed member's funnels handled | — | During FS-27's removal, choose a transfer (or delete) decision | Member C's funnels are transferred to the chosen owner (or deleted) per the decision; the result is reflected in the funnel list |

### 7.7 API-level authorization tests (Review item C2)

UI gating is not authorization. These tests issue requests **directly** via
`browser_evaluate` + `fetch`, using each persona's captured JWT (§7.2), and
assert on HTTP status — independent of any button being hidden.

| ID | Caller | Request | Expected |
|---|---|---|---|
| API-01 | Member B (non-admin) | `PATCH /api/admin/orgs/:orgId/analytics-sharing` `{enabled:true}` | **403** |
| API-02 | Platform admin | `PATCH /api/admin/orgs/UNKNOWN_ORG/analytics-sharing` | **404** |
| API-03 | Member B (plain, sharing ON) | `PUT /api/funnels/:configId` on **Member A's** funnel | **403** |
| API-04 | Member B (plain, sharing ON) | `DELETE /api/funnels/:configId` on **Member A's** funnel | **403** |
| API-05 | Member A (editor, sharing ON) | `DELETE /api/funnels/:configId` on **Member B's** funnel | **403** (editors edit but cannot delete others') |
| API-06 | Outsider | `GET /api/funnels/:configId` for one of **this org's** funnels | **403 or 404** |
| API-07 | Member A (non-owner) | `PATCH /api/orgs/me/share-settings` changing `funnels` | **403** (owner-only) |
| API-08 | Member B (plain, sharing **OFF**) | `PUT /api/funnels/:configId` on **Member A's** funnel | **403** (no cross-member access when sharing is off) |
| API-09 | Member A (editor, sharing ON) | `PUT /api/funnels/:configId` on **Member B's** funnel | **200** — positive control proving the editor path works |

### 7.8 Interaction scenarios

| ID | Title | Pre | Steps | Expected |
|---|---|---|---|---|
| IN-01 | Both features ON | Set: analytics flag ON; funnels sharing ON | Member B views a funnel shared by Member A | Funnel is computed against the **org owner's** GA4 property; the metrics panel reaches a terminal rendered state |
| IN-02 | Funnels ON, analytics OFF | Set: analytics flag OFF; funnels sharing ON | Member B views a funnel shared by Member A | Funnel is computed against **Member B's own** property; an "Insufficient data" message is acceptable per §4 |

### 7.9 Regression sweep

After both phases, re-run a condensed sweep proving the non-org path is
unchanged: **Solo** user — SEO page (own property shown, indicator absent),
Product page, funnels create/edit/delete, and one agent-mode analytics query —
all behave exactly as before this feature.

---

## 8. Delivery

One spec, two phases — they are architecturally independent:

1. **Phase 1 — Analytics sharing.** `shareAnalyticsWithOrg` field, resolver,
   call-site rewrites + #3 bug fix, admin route + checkbox + `isOrgOwner`,
   `/api/auth/me` field, customer-portal gating.
2. **Phase 2 — Funnel sharing.** `OrgShareSettings.funnels`, `/api/funnels`
   fan-out + per-item gating, `seo.ts` metrics lookup, member-removal wiring,
   `OrgSharingTab` row + badges.

Each phase: separate commits for bug fix / feature / tests / release notes per
the repo's commit-granularity rule.
