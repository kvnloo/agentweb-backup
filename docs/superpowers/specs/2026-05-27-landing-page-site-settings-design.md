# Landing Page Site Settings — Design

**Date:** 2026-05-27
**Status:** Approved (pending user review of written spec)

## Goal

Move per-page settings that are actually shared across a user's whole landing site (Environment Variables, Google Tag Manager) into a single project-level "Site Settings" panel, add a per-page CRM list picker, and hide the per-page subdomain UI for now (backend kept intact for later).

## Context

A user has exactly one Vercel project + one GitHub repo for landing pages — every page they create is added as a Next.js route inside that same repo (resolved via `findUserSiteRecord()` in `backend/src/services/v0Service.ts:2242`). Today the UI exposes several settings per-page that aren't actually per-page:

- **Env Vars** — endpoint writes to Vercel project env (project-scoped on Vercel's side), but UI is per-page.
- **GTM** — `gtmContainerId` stored per-page, but it commits to the shared repo's root layout; effectively last-write-wins across all pages.
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
│  │  Environment Variables              3 set  ▾    │   │
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
| Env Vars | removed from card | moved to Site Settings |
| GTM | removed from card | moved to Site Settings |
| Custom Domain (main) | project | already in Site Settings |

## Backend

### New endpoints

All under `backend/src/routes/landingPageGeneration.ts` (or a sibling file in the same router) — thin wrappers that resolve `userId → root page` then reuse existing per-page handlers.

| Method + Path | Body | Response |
|---|---|---|
| `GET /api/landing-pages/v0/site` | — | `{ rootPageId, vercelProjectId, githubRepoUrl }` or `404` |
| `GET /api/landing-pages/v0/site/env` | — | `EnvVar[]` (same shape as existing per-page `/env`) |
| `POST /api/landing-pages/v0/site/env` | `{ key, value, target? }` | created/updated env var |
| `DELETE /api/landing-pages/v0/site/env/:envId` | — | `{ ok: true }` |
| `POST /api/landing-pages/v0/site/gtm` | `{ gtmContainerId }` | `{ ok: true }` |
| `PATCH /api/landing-pages/v0/generated/:id/lead-list` | `{ leadListId: string \| null }` | updated page record |

**Resolution helper:** the four `/site/*` handlers call `findUserSiteRecord(userId)`. If `null`, return `404 { error: "No landing site found. Create a page first." }`. Otherwise delegate to the existing per-page handler with `rootPage.id`.

**`PATCH /lead-list` handler:**
1. Load page, verify `page.userId === req.user.userId` (403 otherwise).
2. If `leadListId !== null`, verify the user owns that list (403 otherwise — reuse existing `getLeadList(userId, leadListId)` guard pattern).
3. Update or REMOVE the `leadListId` attribute on the page record in DynamoDB.
4. Return the updated page.

### Unchanged backend

- `findUserSiteRecord()` and the existing per-page `/env`, `/gtm` handlers — no logic changes.
- `/api/domains/project-domain`, `/api/domains/page-subdomain`, `/api/domains/page-subdomain/:id`, `customDomainService.setPageSubdomain`, `customDomainService.removePageSubdomainFromVercel`, `v0Service.updateSubdomainMiddleware` — all kept intact for future re-enable.

## Frontend

### New components (`customer-portal/src/components/landing-pages/`)

| File | Purpose |
|---|---|
| `SiteSettingsPanel.tsx` | Wrapper that renders `ProjectCustomDomainSection` + `SiteEnvVarsSection` + `SiteGtmSection` in a single bordered card. |
| `SiteEnvVarsSection.tsx` | Collapsible row. Loads env vars on expand via `GET /site/env`. Add/edit/remove rows call `POST/DELETE /site/env*`. |
| `SiteGtmSection.tsx` | Shows current GTM container or "Add GTM". Input validates `^GTM-[A-Z0-9]{4,10}$`. Saves via `POST /site/gtm`. |
| `PageLeadListPicker.tsx` | Inline dropdown showing current lead list (or "None"). Options: each lead list + "Detach". On change, calls `PATCH /generated/:id/lead-list`. |

### Modified file

`customer-portal/src/pages/LandingPages.tsx`:

**Replace:**
- `<ProjectCustomDomainSection/>` → `<SiteSettingsPanel/>`
- Read-only lead-list badge area → `<PageLeadListPicker/>`

**Remove:**
- "Custom URL" button + inline `PageCustomUrlSection` render + import.
- "Env Vars" button + env-vars modal + `loadEnvVars` + related state (`envVarsPageId`, `envVarsValues`, `envVarsSaving`).
- GTM badge/button + GTM modal + related state (`gtmPageId`, `gtmInput`, `gtmSaving`).
- `subdomainPrefix` display in deployed-URL rendering.
- `customUrlPageId` state.
- The `subdomainPrefix` field on `GeneratedPage` interface stays (backend still returns it; UI just doesn't render it).

## Data Flow

**Save GTM (site-level):**
```
SiteGtmSection
  → POST /api/landing-pages/v0/site/gtm  { gtmContainerId }
    → resolve userId → findUserSiteRecord → rootPage.id
    → delegate to existing per-page GTM handler with rootPage.id
      → commits updated layout.tsx to GitHub repo
      → Vercel auto-redeploys (~30s)
  ← { ok: true }
```

**Change CRM list on a page:**
```
PageLeadListPicker
  → PATCH /api/landing-pages/v0/generated/:id/lead-list  { leadListId }
    → ownership check (page) + ownership check (list, if not null)
    → DynamoDB update on AW-LandingPages (SET or REMOVE leadListId)
  ← updated page
LandingPages.tsx updates local state via onChange callback
```

## Error Handling

- `404` from `GET /site` when user has no root page yet → Site Settings panel renders the existing "Connect your main domain" empty state (already handled by `ProjectCustomDomainSection`); Env Vars + GTM rows render disabled with helper text "Available after your first page is deployed."
- `403` from `/lead-list` (page or list not owned) → toast: "Couldn't update lead list."
- Validation: GTM container ID matched against `^GTM-[A-Z0-9]{4,10}$` on the client before POST; backend also re-validates.
- Vercel/GitHub failures from the wrapped `/env` and `/gtm` handlers surface unchanged.

## Testing

### Backend (`backend/src/__tests__/`)

`routes.landingPages.site.test.ts` (NEW):
- `GET /site` → returns rootPageId when site exists; 404 when none; 401 unauth.
- `GET /site/env` → delegates with rootPageId; 404 when no site.
- `POST /site/env` → happy path; 400 invalid body; 404 no site.
- `DELETE /site/env/:envId` → happy path; 404 no site.
- `POST /site/gtm` → happy path; 400 invalid container ID; 404 no site.

`routes.landingPages.leadList.test.ts` (NEW):
- PATCH happy path (set list).
- PATCH with `leadListId: null` (detach) → REMOVE expression.
- 403 when page owned by another user.
- 403 when lead list owned by another user.
- 404 when page not found.
- 400 when body missing `leadListId`.

### Frontend (`customer-portal/src/components/landing-pages/__tests__/`)

`SiteEnvVarsSection.test.tsx`:
- Loads vars on expand (mocked axios).
- Add row → POST called with key/value.
- Remove row → DELETE called with envId.
- Error response → toast shown.

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
| `backend/src/routes/landingPageGeneration.ts` (or sibling) | Modify — add `/site` + `/site/env*` + `/site/gtm` + `/generated/:id/lead-list` |
| `backend/src/__tests__/routes.landingPages.site.test.ts` | Create |
| `backend/src/__tests__/routes.landingPages.leadList.test.ts` | Create |
| `customer-portal/src/components/landing-pages/SiteSettingsPanel.tsx` | Create |
| `customer-portal/src/components/landing-pages/SiteEnvVarsSection.tsx` | Create |
| `customer-portal/src/components/landing-pages/SiteGtmSection.tsx` | Create |
| `customer-portal/src/components/landing-pages/PageLeadListPicker.tsx` | Create |
| `customer-portal/src/components/landing-pages/__tests__/SiteEnvVarsSection.test.tsx` | Create |
| `customer-portal/src/components/landing-pages/__tests__/SiteGtmSection.test.tsx` | Create |
| `customer-portal/src/components/landing-pages/__tests__/PageLeadListPicker.test.tsx` | Create |
| `customer-portal/src/pages/LandingPages.tsx` | Modify — swap panel, add picker, remove per-page env/GTM/subdomain UI |

## Deferred / Out of Scope

- Per-page subdomain prefix UI (`pricing.mysite.com`). Backend stays, components (`PageCustomUrlSection`, `PageSubdomainPanel`, `SubdomainChooserModal`) stay on disk, no imports from `LandingPages.tsx` after this work.
- Migration of per-page `/env` and `/gtm` endpoints (they remain functional, just unreferenced by the new UI).
- Removing `subdomainPrefix` from the `GeneratedPage` interface or DB column.
