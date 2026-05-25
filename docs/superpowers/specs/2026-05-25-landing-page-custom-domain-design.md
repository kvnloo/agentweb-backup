# Landing Page Custom Domain Configuration — Design

**Date:** 2026-05-25
**Branch:** `harshit/landing-page-custom-domain-ui`
**Status:** Approved — ready for implementation plan

## Goal

Let users attach their own custom domain (e.g., `landing.mycompany.com`) to a deployed landing page, alongside the existing `*.agentwebforms.com` subdomain. The backend infrastructure (`customDomainService`, `/api/domains/custom`, `/api/domains/:id/verify`) is already in place — this design is for the frontend UI that exposes it, plus the subscription gate.

## Context

The current implementation supports `agentwebforms.com` subdomains end-to-end via `SubdomainChooserModal`. The custom-domain backend is largely complete (see `backend/src/services/customDomainService.ts`) but has no frontend entry point.

## Out of scope

- Route 53 hosted-zone automation (deferred to Phase 2 per `docs/custom-domains-setup.md`)
- New backend routes (small additions to existing routes only — see Section 4)
- Cascade-delete of custom domains when a landing page is deleted (tracked separately)

---

## Section 1 — Component Architecture

**File changed:** `customer-portal/src/components/landing-pages/SubdomainChooserModal.tsx`

The existing modal gets a `Tabs` wrapper around its content. The current subdomain form becomes the `"subdomain"` tab. A new `"custom"` tab is added alongside it.

```
SubdomainChooserModal
  └── Tabs (defaultValue="subdomain")
       ├── TabsTrigger: "agentwebforms.com"
       └── TabsTrigger: "Custom Domain"
       ├── TabsContent: SubdomainTab     ← existing code, no logic change
       └── TabsContent: CustomDomainTab  ← new, built inline in the same file
```

- No new files
- No call-site changes in `LandingPages.tsx` — the modal's existing props remain unchanged
- One new prop added: `isPaidForCustomDomain: boolean`

---

## Section 2 — Custom Domain Tab: States & UX Flow

The custom domain tab has three sequential states.

### State 1 — Input
- Text input for the domain (e.g., `landing.mycompany.com`)
- "Add Domain" button
- If user is on free/basic: input is disabled, replaced with an upgrade prompt and a button that opens `STRIPE_SIGNUP_URL` (same pattern as `handleUpgrade()` in `LandingPages.tsx`)

### State 2 — Pending verification
- Shows the DNS records the user needs to add at their registrar (see Section 4 for the two-record requirement)
- Each record displayed as a copy-friendly monospace row: `type | name | value`
- Status badge: "Pending DNS"
- Auto-polls `POST /api/domains/:id/verify` every 10s while modal is open
- Manual "Check Again" button
- Note: "DNS changes can take up to 48 hours to propagate"

### State 3 — Verified
- Success state: "Your domain is live at `landing.mycompany.com`"
- Copy-to-clipboard button for the URL
- `onSuccess(newUrl)` callback fires → updates the page card in `LandingPages.tsx` with `customDomainUrl`

**State machine:** `idle → adding → pending_verification → verified | error`

---

## Section 3 — Subscription Gating

The tab is always visible. Content depends on tier.

```ts
isPaidForCustomDomain =
  user?.isAdmin ||
  (user?.subscriptionType &&
   user.subscriptionType !== "Free" &&
   user.subscriptionType !== "Basic")
```

- **Pro and above (or admin):** domain input form renders normally
- **Free / Basic:** input replaced with a card: *"Custom domains are available on the Pro plan"* + "Upgrade" button → `STRIPE_SIGNUP_URL`

`LandingPages.tsx` computes `isPaidForCustomDomain` from the already-available `user` from `useAuth()` and passes it to the modal.

---

## Section 4 — Data Flow & API Integration

No new backend routes. Two existing endpoints are used.

### How verification actually works

1. **Add domain** — `POST /api/domains/custom` calls Vercel; Vercel returns a `verification` array (typically a TXT record like `_vercel.<domain>  TXT  "vc-domain-verify=..."`). These are stored on `AW-CustomDomains.verificationRecords` and returned to the frontend.
2. **User configures DNS** — at their registrar (GoDaddy, Cloudflare, etc.), the user adds:
   - The **TXT record** Vercel provided (proves ownership)
   - A **CNAME record** pointing the domain to `cname.vercel-dns.com.` (routes traffic to Vercel)
3. **Verification poll** — `POST /api/domains/:id/verify` calls Vercel's `GET /v9/projects/{id}/domains/{domain}`. Vercel performs a live DNS lookup. When `verified: true`, the backend sets DynamoDB status to `active` and removes `verificationRecords`.

### UI implication
The frontend must display **both** records — the TXT from Vercel's response AND a statically-rendered CNAME instruction (`CNAME → cname.vercel-dns.com.`). The backend only returns the TXT, but both are required for the domain to work.

### Add domain flow
```
User types domain → clicks "Add Domain"
  → POST /api/domains/custom  { vercelProjectId, domain }
  ← { id, domain, verificationRecords: [{type, name, value}], status: "pending_verification" }
  → Store { domainId, verificationRecords } in tab state
  → Transition to State 2
```

