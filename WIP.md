# WIP: Local Agent as Proxy for Restricted Platforms

**Date:** 2026-04-28  
**Branch:** `rui/investigate-local-agent-proxy`  
**Status:** Investigation complete. Implementation deferred to future sprint.

---

## Problem Statement

AgentWeb has no integration with WhatsApp, WeChat, X.com, Reddit, and similar platforms
that block cloud-based browser automation. These platforms either have no open API, require
a persistent logged-in desktop/mobile session, or aggressively detect headless browsers.

The idea: run a **local agent on a shared EC2 instance** that holds persistent sessions for
these platforms, and route tasks to it from the AgentWeb backend.

---

## Tools Researched

### OpenClaw
- A **personal AI agent** running locally on the host machine (went viral early 2026)
- Creator: Peter Steinberger — formerly known as "Moltbot" / "Clawdbot"
- GitHub: `github.com/openclaw/openclaw`
- Executes tools locally (terminal, browser, GitHub), extensible via community "Skills"
- Memory stored as JSONL + markdown files; uses ChatGPT subscription or LLM APIs
- **Not suitable** for our use case — personal productivity agent, not a messaging gateway

### Hermes Agent (NousResearch)
- Open-source, self-improving agent from Nous Research
- GitHub: `github.com/NousResearch/hermes-agent` | Docs: `hermes-agent.nousresearch.com`
- Has an explicit **gateway mode** (`hermes gateway setup` + `hermes gateway start`) designed
  to receive messages from external platforms and route them to the agent runtime
- Supports local Chrome via CDP for browser automation; smart model routing via `SOUL.md`
- **VPS deployment is the recommended production setup** — aligns with running on EC2
- **Open question:** which messaging platforms (WhatsApp, WeChat) are natively supported
  vs. requiring custom connectors — needs verification against Hermes docs/issues

---

## Proposed Architecture

```
AgentWeb Backend
      │
      │  POST /api/local-proxy/tasks
      │  { type: "whatsapp_scan", platform: "whatsapp", config: { ... } }
      ▼
Hermes Agent (shared EC2 instance, gateway mode)
      │
      │  hermes gateway → WhatsApp Web (browser via CDP)
      │  — reads group message history
      │  — identifies unanswered questions (LLM classification)
      ▼
Result POSTed back to AgentWeb webhook
      │
      ▼
Admin UI (partner-portal): table of groups × unanswered questions
```

### Key Design Decisions
- **Shared instance, not per-user:** one EC2 running Hermes serves all customers. Sessions
  belong to the admin's accounts, not individual users.
- **Task routing via `agentType` field:** add `agentType: "local-proxy"` to
  `AW-TaskExecutions`. Backend dispatcher checks this field; if set, pushes to local proxy
  instead of the existing browser-use agent engine.
- **Async result delivery:** local proxy POSTs results back to a webhook on the backend
  (no polling needed from the backend side).

---

## First Feature Scoped: WhatsApp Group Unanswered Question Scanner (Admin Tool)

**Goal:** Admin can trigger a scan of all WhatsApp groups, get back a list of groups with
pending unanswered questions — useful for support/community management.

### Components to Build

| Component | Location | Description |
|-----------|----------|-------------|
| Hermes gateway setup | EC2 (manual) | Install Hermes, log into WhatsApp Web once, persist session |
| `agentType` field | `AW-TaskExecutions` DynamoDB schema | Route flag for local-proxy vs browser-use |
| Local proxy route | `backend/src/routes/localProxy.ts` | New route: dispatch tasks to Hermes, receive webhook results |
| Task dispatcher update | `backend/src/services/agentModeService.ts` | Check `agentType` field, push to Hermes if `local-proxy` |
| Admin UI page | `partner-portal/src/` | Dashboard: groups × unanswered question counts + timestamps |

### Pre-Implementation Verification Needed
1. Confirm Hermes gateway supports WhatsApp natively (vs custom connector required)
2. Test Hermes gateway mode on EC2 with a WhatsApp Web session
3. Decide on webhook auth scheme (shared secret vs JWT) for result delivery back to backend

---

## Existing Agent Engine Context

