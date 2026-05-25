# Landing Page Custom Domain Configuration — Design (v2)

**Date:** 2026-05-25
**Branch:** `harshit/landing-page-custom-domain-ui`
**Status:** Revised after CTO review — ready for implementation plan

## Changes from v1

After CTO review and code re-verification, the following changes were made:

1. **Architecture pivot — inline panel instead of modal tab.** `LandingPages.tsx:939-949` already has a "Custom Domains — Coming Soon" placeholder inside the Domain Settings panel. The v1 design (add a tab to `SubdomainChooserModal`) would have orphaned that placeholder and split domain management across two surfaces. v2 replaces the placeholder with the real UI; the modal stays a subdomain-only post-deploy flow.
2. **Backend tier gate added.** v1 gated only on the frontend. v2 adds a backend feature check on `POST /api/domains/custom` so the UI can't be bypassed.
3. **Tier gating switched from name comparison to `allowedFeatures`.** v1's `subscriptionType !== "Free" && !== "Basic"` check is inconsistent with the codebase, which uses admin-managed `SubscriptionType.allowedPages` / `allowedSkills` / `allowedConnectedAccounts`. v2 adds an `allowedFeatures: string[]` field with `"custom-domain"` as the flag.
4. **Landing-page ownership reuses `authorizeLandingPageAccess`.** v1 only mentioned a ConditionExpression. v2 uses the existing helper that handles org sharing correctly.
5. **Apex vs subdomain DNS records.** v1 showed only CNAME — broken for apex. v2 detects apex and renders an A record (`76.76.21.21`) instead.
6. **State recovery on panel reopen.** v1 had no rehydration. v2 queries `/api/domains?projectId=` on open and restores any pending verification.
7. **Polling lifetime message corrected.** v1 said "we'll keep checking" — false; polling stopped on close. v2 message is honest: "come back and click Check Again."
8. **`customDomainUrl` precedence documented.** v1 ignored that this field is shared by subdomain and custom domain. v2 documents that custom > subdomain (most recent wins, as today).
9. **Disconnect flow added.** v1 had no removal UX. v2 adds a "Disconnect" button on the verified state.
10. **Test file paths corrected** (`components/landing-pages/__tests__/`, not `pages/__tests__/`).

---

## Goal

Let users attach their own custom domain (e.g., `landing.mycompany.com` or `mycompany.com`) to a deployed landing page, alongside the existing `*.agentwebforms.com` subdomain. The backend service layer (`customDomainService`, `/api/domains/custom`, `/api/domains/:id/verify`) already exists — this design covers the frontend UI, the subscription gate, and small backend additions for ownership/persistence.

## Context

- Subdomain flow is complete end-to-end via `SubdomainChooserModal`.
- Custom-domain backend service exists (`backend/src/services/customDomainService.ts`) but no frontend entry point and no tier gate at the route layer.
- `LandingPages.tsx:939-949` renders a "Custom Domains — Coming Soon" placeholder inside the Domain Settings panel.
- `customDomainUrl` on the landing page record is the canonical "public URL" used in card display, SEO metrics navigation, and v0Service URL composition (`v0Service.ts:520`). It is **not** semantically "custom-domain-only" — it stores whichever domain was most recently configured.

## Out of scope

- Route 53 hosted-zone automation (deferred Phase 2)
- Server-side background verification (currently verification only progresses when the user is in the UI; tracked as a follow-up — see Open Items)
- Cascade-delete of custom domains when a landing page is deleted (separate ticket)
- Renaming `customDomainUrl` to `publicUrl` (broad refactor; separate ticket)

---

## Section 1 — Component Architecture

**Files changed:**
- `customer-portal/src/pages/LandingPages.tsx` — replace the "Coming Soon" card at lines 939–949 with a `<CustomDomainPanel>` component, pass `isPaidForCustomDomain` and the selected page
- `customer-portal/src/components/landing-pages/CustomDomainPanel.tsx` — **new file**, the entire custom-domain UI (input → pending → verified states + disconnect)