### Verification flow
```
Auto-poll every 10s (useEffect setInterval, cleared on unmount or modal close):
  → POST /api/domains/:id/verify
  ← { verified, status, verificationRecords? }

Manual "Check Again" button → same call

On verified === true:
  → Backend persists customDomainUrl to landing page record (see below)
  → onSuccess("https://<domain>") fires from frontend
  → Transition to State 3
```

### Backend changes needed for persistence

The subdomain endpoint persists `customDomainUrl` directly on the landing page when called with a `landingPageId` body param (see `backend/src/routes/domains.ts`). For custom domains, persistence happens on verification success — the URL isn't usable until DNS resolves. Two small backend additions:

1. **`POST /api/domains/custom`** — accept optional `landingPageId` in body, store it on the `AW-CustomDomains` record (new field) for use during verification
2. **`POST /api/domains/:id/verify`** — when the status transitions to `active` and the domain record has a `landingPageId`, update the landing page's `customDomainUrl` field to `https://<domain>`

### Props added to `SubdomainChooserModal`
```ts
isPaidForCustomDomain: boolean
// existing props unchanged: open, onOpenChange, vercelProjectId, pageName,
//   deployedUrl, landingPageId, onSuccess
```

`onSuccess(newUrl: string)` already exists and handles URL updates — same callback works for both subdomain and custom domain success.

---

## Section 5 — Error Handling

### Add-domain errors (State 1 → failure)

| Error | User-facing message |
|---|---|
| Invalid domain format | "Please enter a valid domain (e.g., landing.mycompany.com)" — inline |
| Domain already on another Vercel project | "This domain is already in use. Remove it from your other project first." |
| Network / 5xx from Vercel | "Failed to add domain. Please try again." — toast |

### Verification errors (State 2)

| Scenario | Behavior |
|---|---|
| `verifyDomain` returns `pending_verification` | Stay in pending state, update records if Vercel returned new ones |
| `verifyDomain` returns `error` status | Inline error: "DNS verification failed. Double-check your records." Keep "Check Again" available |
| Network failure during auto-poll | Silently skip that poll cycle; next poll retries |
| Network failure on manual "Check Again" | Toast: "Couldn't reach the server. Try again." |

### Auto-poll lifecycle
- Starts when entering State 2
- Stops when: domain verified, modal closed, or component unmounts (`useEffect` cleanup clears the interval)
- **Max poll duration:** 30 minutes (180 cycles at 10s). After that, stop polling and show: "Verification is taking longer than expected. We'll keep checking — you can close this and come back."

---

## Section 6 — Testing

### Backend (extend `backend/src/__tests__/routes.domains.test.ts`)
- `POST /api/domains/custom` with valid domain → returns `verificationRecords`
- `POST /api/domains/custom` with invalid format → 400
- `POST /api/domains/custom` with `landingPageId` → stores landingPageId on the domain record
- `POST /api/domains/:id/verify` when Vercel returns `verified: true` → updates DynamoDB to `active`, removes `verificationRecords`
- `POST /api/domains/:id/verify` when verified AND domain has `landingPageId` → updates landing page `customDomainUrl`
- `POST /api/domains/:id/verify` when still pending → returns `pending_verification` with records

### Frontend (new file `customer-portal/src/pages/__tests__/SubdomainChooserModal.customDomain.test.tsx`)
- Custom Domain tab renders for paid users
- Custom Domain tab renders upgrade prompt for Free/Basic users
- Submit valid domain → calls `POST /api/domains/custom`, transitions to pending state
- Pending state shows both TXT (from response) and CNAME (static) records with copy buttons
- "Check Again" button calls `POST /api/domains/:id/verify`
- On `verified: true` response → calls `onSuccess` with the new URL
- Auto-poll: `vi.useFakeTimers()` — advance 10s, assert verify endpoint called
- Poll stops on modal close (no state update after unmount, no React act warnings)

No new backend routes — all endpoints already exist.

---

## Files touched

| File | Change |
|---|---|
| `customer-portal/src/components/landing-pages/SubdomainChooserModal.tsx` | Wrap content in `Tabs`, add `CustomDomainTab` inline, add `isPaidForCustomDomain` prop |
| `customer-portal/src/pages/LandingPages.tsx` | Compute `isPaidForCustomDomain` from `user`, pass to modal |
| `customer-portal/src/pages/__tests__/SubdomainChooserModal.customDomain.test.tsx` | New test file |
| `backend/src/routes/domains.ts` | Accept `landingPageId` on `POST /custom`; persist `customDomainUrl` to landing page on verify success |
| `backend/src/services/customDomainService.ts` | Store `landingPageId` on `AW-CustomDomains` record; update landing page on verify transition to `active` |
| `backend/src/__tests__/routes.domains.test.ts` | Add custom-domain + verify test cases |

## Open items
- Confirm `subscriptionType` values are exactly `"Free"`, `"Basic"`, `"Pro"` (verify against `Pricing.tsx` `TIER_PLAN_MAP` during implementation)