The current agent engine (`agent-engine/task_monitor.py`) uses a **polling model**:
- Polls `AW-TaskExecutions` via `StatusStartTimeIndex` GSI every 5 seconds
- No `agentType` field exists today — all tasks go to `web_agent.py` (browser-use)
- Max 3 concurrent tasks per `MAX_CONCURRENT_TASKS` env var
- Only messaging integrations today: Slack (approval requests) + Email (notifications)

Adding `agentType: "local-proxy"` is a minimal, non-breaking change — `task_monitor.py`
can skip tasks with this field, and a new `local_proxy_agent.py` (or Hermes) handles them.

---

## Files to Create/Modify (when implementing)

- `backend/src/routes/localProxy.ts` — new
- `backend/src/services/localProxyService.ts` — new
- `backend/src/app.ts` — register new route
- `backend/src/__tests__/localProxy.test.ts` — new
- `partner-portal/src/pages/admin/WhatsAppScanner.tsx` — new
- DynamoDB: add `agentType` to `AW-TaskExecutions` (no migration needed — optional field)

---

# WIP: Landing Page Create Button vs. Generate Tool — Template Alignment

**Date:** 2026-04-30  
**Branch:** `rui/check-landing-page-button-vs-generate`  
**Status:** Investigation complete. Implementation deferred — the saved HTML templates feature (stored in `/api/html-templates`) is not widely used yet.

---

## Problem Statement

The "Create Landing Page" button in the Landing Pages UI and the `generate_landing_page` Emma agent tool both call `POST /api/landing-pages/v0/generate`, but they build the request differently. We investigated whether this causes bugs.

---

## Findings

### Bug Found: Template selection silently ignored in the UI

When a user picks a saved template in the Create Landing Page dialog, the selection is silently dropped:

- **UI sends:** `{ template_name: "event-marketing", ... }` — a display name string
- **Backend reads:** `template_id` (UUID) — looks it up in DynamoDB; `template_name` is never destructured
- **Agent tool sends:** `{ template_id: "...", ... }` — correct

**Result:** Template cards in the UI dialog are non-functional. The backend ignores `template_name` and generates without the template.

**Fix is one line** in `customer-portal/src/pages/LandingPages.tsx` (`handleGenerate`):
```diff
- body.template_name = selectedTemplate;   // stores display name, backend ignores it
+ body.template_id = selectedTemplate;     // store template_id instead, requires selector to use template_id too
```
And update the card selector to store `tpl.template_id ?? tpl.template_name` instead of `tpl.template_name`.

### Why deferred

The Create Landing Page dialog has three options: (1) General Purpose (no template), (2) a saved HTML template from the Templates section (`/api/html-templates?type=landing_page`), and (3) Upload HTML file. The bug only affects option 2 — the saved templates path. The "Upload HTML" option sends `template_html` directly and works fine; this is a completely separate code path and is not affected.

The saved HTML templates feature (`/api/html-templates`) is not yet widely used. Until users are actively creating and reusing landing page templates, this bug has minimal real impact. Deferring until the HTML templates feature matures.

When ready to fix, the change is small and isolated.

### Other differences (by design, not bugs)

| Aspect | UI Button | Agent Tool |
|--------|-----------|------------|
| `lead_list_id` | Never passed — no CRM lead list wired up | Pre-creates a lead list and passes its ID |
| `template_html` (upload) | Supports uploading raw HTML | Not exposed |
| Brand guidelines | Auto-injected by backend from user account | Same |

The `lead_list_id` gap means landing pages created via the UI button have no contact form lead capture configured. This is also deferred — addressable when the UI dialog is upgraded to include a lead list selector step.

---

# WIP: Churn Offer — Intercept Cancellation with a Retention Offer

**Date:** 2026-05-11  
**Branch:** `rui/churn-offer`  
**Status:** Design complete. Implementation not started.

---

## Problem Statement

When a user clicks "Downgrade to Free" on the Pricing page, the app immediately fires
`POST /api/stripe/cancel-subscription` with no retention attempt. There is no pause,
no discount offer, and no exit survey — every cancellation is a hard loss.

Goal: intercept the cancel click, present a compelling offer, and recover a meaningful
percentage of users who would otherwise churn.

---

## Current Cancellation Flow