```
LandingPages.tsx (Domain Settings panel, when domainPageId is selected)
  ├── Subdomain section          (unchanged — button opens SubdomainChooserModal)
  └── Custom Domains section
       └── <CustomDomainPanel page={selectedPage} isPaidForCustomDomain={...} />
            ├── State 1 — Input (or upgrade prompt if !isPaidForCustomDomain)
            ├── State 2 — Pending verification (DNS records + auto-poll + manual)
            └── State 3 — Verified (URL + disconnect)
```

- **No change** to `SubdomainChooserModal.tsx` — that modal stays subdomain-only
- No new backend routes; small additions to two existing routes (Section 4)

---

## Section 2 — Custom Domain Panel: States & UX Flow

On panel mount, fetch existing custom domain for this Vercel project:

```
GET /api/domains?projectId=<vercelProjectId>
→ filter for type === "custom"
→ if a record exists:
    record.status === "active"   → State 3
    record.status === "pending_verification" → State 2 (rehydrate verificationRecords)
    no record / error            → State 1
```

### State 1 — Input

- Single text input for the domain (e.g., `landing.mycompany.com` or `mycompany.com`)
- "Add Domain" button
- Helper text: "Enter the full domain you want to point at this page"
- If `!isPaidForCustomDomain`: input is replaced with a card — "Custom domains are available on higher-tier plans" + "Upgrade" button → `STRIPE_SIGNUP_URL` (matches the existing `handleUpgrade()` in `LandingPages.tsx`)

### State 2 — Pending verification

- Status badge: "Pending DNS"
- **Two DNS records displayed** (see Section 4 for the apex-vs-subdomain logic):
  - **Apex** (e.g., `mycompany.com`): TXT (from Vercel) + A record → `76.76.21.21`
  - **Subdomain** (e.g., `landing.mycompany.com`): TXT (from Vercel) + CNAME → `cname.vercel-dns.com.`
- Each record rendered as a copy-friendly monospace row: `type | name | value` with a copy-to-clipboard button
- "Check Again" button (manual verify)
- Auto-poll `POST /api/domains/:id/verify` every 10 s while the panel is mounted
- Help text: "DNS changes can take up to 48 hours to propagate. If verification doesn't complete in 30 minutes, close this panel and come back later — click Check Again to retry."

### State 3 — Verified

- Success card: "Your domain is live at `https://landing.mycompany.com`"
- Copy-to-clipboard button for the URL
- "Open" button → opens the URL in a new tab
- "Disconnect" button (with confirm dialog) → `DELETE /api/domains/:id` + clears `customDomainUrl` on the landing page if it matched (see Section 4)
- After verification, refresh the parent `generatedPages` list so the card shows the new URL

**State machine:** `loading → idle → adding → pending_verification → verified | error`

`error` is recoverable: shows inline error message, keeps the input editable, returns to `idle` on next submit.

---

## Section 3 — Subscription Gating

The existing codebase gates by `SubscriptionType.allowedPages` / `allowedSkills` / `allowedConnectedAccounts` (admin-configured in DynamoDB via `subscriptionService.getSubscriptionTypeConfig`). The current `subscriptionType` name comparison pattern is **not** used elsewhere and would create a new convention.

### Backend addition

Add an optional field to `SubscriptionType` in `backend/src/services/subscriptionService.ts`:

```ts
export interface SubscriptionType {
  // ...existing fields
  allowedFeatures?: string[];  // e.g., ["custom-domain"], or ["*"] for all
}
```

New helper:

```ts
export async function userHasFeature(userId: string, feature: string): Promise<boolean> {
  const tierName = await getUserSubscriptionType(userId);
  const tier = await getSubscriptionTypeConfig(tierName);
  if (!tier) return false;
  const f = tier.allowedFeatures || [];
  return f.includes("*") || f.includes(feature);
}
```

Migration: existing tier configs have no `allowedFeatures`. Admin manually adds `"custom-domain"` to the relevant tiers via the subscription_types setting. **Until they do, no users have access** — this is intentional (the feature is off by default until rolled out).

### Auth response

`backend/src/routes/auth.ts` already populates `allowedPages` and `allowedSkills`. Add `allowedFeatures`:

```ts
response.allowedFeatures = (await getSubscriptionTypeConfig(tierName))?.allowedFeatures || [];
```

