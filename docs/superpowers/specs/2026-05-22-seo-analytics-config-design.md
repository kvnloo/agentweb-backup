# Self-Service SEO / GA / Clarity Analytics Config — Design

**Date:** 2026-05-22
**Branch:** `harshit/org-wide-analytics-sharing`
**Status:** Approved design — ready for implementation planning

## 1. Overview

Today, a user's SEO domains, Google Analytics 4 (GA4) properties, and Microsoft
Clarity projects can only be configured by an admin in the Partner Portal
("Configure SEO/AEO" dialog → `PUT /api/admin/users/:id/seo-aeo`). There is no
self-service path.

This project adds a **self-service "Analytics & SEO" Settings tab** in the
customer portal so users configure their own analytics, and makes that
configuration **organization-aware**: the org owner and designated analytics
editors manage one shared org config; ordinary members can only *view* the
resulting analytics (never the configuration) when the owner has enabled
sharing.

It also fixes four confirmed bugs that currently break the org-shared analytics
experience.

## 2. Goals / Non-Goals

### Goals
- A user-friendly customer-portal Settings tab to self-configure GA4 properties,
  SEO domains, and Clarity projects.
- Organization-aware access: owner + analytics editors configure; members view
  only.
- Make the **Organization record** the single source of truth for an org's
  analytics config.
- Surface GA4 connection problems early via a per-property "Test connection"
  control.
- Fix the four bugs (A–D, Section 7).

### Non-Goals
- **Google Search Console (GSC) connection validation.** GSC has the same
  silent service-account-grant failure mode as GA, but a "Test connection" for
  SEO domains is a deliberate YAGNI deferral — GA is where the reported pain is.
- **Funnel configuration.** Funnels remain configured on the `/seo` page; this
  spec does not move or change funnel CRUD.
- **Clarity metrics ingestion.** Clarity remains display-only (dashboard links);
  no Data Export API integration.
- Replacing the Partner Portal admin dialog — it stays as an admin/support
  override and is kept working.

## 3. Decisions Log

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope | One spec: the new feature **and** all four bugs. |
| 2 | Org edit-access model | Org owner + a new `analytics` **editors list** in `OrgShareSettings`, matching the existing per-feature pattern. |
| 3 | Config storage | The **Organization record** is the source of truth for org-shared analytics config. Solo users keep config on their own user record. |
| 4 | GA validation UX | Show the service-account email + a per-property **"Test connection"** button (live probe). |
| 5 | "Share analytics" toggle | Controlled by the **org owner only**. |
| 6 | New-tab layout | **Per-section cards, save per card** (matches existing Settings page). |
| 7 | Sharing toggle location | Lives in the existing **Organization Sharing tab**, not the new Analytics & SEO tab. |
| 8 | Migration strategy | **One-time batch script + resolver fallback.** |
| 9 | Primary GA property | **Explicit "Primary" radio** on one GA4 property row. |
| 10 | Rollback handling | **Single-write** to the Org record; accept that a backend revert temporarily hides post-deploy edits (no data loss). |
| 11 | Editor view when sharing off | Analytics editors keep `/seo` dashboard access regardless of the sharing toggle; the toggle gates ordinary members only. |

## 4. Data Model

All types live in `backend/src/services/db.ts`.

### 4.1 `OrgShareSettings` gains an `analytics` feature

Add an `analytics` entry to the `OrgShareSettings` interface, shaped like the
other toggleable features:

```ts
analytics: { enabled: boolean; editors: string[] }
```

- `enabled` — members may view shared analytics.
- `editors` — `userId`s allowed to edit the org's analytics config.

Add `"analytics"` to `TOGGLEABLE_FEATURES` in
`backend/src/services/orgShareService.ts`. This wires the feature into the
existing Organization Sharing tab and the `orgShareSettings.ts` validation
automatically.

The legacy standalone `Organization.shareAnalyticsWithOrg` boolean is migrated
into `shareSettings.analytics.enabled` (Section 8) and then deprecated. The
resolver and admin routes read `shareSettings.analytics.enabled` for a migrated
org and fall back to the old `shareAnalyticsWithOrg` boolean for an un-migrated
org (one-release fallback).

### 4.2 Organization record becomes the config source of truth

The org analytics config lives on the `Organization` record:

| Field | Notes |
|-------|-------|
| `googleAnalyticsProperties: Array<{ propertyId; label }>` | Already exists on `Organization`. |
| `primaryAnalyticsPropertyId?: string` | **New.** The explicit primary (Decision 9). |
| `gaFilteredDomains?: string[]` | **New** on `Organization`. |
| `seoDomains?: string[]` | Already exists on `Organization`. |
| `clarityProjects?: Array<{ projectId; label }>` | **New** on `Organization`. |
| `productDomain?: string` | **New** on `Organization`. |
| `analyticsConfigSource?: "migrated" \| "self"` | **New.** Migration marker — see 4.4. |

Solo users (no `orgId`) keep these fields on their **user record** (they already
exist there).

### 4.3 `resolveAnalyticsConfig()` rewrite

`backend/src/services/analyticsConfigResolver.ts`:

- **User has `orgId`** → read config from the `Organization` record.
  - `source: "self"` when the caller is the org owner.
  - `source: "org"` for everyone else in the org.
  - **Member gate:** if sharing is `false`, ordinary members receive an *empty*
    resolved config (`source: "self"`, empty arrays) — they cannot view. The
    owner and analytics editors **always** receive the config, regardless of the
    toggle (Decision 11). The gate reads `shareSettings.analytics.enabled` for a
    migrated org, and the legacy `Organization.shareAnalyticsWithOrg` boolean for
    an un-migrated org.
- **User has no `orgId`** → read from the user's own record. `source: "self"`.
- **Fallback:** if the `Organization` record has not been migrated
  (see 4.4), fall back to reading the org owner's user record. Log when the
  fallback path is taken so un-migrated orgs are visible in logs.
- **Edge case:** `orgId` set but the `Organization` record is missing → treat as
  solo / empty (DynamoDB has no referential integrity).
- Continue to normalize the legacy singular `googleAnalyticsPropertyId` /
  `clarityProjectId` into array form for backward compatibility.
- The resolver's output `primaryPropertyId` is taken from the stored
  `primaryAnalyticsPropertyId`; if that is unset (e.g. a migrated config that
  predates the explicit-primary control), it falls back to the first property in
  the list.

### 4.4 Migration marker — "absent" vs "deliberately empty"

The resolver fallback must **not** use truthiness. An owner who deliberately
deletes all GA4 properties produces `googleAnalyticsProperties: []`, which must
*not* trigger the fallback.

Rule: the fallback fires only when `Organization.analyticsConfigSource` is
**absent**. Once the migration script (8.1) or any self-service/admin save
touches the Org record, it sets `analyticsConfigSource` — and the resolver then
trusts the Org record verbatim, including empty arrays.

### 4.5 Direct config-reader audit (required task)

Bug B (7.2) exists because code read `user.googleAnalyticsPropertyId` directly.
Two classes of direct reader must be found and rerouted before implementation is
considered complete:

1. **Singular legacy fields** — `googleAnalyticsPropertyId`, `clarityProjectId`.
2. **Array config fields** — `googleAnalyticsProperties`, `clarityProjects`,
   `seoDomains`, `gaFilteredDomains`, `productDomain` read directly off the
   *user* object. Once config moves to the Org record, a direct
   `user.clarityProjects` read returns empty for an org member — e.g.
   `getClarityProjects(user)` in `seoService.ts`.

Grep every reader of both classes across the backend and both portals and route
each through `resolveAnalyticsConfig()` / `effectiveAnalyticsConfig`. This
prevents the Bug B class from recurring.

## 5. Backend API

### 5.1 New self-service endpoints (`backend/src/routes/seo.ts`)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/seo/config` | Returns the caller's editable config + `canEdit`, `scope` (`"org"`/`"self"`), and the service-account email. |
| `PUT /api/seo/config/ga` | Save `googleAnalyticsProperties`, `primaryAnalyticsPropertyId`, `gaFilteredDomains`, `productDomain`. |
| `PUT /api/seo/config/seo-domains` | Save `seoDomains`. |
| `PUT /api/seo/config/clarity` | Save `clarityProjects`. |
| `POST /api/seo/config/ga/test` | Probe one GA4 property — minimal `runReport` — returns `{ ok }` or `{ ok: false, reason: "permission_denied" \| "not_found" \| "invalid" }`. Requires `canEdit`; basic rate-limit. |

`GET /api/seo/service-account-email` already exists (`seo.ts:853`) and is reused
for the helper text — no new work.

### 5.2 Target resolution

A helper `resolveConfigTarget(user)` returns `{ kind: "org" | "user", id, canEdit }`:

- Org user → target = `Organization` record; `canEdit = isEditorOrAdmin(user, org, "analytics")` (owner or analytics editor).
- Solo user → target = own user record; `canEdit = true`.

All `PUT`/`POST` config endpoints write to that target and return **403** when
`!canEdit`. Every write uses DynamoDB **attribute-level `SET`** (only the fields
that section owns) so the three section saves never clobber each other.
Within a single card, concurrent edits are last-write-wins — an accepted,
conscious trade-off for a low-frequency config page.

Every write also sets `analyticsConfigSource` (4.4).

`GET /api/seo/config` is readable by any authenticated user — a member receives
`canEdit: false` with a read-only copy of the resolved config. The customer
portal simply never surfaces the tab to members (§6.1); the flag is the
authoritative gate.

### 5.3 Shared validation

Extract the existing validation in `PUT /api/admin/users/:id/seo-aeo`
(`admin.ts:1160-1398`) into a shared module `validateAnalyticsConfig` — GA ID
`^\d+$`, Clarity ID `^[a-zA-Z0-9_-]{6,32}$`, label ≤100 chars, SEO-domain regex,
duplicate-GA-ID check. It also enforces that `primaryAnalyticsPropertyId`, when
present, is one of the submitted `googleAnalyticsProperties`. The admin route and
the new self-service routes both use it so validation cannot drift.

### 5.4 Org-sharing wiring

`backend/src/routes/orgShareSettings.ts`: extend `validateSettings()` to accept
the `analytics` feature (it iterates `TOGGLEABLE_FEATURES`, so adding
`"analytics"` there does most of the work). The `analytics.enabled` toggle and
`analytics.editors` list are **owner-only** — a non-owner analytics editor
attempting to change them is rejected.

### 5.5 Admin routes — updated, kept working

- **New `GET /api/admin/users/:id/seo-aeo`** — resolves the target user's config
  (Org record if they are in an org, else their user record) and returns it.
  The Partner Portal dialog calls this on open.
- `PUT /api/admin/users/:id/seo-aeo` — writes to the same resolved target (Org
  record for org users), via `resolveConfigTarget(targetUser)`.
- `PATCH /api/admin/orgs/:orgId/analytics-sharing` — writes
  `shareSettings.analytics.enabled`.
- `GET /api/admin/users` — its `orgShareAnalyticsWithOrg` field reads the new
  location.

### 5.6 `/api/auth/me`

Add `canEditAnalyticsConfig: boolean` to the `/api/auth/me` response
(`backend/src/controllers/auth.ts`). The resolver context already knows org +
role, so this is cheap. The customer portal uses it to show/hide the new tab.

### 5.7 Delegation

Delegation is handled implicitly: under a delegated session `req.user` is the
target customer, so `resolveConfigTarget(req.user)` resolves the customer's
org/config correctly. A delegation test is required (Section 9).

## 6. Frontend

### 6.1 Customer Portal — new "Analytics & SEO" tab

Built as small, focused components under
`customer-portal/src/components/settings/`:

- **`AnalyticsSeoTab.tsx`** (container) — on mount calls `GET /api/seo/config`,
  holds config + `canEdit`, renders the three section cards.
- **`GaPropertiesCard.tsx`** — list of `{ label, propertyId }` rows; an explicit
  **"Primary" radio** selects one row; per-row **Test** button →
  `POST /api/seo/config/ga/test` showing ✓ Connected / ✗ Permission denied;
  service-account email helper text; filtered-domains and product-domain inputs;
  own Save → `PUT /api/seo/config/ga`.
- **`SeoDomainsCard.tsx`** — domain rows; Save → `PUT /api/seo/config/seo-domains`.
- **`ClarityProjectsCard.tsx`** — `{ label, projectId }` rows with a "View
  dashboard ↗" link; Save → `PUT /api/seo/config/clarity`.

Wiring in `customer-portal/src/pages/Settings.tsx`: add `"analytics-seo"` to
`VALID_TABS` (line 87) and add a `TabsTrigger` + `TabsContent`. The trigger
renders **only when `canEditAnalyticsConfig` is true** — members never see the
tab. Add `canEditAnalyticsConfig` to the customer-portal `AuthContext` type
(`AuthContext.tsx`), alongside `effectiveAnalyticsConfig`.

### 6.2 Customer Portal — Organization Sharing tab