1. User clicks "Downgrade to Free" on `customer-portal/src/pages/Pricing.tsx`
2. `handleUpgrade()` (line ~151) POSTs directly to `POST /api/stripe/cancel-subscription`
3. Backend sets `cancel_at_period_end: true` on the Stripe subscription
4. User sees "Canceling" badge in `SubscriptionCard`; access continues until period end
5. On `customer.subscription.deleted` webhook, user is downgraded to Free in DynamoDB

There is also a **Stripe Customer Portal path** (`POST /api/stripe/create-customer-portal-session`)
that lets users cancel natively in Stripe's UI — this path is not intercepted by our frontend.

---

## Chosen Approach: Option B — Tiered Offers with Pause

Show a modal before the cancel fires with 2–3 options depending on the user's plan:

| Option | Starter ($199) | Pro ($499) |
|--------|---------------|------------|
| Pause | Pause for 1 month (no charge) | Pause for 1 month |
| Discount | 30% off for 3 months (~$139/mo) | 30% off for 3 months (~$349/mo) |
| Downgrade | — | Downgrade to Starter + 50% off first month ($99) |

All options are reversible. If the user declines all offers, cancellation proceeds normally.

**Why not Option A (single fixed discount):** wastes discount budget on users who might stay
anyway; no pause option misses users who are temporarily inactive.

**Why not Option C (exit survey first):** more friction upfront; can be added as iteration.

---

## Architecture

### Frontend

**New component:** `customer-portal/src/components/settings/ChurnOfferModal.tsx`
- Modeled after `WelcomeOfferModal.tsx` (same pattern, different offers)
- Opens when user selects Free plan in `Pricing.tsx` instead of firing cancel immediately
- Three-step state machine: `presenting → offer_accepted | offer_rejected → canceling`
- Offer buttons call their respective backend endpoints; "No thanks, cancel anyway" proceeds
  with the original `POST /api/stripe/cancel-subscription`

**Modify:** `customer-portal/src/pages/Pricing.tsx` — `handleUpgrade()` (lines ~151–161)
- Check if current plan is paid and new plan is Free; if so, open `ChurnOfferModal` instead
  of calling the cancel endpoint directly

### Backend

**New endpoints** in `backend/src/routes/stripe.ts`:

| Endpoint | Description |
|----------|-------------|
| `GET /api/stripe/churn-offer` | Returns eligible offers for the current user based on their tier |
| `POST /api/stripe/churn-offer/accept-discount` | Applies a coupon to the running subscription |
| `POST /api/stripe/churn-offer/accept-pause` | Calls `stripe.subscriptions.update({ pause_collection: { behavior: "void" } })` |
| `POST /api/stripe/churn-offer/accept-downgrade` | Creates a `subscription_schedule` for end-of-period downgrade + applies coupon |

**New service:** `backend/src/services/churnOfferService.ts`
- Determine eligible offers from user's tier and tenure
- Create single-use Stripe coupons per user (or reuse pre-created env-var coupons)
- Log offer events to DynamoDB for analytics

**Env vars needed:**
- `STRIPE_CHURN_DISCOUNT_COUPON_ID` — 30% off, 3-month repeating coupon
- `STRIPE_CHURN_DOWNGRADE_COUPON_ID` — 50% off, 1-month coupon for downgrade path

### Data Model

Store churn offer events in DynamoDB (append-only, same pattern as `paymentHistoryDb.ts`):

```
AW-ChurnOffers
  userId (PK) + createdAt (SK)
  offerId
  tier          ("starter" | "pro")
  offerType     ("discount" | "pause" | "downgrade")
  status        ("presented" | "accepted" | "rejected" | "expired")
  expiresAt
```

---

## What Is NOT in Scope

- Exit survey / reason collection (future iteration)
- Admin dashboard for offer analytics (future iteration)
- Intercepting cancellations via the Stripe Customer Portal path (Stripe-native, not interceptable)

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `customer-portal/src/components/settings/ChurnOfferModal.tsx` | New component |
| `customer-portal/src/pages/Pricing.tsx` | Intercept cancel in `handleUpgrade()` |
| `backend/src/routes/stripe.ts` | 4 new endpoints |
| `backend/src/services/churnOfferService.ts` | New service |
| `backend/src/__tests__/churnOfferService.test.ts` | New tests |
| `backend/src/services/db.ts` | New DynamoDB helpers for `AW-ChurnOffers` |