`customer-portal/src/contexts/AuthContext.tsx` adds `allowedFeatures?: string[]` to the user type.

### Frontend gate helper

In `LandingPages.tsx` (alongside `hasLandingPagesAccess`):

```ts
function hasCustomDomainAccess(user: { isAdmin?: boolean; allowedFeatures?: string[] } | null): boolean {
  if (!user) return false;
  if (user.isAdmin) return true;
  const f = user.allowedFeatures || [];
  return f.includes("*") || f.includes("custom-domain");
}
```

### Backend route gate

`POST /api/domains/custom` calls `userHasFeature(userId, "custom-domain")`; if false, returns `403 { error: "Custom domains require a higher-tier subscription" }`. This is the enforcement layer — the frontend gate is UX only.

---

## Section 4 — Data Flow & API Integration

### How verification works

1. `POST /api/domains/custom` calls Vercel; Vercel returns a `verification` array (typically a TXT record like `_vercel.<domain>` with a `vc-domain-verify=…` value). Stored on `AW-CustomDomains.verificationRecords`.
2. User configures DNS at their registrar:
   - **TXT record** Vercel provided (proves ownership)
   - **CNAME** to `cname.vercel-dns.com.` for subdomains, **OR A record to `76.76.21.21`** for apex domains (Vercel's anycast IP per `docs/custom-domains-setup.md`)
3. `POST /api/domains/:id/verify` calls Vercel's `GET /v9/projects/{id}/domains/{domain}` (live DNS lookup at Vercel). On `verified: true`, backend flips DynamoDB status to `active`, removes `verificationRecords`, and updates the landing page's `customDomainUrl`.

### Apex vs subdomain detection (frontend)

```ts
function isApex(domain: string): boolean {
  // "mycompany.com" → 2 labels = apex
  // "landing.mycompany.com" → 3 labels = subdomain
  // Caveat: doesn't handle ccTLD edge cases like ".co.uk" (treated as apex; fine for v1)
  return domain.split(".").length === 2;
}
```

Documented caveat: domains under multi-label public suffixes (`.co.uk`, `.com.au`) will be classified as apex. The displayed A record still works — Vercel accepts it — so this is conservative-correct, not broken. Track a follow-up for proper PSL-aware detection if needed.

### Add domain flow

```
User submits domain
  → POST /api/domains/custom { vercelProjectId, domain, landingPageId? }
  ← { id, domain, verificationRecords: [{type, name, value}], status: "pending_verification" }
  → store { domainId, verificationRecords } in panel state
  → transition to State 2
```

### Verification flow

```
Auto-poll every 10s (useEffect setInterval, cleared on unmount):
  → POST /api/domains/:id/verify
  ← { verified, status, verificationRecords? }

Manual "Check Again" → same call

On verified === true:
  → backend persists customDomainUrl on the landing page (see below)
  → frontend transitions to State 3
  → refetch generatedPages so the card reflects the new URL
```

### Backend additions to `domains.ts`

1. **`POST /api/domains/custom`** — three additions:
   - **Tier gate:** call `userHasFeature(userId, "custom-domain")` first; 403 if false
   - **Accept `landingPageId`** in body. If present, call `authorizeLandingPageAccess(landingPageId, userId, "edit")` and 403 if it fails (re-uses the helper at `landingPageGeneration.ts:66` that already handles solo + org-sharing cases)
   - Pass `landingPageId` through to `addCustomDomain` to be stored on the `AW-CustomDomains` record (new optional field on `CustomDomainRecord`)

2. **`POST /api/domains/:id/verify`** — when status transitions from `pending_verification` to `active` and the record has a `landingPageId`:
   - Compose `customDomainUrl`: `https://${domain}` for root pages, `https://${domain}/${slug}` for sub-pages (mirror the subdomain endpoint's slug logic in `domains.ts:91-94`)
   - Update the landing page with `ConditionExpression: "userId = :uid"` (defense-in-depth — even though we already authorized at add time, the landing page could have been transferred/deleted in the interim)
   - Failures here are non-fatal: log + return success (the domain is verified at Vercel either way)

### `customDomainUrl` precedence

The field stores whichever domain was most recently configured. If both a subdomain and a custom domain are active for the same landing page:

- Custom domain takes precedence (writes last on verify; subdomain writes immediately at add time so custom domain naturally wins for new pages)
- This matches existing behavior (`v0Service.ts:520`): the field is treated as the canonical public URL, not subdomain-only

Documented behavior: "Connecting a custom domain replaces the subdomain as your page's primary URL. The subdomain remains active but the card displays the custom domain."

### Component props

`CustomDomainPanel` props:

```ts
interface CustomDomainPanelProps {
  page: GeneratedPage;                    // has vercelProjectId, id, slug
  isPaidForCustomDomain: boolean;
  onUpdate: () => void;                   // called after add/verify/disconnect to refetch
}
```

---

## Section 5 — Error Handling

### Add-domain errors (State 1 → failure)

| Error | User-facing message |
|---|---|
| Invalid domain format (400 from backend) | "Please enter a valid domain (e.g., landing.mycompany.com)" — inline below input |
| 403 — feature not on subscription | "Custom domains require a higher-tier plan" + upgrade button — replaces input |
| 403 — landingPageId not owned | "You don't have permission to manage this landing page" — toast (should not happen via UI but defense-in-depth) |
| 409 — domain on another Vercel project | "This domain is already in use. Remove it from its current project first." — inline |
| Network / 5xx | "Failed to add domain. Please try again." — toast, stay in State 1 |

### Verification errors (State 2)

| Scenario | Behavior |
|---|---|
| `verified === false` (still pending) | Stay in State 2; if Vercel returned updated `verificationRecords`, refresh them |
| `verified === false` after 30 min auto-poll | Stop polling. Banner: "Verification is taking longer than expected. Close this panel and click Check Again later — DNS can take up to 48 hours." |
| Network failure during auto-poll | Silently skip; next poll retries |
| Network failure on manual "Check Again" | Toast: "Couldn't reach the server. Try again." |
| 404 — domain not found (deleted from another session) | Reset to State 1, refetch project domains |

### Auto-poll lifecycle

- Starts on entering State 2
- Stops on: verified, modal/panel unmount, **30-minute cap reached** (180 cycles × 10s)
- Cleared via `useEffect` cleanup
- On panel reopen after stop: the fetch in Section 2 rehydrates State 2 from the server; user clicks "Check Again" to resume

### Disconnect (State 3)

- Confirm dialog: "Disconnect `<domain>` from this page?"
- `DELETE /api/domains/:id` → on success, backend should also clear `customDomainUrl` on the landing page IF it matches the deleted domain
  - **Add to backend:** in `domains.ts` DELETE handler, after `removeDomain` succeeds, check if the record had a `landingPageId` and `customDomainUrl` on the landing page starts with `https://<domain>`; if so, clear it (the enrichment in `landingPageGeneration.ts:476` will repopulate from any remaining domain on next list)
- On error: toast, stay in State 3

---

## Section 6 — Testing

### Backend (extend `backend/src/__tests__/routes.domains.test.ts`)

- `POST /api/domains/custom` with valid domain + paid tier → 201 with `verificationRecords`
- `POST /api/domains/custom` with non-paid tier → 403
- `POST /api/domains/custom` with invalid domain format → 400
- `POST /api/domains/custom` with another user's `landingPageId` → 403 (via `authorizeLandingPageAccess`)
- `POST /api/domains/custom` with valid `landingPageId` → stored on `AW-CustomDomains` record
- `POST /api/domains/:id/verify` when Vercel returns `verified: true` + record has `landingPageId` → updates landing page `customDomainUrl` (root)
- `POST /api/domains/:id/verify` when verified + landing page has slug → `customDomainUrl` includes `/{slug}`
- `POST /api/domains/:id/verify` when verified + landing page DB write fails → still returns 200 (non-fatal)
- `POST /api/domains/:id/verify` when still pending → returns `pending_verification` with records
- `DELETE /api/domains/:id` when record has `landingPageId` and `customDomainUrl` matches → clears the field

### Backend (extend `backend/src/__tests__/services.subscriptionService.test.ts` — or new file if absent)

- `userHasFeature` with `allowedFeatures: ["*"]` → true for any feature
- `userHasFeature` with `allowedFeatures: ["custom-domain"]` → true for `"custom-domain"`, false for others
- `userHasFeature` with missing tier config → false
- `userHasFeature` with no `allowedFeatures` field → false (default-deny)

### Frontend (new file `customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx`)

- Renders upgrade card when `isPaidForCustomDomain={false}`
- Renders input form when paid
- Submits valid domain → calls `POST /api/domains/custom`, transitions to State 2
- State 2 renders TXT (from response) + CNAME (subdomain case) records with copy buttons
- State 2 renders TXT + A record `76.76.21.21` (apex case)
- "Check Again" calls `POST /api/domains/:id/verify`
- On `verified: true` → transitions to State 3, calls `onUpdate`
- On panel mount with existing `pending_verification` domain → starts in State 2 with rehydrated records
- On panel mount with existing `active` domain → starts in State 3
- Auto-poll: `vi.useFakeTimers()` — advance 10s, assert verify endpoint called
- Auto-poll stops after 180 cycles (30 min)
- Auto-poll stops on unmount (no React act warnings)
- Disconnect → confirm dialog → DELETE called → returns to State 1

---

## Files touched

| File | Change |
|---|---|
| `customer-portal/src/components/landing-pages/CustomDomainPanel.tsx` | **New** — entire custom-domain UI |
| `customer-portal/src/pages/LandingPages.tsx` | Replace "Coming Soon" card at L939-949; compute `isPaidForCustomDomain`; pass `onUpdate` to refetch |
| `customer-portal/src/contexts/AuthContext.tsx` | Add `allowedFeatures?: string[]` to user type |
| `customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx` | **New** — see Section 6 |
| `backend/src/routes/domains.ts` | Tier gate + `landingPageId` ownership + persist `customDomainUrl` on verify + clear on delete |
| `backend/src/services/customDomainService.ts` | Add `landingPageId?` to `CustomDomainRecord`; accept + store it in `addCustomDomain` |
| `backend/src/services/subscriptionService.ts` | Add `allowedFeatures?: string[]` to `SubscriptionType`; add `userHasFeature(userId, feature)` helper |
| `backend/src/routes/auth.ts` | Include `allowedFeatures` in `/api/auth/me` response |
| `backend/src/__tests__/routes.domains.test.ts` | Tier + ownership + verify + delete test cases |
| `backend/src/__tests__/services.subscriptionService.test.ts` | `userHasFeature` test cases (new file if absent) |

## Open items / deferred

1. **Server-side background verification.** Currently verification only progresses when the user has the panel open. Acceptable for v1 (with the honest "come back later" UX). Follow-up ticket: a cron job over `pending_verification` rows that calls Vercel verify and emits a webhook/notification on success.
2. **Vercel API rate limiting & backoff.** Auto-poll is 10 s × N concurrent users × Vercel quota. Add monitoring of Vercel response codes; if we see throttling, switch to exponential backoff (10s → 30s → 60s).
3. **PSL-aware apex detection.** ".co.uk" / ".com.au" are treated as apex by the 2-label rule. Vercel accepts the A record for these so it's not broken, but using `psl` package would be more correct. Defer.
4. **Cascade delete.** When a landing page is deleted, its custom domain remains in `AW-CustomDomains` and on Vercel. Tracked separately — likely a delete-handler call to `removeDomain` for all domains with that `landingPageId`.
5. **Rename `customDomainUrl` → `publicUrl`.** The field name implies "custom domain only" but it stores both subdomain and custom-domain URLs. Cosmetic; broad refactor; defer.

## Implementation notes

- **Branch:** `harshit/landing-page-custom-domain-ui` (current)
- **Order of work:**
  1. Backend: `subscriptionService.userHasFeature` + tests
  2. Backend: `domains.ts` route additions (gate, ownership, persistence) + tests
  3. Backend: `customDomainService.ts` schema additions + tests
  4. Backend: `auth.ts` response shape
  5. Frontend: `AuthContext` type
  6. Frontend: `CustomDomainPanel` component + tests
  7. Frontend: `LandingPages.tsx` integration
  8. Manual verification on the cloud test environment with a real domain