The `analytics` row appears automatically once `"analytics"` is in
`TOGGLEABLE_FEATURES`, since the tab renders the feature list generically. Add
an "Analytics" display label if that tab uses a label map.

### 6.3 Customer Portal — `/seo` dashboard

Apply the Bug B and Bug D fixes in `customer-portal/src/pages/SEO.tsx`
(Section 7).

### 6.4 Partner Portal — "Configure SEO/AEO" dialog

In `partner-portal/src/pages/AdminDashboard.tsx`:
- On dialog open, call the new `GET /api/admin/users/:id/seo-aeo` and bind **all**
  fields from the response (GA properties, Clarity projects, SEO domains,
  filtered domains, product domain) — this is the Bug A fix.
- Add the missing `googleAnalyticsProperties` / `clarityProjects` fields to the
  partner-portal `User` interface (lines 220-290).
- Show a note when the user is in an org: *"This is the organization-wide
  analytics config — shared by all members."*

## 7. Bug Fixes

### 7.1 Bug A — Partner Portal dialog shows empty GA4/Clarity lists
**Cause:** the dialog's open handler (`AdminDashboard.tsx:4410`) never calls
`setGoogleAnalyticsProperties()` / `setClarityProjects()`.
**Fix:** the dialog loads from `GET /api/admin/users/:id/seo-aeo` on open and
binds all fields (Section 6.4). Supersedes the original 2-line patch and handles
the Org-record relocation.

### 7.2 Bug B — `/seo` "User Journey Funnel" section gated on the wrong field
**Cause:** `SEO.tsx:2052` checks `user?.googleAnalyticsPropertyId` — a root-level
singular field only present on the owner's record, so members never see the
section.
**Fix:** gate on `effectiveAnalyticsConfig` (`eac?.primaryPropertyId` /
`eac.properties.length > 0`).

