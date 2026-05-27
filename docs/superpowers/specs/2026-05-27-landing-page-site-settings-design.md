# Landing Page Site Settings — Design

**Date:** 2026-05-27
**Status:** Revised after CTO review (pending user re-review)

## Goal

Move per-page settings that are actually shared across a user's whole landing site (Site Integrations — reCAPTCHA + custom env vars, Google Tag Manager) into a single project-level "Site Settings" panel, add a per-page CRM list picker, and hide the per-page subdomain UI for now (backend kept intact for later).

> **Naming note:** the backend already calls this surface `/integrations` (`{ recaptcha, custom }`), and that's what the existing per-page modal is wired to. The new project-level UI keeps the same data shape and is labeled "Site Integrations" rather than "Env Vars" — matches reality and avoids inventing a parallel endpoint.

## Context

A user has exactly one Vercel project + one GitHub repo for landing pages — every page they create is added as a Next.js route inside that same repo (resolved via `findUserSiteRecord()` in `backend/src/services/v0Service.ts:2242`). Today the UI exposes several settings per-page that aren't actually per-page:

- **Integrations** (`GET/PUT /generated/:id/integrations`, body `{ recaptcha: { siteKey, secretKey }, custom: [{ key, value }] }`) — writes to the Vercel project env (project-scoped on Vercel's side), but UI is per-page.
- **GTM** (`POST /generated/:id/gtm`) — `gtmContainerId` stored per-page, but it commits to the shared repo's root `app/layout.tsx`; effectively last-write-wins across all pages.
- **Custom Domain** — already project-level in `ProjectCustomDomainSection` ✅

The CRM list (`leadListId`) is genuinely per-page (different pages can collect leads into different lists), but the UI to set/change/detach a list on an existing page is missing — only a read-only badge is shown when one exists.

The per-page subdomain feature (`pricing.mysite.com` → `/pricing` via Next.js middleware) was recently built (commits `ade50a0d…babe9b68`, plan `docs/superpowers/plans/2026-05-26-per-page-subdomain-routing.md`) but is being deferred. UI is hidden; backend and routing logic stay in place.

## Non-Goals

- No data migration. Env vars stay on Vercel, GTM stays on the root page record.
- No new `AW-LandingSites` table.
- Per-page subdomain backend code is **not** removed — endpoints, service functions, middleware-update logic all stay.
- No change to page generation, deploy, or domain verification flow.

## Architecture

```
┌─ Landing Pages ────────────────────────────────────────┐
│                                                        │
│  ┌─ Site Settings (project-level, shared) ─────────┐   │
│  │  Custom Domain        mysite.com    ✓ active    │   │
│  │  Site Integrations    reCAPTCHA + 3 vars  ▾     │   │
│  │  Google Tag Manager   GTM-ABC1234   ✎           │   │
│  └─────────────────────────────────────────────────┘   │
│                                                        │
│  ┌─ Page: Pricing ─────────────────────────────────┐   │
│  │  Status: deployed    mysite.com/pricing         │   │
│  │  CRM List: [Newsletter Leads ▾]    View Metrics │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
```

**Per-page card actions:**

| Action | Scope | Surface |
|---|---|---|
| CRM list picker | per-page | **new** inline dropdown |
| View Metrics | per-page | unchanged |
| Subdomain / Custom URL | hidden | (deferred — backend stays) |
| Integrations (reCAPTCHA + custom env) | removed from card | moved to Site Settings |
| GTM | removed from card | moved to Site Settings |
| Custom Domain (main) | project | already in Site Settings |

## Backend

### New endpoints

All under `backend/src/routes/landingPageGeneration.ts` — thin wrappers that resolve `callerUserId → root page (own-or-org)` then reuse existing per-page handlers.

| Method + Path | Body | Response |
|---|---|---|
| `GET /api/landing-pages/v0/site` | — | `{ rootPageId, vercelProjectId, githubRepoUrl, deployStatus }` or `404` |
| `GET /api/landing-pages/v0/site/integrations` | — | `{ recaptcha: { siteKey, secretKey }, custom: [{ key, value }] }` |
| `PUT /api/landing-pages/v0/site/integrations` | `{ recaptcha, custom }` (same shape) | updated payload |
| `POST /api/landing-pages/v0/site/gtm` | `{ gtmContainerId }` | `{ ok: true, gtmContainerId }` |
| `PATCH /api/landing-pages/v0/generated/:id/lead-list` | `{ leadListId: string \| null }` | updated page record |

### Site resolution (org-aware)

`findUserSiteRecord(userId)` only finds sites owned by `userId` — that breaks org-shared scenarios where an org member is editing their teammate's landing site. Add a new helper:

```typescript
// backend/src/services/v0Service.ts
export async function resolveSiteForCaller(
  callerUserId: string
): Promise<GeneratedLandingPage | null> {
  // 1. Try caller's own site first.
  const own = await findUserSiteRecord(callerUserId);
  if (own) return own;

  // 2. Org fallback: if the caller belongs to an org, find any org-member's
  //    root site that the caller is allowed to edit per existing
  //    canEditItem(...) rules. Returns the first match (in practice there's
  //    one site per org because each user has one Vercel project, but
  //    multi-member orgs may have several until consolidation lands).
  const user = await userDb.getUserById(callerUserId);
  if (!user?.orgId) return null;

  const members = await orgDb.getOrgMembers(user.orgId);
  for (const m of members) {
    if (m.userId === callerUserId) continue;
    const site = await findUserSiteRecord(m.userId);
    if (!site) continue;
    const allowed = canEditItem(
      { userId: site.userId },
      { userId: callerUserId, orgId: user.orgId, orgRole: user.orgRole as any },
      await orgDb.getOrgById(user.orgId),
      user.orgId,
      "landingPages"
    );
    if (allowed) return site;
  }
  return null;
}
```

The four `/site/*` handlers call `resolveSiteForCaller(userId)`. If `null`, return `404 { error: "No landing site found. Create a page first." }`. Otherwise delegate to the existing per-page handler with `rootPage.id` (which itself runs `authorizeLandingPageAccess` — the auth check passes for org members because the existing helper already handles org sharing).

### `GET /site` response includes deployStatus

```typescript
{
  rootPageId: string;
  vercelProjectId?: string;
  githubRepoUrl?: string;
  deployStatus: "no_site" | "deploying" | "ready" | "failed";
}
```

- `no_site` (404) — no root page exists; show empty state inviting the user to create their first page.
- `deploying` — root page exists but `vercelProjectId` or `githubRepoUrl` missing → disable Integrations + GTM rows with helper text "Your first deployment is still in progress."
- `ready` — both IDs present; enable everything.
- `failed` — first deploy failed → show retry hint.

### GitHub 409 retry on GTM handler

The existing `POST /generated/:id/gtm` does `GET app/layout.tsx → modify → PUT with file SHA`. Two near-simultaneous calls (more likely now that GTM is always visible in Site Settings, or with two tabs open) will lose the race and get `409 Conflict`. Add a small retry wrapper inside the existing handler:

```typescript
// in POST /generated/:id/gtm — wrap the GET/PUT cycle
const MAX_ATTEMPTS = 3;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    // existing: GET layout.tsx → derive updatedContent → PUT with fileSha
    break;
  } catch (err: any) {
    if (err.response?.status === 409 && attempt < MAX_ATTEMPTS) {
      continue; // refetch SHA on next iteration
    }
    throw err;
  }
}
```

This is the only logic change to an existing handler.

### `PATCH /lead-list` handler

1. `authorizeLandingPageAccess(pageId, callerUserId, "edit")` — handles own + org-shared pages.
2. If `leadListId !== null`, verify the caller can access that list (call `crmDb.getLeadListById(leadListId)` and check `list.userId === page.userId` OR org-shared). 403 otherwise.
3. DynamoDB: `SET leadListId = :id` (or `REMOVE leadListId` when null) with `ConditionExpression: "userId = :ownerId"` to prevent races.
4. Return the updated page.

### Unchanged backend

- `findUserSiteRecord()` — used by the new `resolveSiteForCaller` and stays as-is.
- Existing per-page `/integrations` and `/gtm` handlers — unchanged except for the GTM 409 retry above.
- `/api/domains/project-domain`, `/api/domains/page-subdomain`, `/api/domains/page-subdomain/:id`, `customDomainService.setPageSubdomain`, `customDomainService.removePageSubdomainFromVercel`, `v0Service.updateSubdomainMiddleware` — all kept intact for future re-enable.

### Approach choice (recorded)

We use **thin wrappers** (`/site/*` → resolve → delegate to `/generated/:rootId/*`) rather than exposing `GET /site { rootPageId }` and letting the frontend call existing per-page endpoints. The wrapper approach:
- Hides the implementation detail "Site Settings = the root page's per-page settings" from the frontend.
- Keeps the org-aware site resolution server-side (frontend never learns whose page is the root).
- Makes future migration to a real `AW-LandingSites` table a backend-only change.

## Frontend

### New components (`customer-portal/src/components/landing-pages/`)

| File | Purpose |
|---|---|
| `SiteSettingsPanel.tsx` | Wrapper that calls `GET /site` once on mount, renders `ProjectCustomDomainSection` + `SiteIntegrationsSection` + `SiteGtmSection` in a single bordered card. Disables Integrations + GTM rows when `deployStatus !== "ready"` with the appropriate helper text. |
| `SiteIntegrationsSection.tsx` | Collapsible row. Loads on expand via `GET /site/integrations`. Single form (reCAPTCHA site/secret + custom key/value rows) saves via `PUT /site/integrations`. Mirrors the existing per-page integrations dialog's form layout — extract the form body into a shared sub-component if practical. |
| `SiteGtmSection.tsx` | Shows current GTM container or "Add GTM". Input validates `^GTM-[A-Z0-9]{4,10}$`. Saves via `POST /site/gtm`. |
| `PageLeadListPicker.tsx` | Inline dropdown showing current lead list (or "None"). Options: each user-accessible lead list + "Detach". On change, calls `PATCH /generated/:id/lead-list`. |

### Modified file

`customer-portal/src/pages/LandingPages.tsx`:

**Replace:**
- `<ProjectCustomDomainSection/>` → `<SiteSettingsPanel/>` (Site Settings panel still contains it internally).
- Read-only lead-list badge area → `<PageLeadListPicker/>` (so users can set/change/detach the list).

**Remove:**
- "Custom URL" button + inline `PageCustomUrlSection` render + import.
- "Env Vars" button + env-vars/integrations dialog + `loadEnvVars` + related state (`envVarsPageId`, `envVarsValues`, `envVarsSaving`, `recaptchaForm`, `customVars`).
- GTM badge/button + GTM modal + related state (`gtmPageId`, `gtmInput`, `gtmSaving`).
- `customUrlPageId` state.
- **Subdomain branch in URL rendering** — the current `page.subdomainPrefix ? '${prefix}.${projectDomain}' : ...` ternary in the deployed-URL display (around line 765) must be removed so the URL is always `mysite.com/<slug>` or the raw `deployedUrl`, regardless of any leftover `subdomainPrefix` in DB. Otherwise pages with a previously-set prefix will still show the subdomain even though the feature is "hidden".

**Kept:**
- `subdomainPrefix` field on the `GeneratedPage` interface (backend still returns it; removing the type field would force changes throughout). UI just stops reading it.

## Data Flow

**Save GTM (site-level):**
```
SiteGtmSection
  → POST /api/landing-pages/v0/site/gtm  { gtmContainerId }
    → resolveSiteForCaller(userId) → rootPage (own or org-shared)
    → delegate to existing per-page GTM handler with rootPage.id
      → GET app/layout.tsx → modify → PUT (with 409 retry, up to 3 attempts)
      → Vercel auto-redeploys (~30s)
  ← { ok: true, gtmContainerId }
```

**Save Integrations (site-level):**
```
SiteIntegrationsSection
  → PUT /api/landing-pages/v0/site/integrations  { recaptcha, custom }
    → resolveSiteForCaller(userId) → rootPage
    → delegate to existing per-page integrations PUT with rootPage.id
      → upserts env vars on the Vercel project
  ← updated { recaptcha, custom }
```

**Change CRM list on a page:**
```
PageLeadListPicker
  → PATCH /api/landing-pages/v0/generated/:id/lead-list  { leadListId }
    → authorizeLandingPageAccess(:id, userId, "edit")  // own or org-shared
    → if leadListId !== null: verify caller can access that list
    → DynamoDB update with ConditionExpression on userId (SET or REMOVE leadListId)
  ← updated page
LandingPages.tsx updates local state via onChange callback
```

## Error Handling

- `GET /site` empty states driven by `deployStatus`:
  - `no_site` → Site Settings panel renders the existing "Connect your main domain" empty state (already handled by `ProjectCustomDomainSection`); Integrations + GTM rows render disabled with helper text "Available after your first page is deployed."
  - `deploying` → rows disabled with "Your first deployment is still in progress." Domain row stays interactive.
  - `failed` → rows disabled with "First deployment failed — fix it before configuring site settings."
  - `ready` → all rows enabled.
- `403` from `/lead-list` (page or list not accessible) → toast: "Couldn't update lead list." Picker reverts to previous selection.
- Validation: GTM container ID matched against `^GTM-[A-Z0-9]{4,10}$` on the client before POST; backend also re-validates.
- GitHub `409 Conflict` from GTM commit → retried up to 3 times server-side (refetch SHA each iteration); user sees nothing unless all 3 fail, in which case the error surfaces as a toast.
- Vercel/GitHub failures from the wrapped `/integrations` and `/gtm` handlers surface unchanged.

## Testing

### Backend (`backend/src/__tests__/`)

`services.resolveSiteForCaller.test.ts` (NEW):
- Returns own site when caller owns one.
- Returns null when caller has no site and no org.
- Returns org-member's site when caller has org-edit access.
- Returns null when caller has org but `canEditItem` denies.
- Skips org-member sites the caller can't edit, returns the next eligible one.

`routes.landingPages.site.test.ts` (NEW):
- `GET /site` → `deployStatus: "ready"` when both IDs present; `"deploying"` when only `vercelProjectId` missing; `"failed"` when root page `status === "failed"`; 404 when no root page.
- `GET /site/integrations` → returns the integrations object; 404 when no site; org-member can read teammate's site.
- `PUT /site/integrations` → happy path; 400 invalid body; 404 no site; org-member can update teammate's site.
- `POST /site/gtm` → happy path; 400 invalid container ID; 404 no site; 409 on first attempt is retried and succeeds; 3rd 409 surfaces as 500.

`routes.landingPages.leadList.test.ts` (NEW):
- PATCH happy path (set list).
- PATCH with `leadListId: null` (detach) → REMOVE expression.
- 403 when caller is not own + not org-edit on the page.
- 403 when lead list not accessible to the page owner.
- 404 when page not found.
- 400 when body missing `leadListId`.
- ConditionExpression failure (concurrent write) → 409 toast-friendly error.

### Frontend (`customer-portal/src/components/landing-pages/__tests__/`)

`SiteSettingsPanel.test.tsx`:
- Renders all three rows when `deployStatus === "ready"`.
- Disables Integrations + GTM rows with helper text when `deployStatus === "deploying"`.
- Shows the "no site" empty state when `GET /site` returns 404.

`SiteIntegrationsSection.test.tsx`:
- Loads `{ recaptcha, custom }` on expand (mocked axios).
- Edit reCAPTCHA siteKey + save → PUT called with full payload.
- Add custom var row + save → PUT includes the new row.
- Server error → toast shown.

`SiteGtmSection.test.tsx`:
- Renders existing `gtmContainerId`.
- Rejects invalid format client-side (no POST fires).
- Valid input → POST called; success state shown.
- Server 500 → toast shown.

`PageLeadListPicker.test.tsx`:
- Renders current selection name.
- Choosing a different list → PATCH called with new `leadListId`.
- Choosing "Detach" → PATCH called with `leadListId: null`.
- Error → toast + selection reverts.

## File Map

| File | Action |
|---|---|
| `backend/src/services/v0Service.ts` | Modify — add exported `resolveSiteForCaller(callerUserId)` |
| `backend/src/routes/landingPageGeneration.ts` | Modify — add `/site`, `/site/integrations` (GET+PUT), `/site/gtm`, `/generated/:id/lead-list`; add 409-retry loop inside existing `/generated/:id/gtm` |
| `backend/src/__tests__/services.resolveSiteForCaller.test.ts` | Create |
| `backend/src/__tests__/routes.landingPages.site.test.ts` | Create |
| `backend/src/__tests__/routes.landingPages.leadList.test.ts` | Create |
| `customer-portal/src/components/landing-pages/SiteSettingsPanel.tsx` | Create |
| `customer-portal/src/components/landing-pages/SiteIntegrationsSection.tsx` | Create |
| `customer-portal/src/components/landing-pages/SiteGtmSection.tsx` | Create |
| `customer-portal/src/components/landing-pages/PageLeadListPicker.tsx` | Create |
| `customer-portal/src/components/landing-pages/__tests__/SiteSettingsPanel.test.tsx` | Create |
| `customer-portal/src/components/landing-pages/__tests__/SiteIntegrationsSection.test.tsx` | Create |
| `customer-portal/src/components/landing-pages/__tests__/SiteGtmSection.test.tsx` | Create |
| `customer-portal/src/components/landing-pages/__tests__/PageLeadListPicker.test.tsx` | Create |
| `customer-portal/src/pages/LandingPages.tsx` | Modify — swap panel, add picker, remove per-page integrations/GTM/Custom-URL UI, **remove the `page.subdomainPrefix ? …` branch from URL rendering** |

## Deferred / Out of Scope

- Per-page subdomain prefix UI (`pricing.mysite.com`). Backend stays, components (`PageCustomUrlSection`, `PageSubdomainPanel`, `SubdomainChooserModal`) stay on disk, no imports from `LandingPages.tsx` after this work.
- Migration of per-page `/env` and `/gtm` endpoints (they remain functional, just unreferenced by the new UI).
- Removing `subdomainPrefix` from the `GeneratedPage` interface or DB column.