### 7.3 Bug C — Shared-funnel metrics return `PERMISSION_DENIED`
**Re-framed for the new model.** Commit `0ab05b44` ("resolve shared-funnel
metrics under the funnel owner") was built for the old per-user-config world.
Funnel sharing is **intra-org only** (via `OrgShareSettings.funnels`), so a
funnel's owner and any viewer are always in the same org and resolve to the
**same** org GA property. The per-funnel-owner resolution is therefore
redundant.
**Fix:** `seo.ts` funnel-metrics (around `seo.ts:744`) resolves the org config
**once** and uses its `primaryPropertyId`; remove the now-redundant funnel-owner
resolution added in `0ab05b44`. Implementation must confirm funnel sharing is
intra-org only before removing it. The remaining `PERMISSION_DENIED` cause is
purely operational (service account not granted on the property) — surfaced to
users by the Test-connection control.

### 7.4 Bug D — "SEO/AEO Not Configured" screen wrongly shown to members
**Cause:** members received an empty `effectiveAnalyticsConfig`, so
`SEO.tsx:316` `isSeoConfigured` was false. `isSeoConfigured` already references
`eac` in current HEAD.
**Fix:** mostly resolved by the Section 4.3 resolver rewrite — once members get a
correctly-populated `effectiveAnalyticsConfig` from the Org record, the screen no
longer wrongly appears. Additionally, ensure the dashboard's default
domain/property selection falls back to `effectiveAnalyticsConfig` so members
land on a working `/seo` without the manual `?domain=` workaround. Verify against
HEAD and add a regression test.

## 8. Migration

### 8.1 One-time batch script
A script in `backend/src/scripts/` (run via `npx ts-node`, like
`create-tables.ts`):
- For each `Organization` (owner identified by `Organization.ownerUserId`): copy
  the owner's user-record analytics fields onto the `Organization` record **only
  where the Org field is absent**, and set `analyticsConfigSource = "migrated"`.
- **Sharing settings — also "only if absent".** Seed `shareSettings.analytics`
  only when it does not already exist: `enabled` from the legacy
  `shareAnalyticsWithOrg`, `editors` to `[]`. If `shareSettings.analytics`
  already exists (e.g. an admin toggled sharing between deploy and migration),
  leave it untouched — never clobber it with the stale legacy boolean.
- **Idempotent** — safe to re-run; never overwrites an already-set Org field.
- **Dry-run mode** — prints intended changes without writing.
- **Per-org logging** and resumability — scans paginate; a re-run after
  interruption completes the rest.

### 8.2 Safety
The migration is **non-destructive** — owner user records keep their copy. The
resolver fallback (4.3) covers the window before the script runs, so deploy and
migration are safe under any interleaving.

## 9. Testing

Per `CLAUDE.md` Rule 2, backend logic is TDD — tests written and failing before
implementation. CI requires **≥95%** coverage on statements, branches,
functions, and lines.

### Backend
- **`resolveAnalyticsConfig()` matrix** — solo / owner / editor / member ×
  `analytics.enabled` on/off × Org-record migrated/un-migrated. Asserts `source`,
  member gating, the absent-vs-empty fallback, and the missing-Org-record edge.
- **Resolver consumers regression** — enumerate and regression-test every caller
  (`/api/seo/metrics`, `/api/seo/product-metrics`, `/api/auth/me`, emma tools,
  `chatbotService`, `seoAgentModeTools`).
- **`validateAnalyticsConfig`** — invalid GA/Clarity IDs, oversize labels, bad
  domains, duplicate GA, primary-not-in-properties, happy path.
- **New endpoints** — `GET /api/seo/config` per caller type; the three `PUT`s
  (403 when `!canEdit`, attribute-level writes, `analyticsConfigSource` set);
  `POST /api/seo/config/ga/test` (ok / permission_denied / not_found, 403 when
  `!canEdit`).
- **`GET /api/admin/users/:id/seo-aeo`** — resolves Org vs user record.
- **Org-sharing** — `analytics` feature validation; **owner-only** security test
  (non-owner editor cannot flip `analytics.enabled`).
- **Member removal** clears the departing member from `analytics.editors`
  (hook into the existing member-removal flow — cf. commit `512e6ee7`).
- **Migration script** — idempotency, dry-run, absent-vs-empty handling,
  `shareAnalyticsWithOrg` → `analytics.enabled`, and that it does **not** clobber
  a pre-existing `shareSettings.analytics`.
- **Delegation** — a delegated admin session edits the target customer's org
  config.
- **Bug regression tests** — B, C, D.

### Frontend
- Customer portal (`npm test`): `AnalyticsSeoTab` + the three cards — render,
  save, test-connection states, primary-radio, `canEdit` gating, member does not
  see the tab.
- Partner portal: dialog Bug A — fields bind on open.

## 10. Delivery

### Commit granularity (`CLAUDE.md`)
Separate commits: data model + resolver; migration script; shared validator
extraction; new API endpoints; org-sharing wiring; each bug fix; customer-portal
tab; partner-portal dialog fix; tests; release notes.

### Deploy ordering
1. **Backend** — data model, resolver + fallback, new endpoints,
   `canEditAnalyticsConfig` on `/api/auth/me`, admin-route updates → deploy.
   (Bug C ships here.)
2. **Run the migration script.**
3. **Partner Portal** — dialog fix → deploy. (Bug A ships here.)
4. **Customer Portal** — new tab + `/seo` fixes → deploy. (Bugs B and D ship
   here.)

The resolver fallback makes steps 1–2 safe under any interleaving. A stale
cached `effectiveAnalyticsConfig` in an open client self-heals on the next
`/api/auth/me` fetch — no cache-invalidation work is required.

### Release notes
`backend/src/docs/user-release.ts` and the customer-portal release notes —
self-service analytics configuration and org-wide sharing.

## 11. Key Files

| Area | File |
|------|------|
| User & Organization models, `OrgShareSettings` | `backend/src/services/db.ts` |
| Analytics resolver | `backend/src/services/analyticsConfigResolver.ts` |
| Org-share permissions, `TOGGLEABLE_FEATURES` | `backend/src/services/orgShareService.ts` |
| SEO routes, metrics, funnel metrics | `backend/src/routes/seo.ts` |
| Org-share settings routes | `backend/src/routes/orgShareSettings.ts` |
| Admin routes (seo-aeo, analytics-sharing, user list) | `backend/src/routes/admin.ts` |
| GA client, Clarity helpers | `backend/src/services/seoService.ts` |
| `/api/auth/me` | `backend/src/controllers/auth.ts` |
| Migration script (new) | `backend/src/scripts/` |
| `/seo` dashboard | `customer-portal/src/pages/SEO.tsx` |
| Settings page | `customer-portal/src/pages/Settings.tsx` |
| New settings components (new) | `customer-portal/src/components/settings/` |
| Partner Portal admin dialog | `partner-portal/src/pages/AdminDashboard.tsx` |
