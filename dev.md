# March 20, 2026: Proposal — Token Limits Per Subscription Tier

## Context

We have four subscription tiers (Free, Starter, Pro, Enterprise) but no token usage limits. All tiers currently allow unlimited Agent Mode token consumption. With $0 in cloud credits (AWS, Google Cloud, Azure), every token is a direct cost. We need per-tier limits that:
- **Free:** Let users see enough value to convert, but cap usage to incentivize upgrades
- **Starter/Pro:** Be generous enough to retain paying users while maintaining healthy margins
- **Enterprise:** Unlimited or custom-negotiated

## Current State

- Token usage is tracked **per message** in `ChatSession.messages[].usage` (prompt_tokens, completion_tokens, total_tokens, estimated_cost)
- No aggregate monthly tracking per user exists
- No enforcement or limits exist — all tiers have unlimited consumption
- Internal tiers: Free, Basic (Starter), Super Premium (Pro). Enterprise not yet in code.

## LLM Cost Reference (per 1M tokens)

| Model | Input | Output | Blended* | Provider |
|-------|------:|-------:|---------:|----------|
| Claude Sonnet 4.5/4.6 | $3 | $15 | $10.20 | AWS Bedrock |
| Claude Opus 4.6 | $15 | $75 | $51.00 | AWS Bedrock |
| GPT-5 | $2.50 | $10 | $7.00 | Azure |
| GPT-5.2 | $3 | $12 | $8.40 | Azure |
| Gemini 3 Pro | $1.25 | $10 | $6.50 | Google |
| Gemini 3 Flash | $0.15 | $0.60 | $0.42 | Google |
| Gemini 3.1 Flash Lite | $0.075 | $0.30 | $0.21 | Google |

*Blended = weighted avg assuming ~40% input, ~60% output tokens (typical agent conversations)*

Default model: GPT-5 (`gpt-5-chat-2`), blended cost ~$7/1M tokens.

## Typical Session Token Usage

| Session Type | Tokens/Session | Examples |
|-------------|---------------:|---------|
| Simple Q&A | 30K–50K | Quick marketing question, 2-3 turns |
| Content creation | 80K–150K | Blog post, social posts, with revisions |
| Research/analysis | 100K–200K | Market analysis, competitor research |
| Complex workflow | 200K–500K | Multi-step task with tool calls |
| Scheduled chat | 50K–150K | Automated recurring tasks |

**Median session: ~100K tokens**

## Proposed Token Limits

| Tier | Price | Monthly Token Limit | ~Sessions/Month | Our Blended Cost (GPT-5) | Gross Margin |
|------|------:|--------------------:|----------------:|-------------------------:|-------------:|
| **Free** | $0 | **1M** | ~10–15 | ~$7 | -$7 (acquisition cost) |
| **Starter** | $199 | **15M** | ~100–150 | ~$105 | ~$94 (47%) |
| **Pro** | $499 | **50M** | ~300–500 | ~$350 | ~$149 (30%) |
| **Enterprise** | Custom | **Unlimited** | Unlimited | Negotiated | Negotiated |

### Free Tier Rationale ($0/mo → 1M tokens)
- Enough for ~10–15 meaningful sessions (blog post, social content, brand strategy)
- Users see value within first few days but hit the wall within the first week of active use
- At ~$7/user/month cost, even a 5% conversion rate to Starter ($199) is profitable after ~3–5 free users per paid conversion

### Starter Tier Rationale ($199/mo → 15M tokens)
- ~5–7 sessions/day on weekdays — comfortable for SMB marketing teams
- 47% gross margin at GPT-5 blended rates; 23% margin if users primarily use Sonnet
- Power users may hit the limit in week 3–4, creating natural upsell to Pro

### Pro Tier Rationale ($499/mo → 50M tokens)
- ~15–20 sessions/day — heavy automation, scheduled chats, multi-step workflows
- 30% margin at GPT-5; margin is thin/negative if users predominantly use Opus
- Rarely hit limit unless running Opus-heavy workloads

### Enterprise Rationale (Custom → Unlimited)
- Custom pricing presumably $1,000+/mo
- Internal soft alert at 100M tokens/month for monitoring
- SLA-backed with negotiated terms

## Model Cost Multiplier (Recommended)

To protect margins across tiers, apply a multiplier so expensive models consume more of the budget:

| Model Tier | Multiplier | Rationale |
|-----------|----------:|-----------|
| Gemini Flash / Flash Lite | 0.1x | 10–50x cheaper than baseline |
| GPT-5 / Gemini Pro | 1x (baseline) | ~$7/1M blended |
| GPT-5.2 | 1.2x | Slightly more expensive |
| Claude Sonnet 4.5/4.6 | 1.5x | ~50% more expensive than GPT-5 |
| Claude Opus 4.6 | 7x | ~7x more expensive than GPT-5 |

Example: A 50K-token Opus session counts as 350K "weighted tokens" toward the monthly limit.

**Alternative (simpler):** No multiplier, but restrict model availability per tier:
- Free/Starter: GPT-5, Gemini models, Claude Sonnet only
- Pro: All models including Opus
- Enterprise: All models

## Overage Behavior (Recommended)

1. **Warning at 80%** — In-app banner: "You've used 80% of your monthly token budget"
2. **Soft block at 100%** — New sessions blocked, but current in-progress session allowed to finish
3. **Grace period** — Allow up to 5% overage to avoid mid-session cutoffs
4. **Reset** — Monthly, aligned to Stripe billing period (`current_period_end`)

## Implementation Plan

### Phase 1: Tracking Infrastructure
1. Add `tokenUsage` fields to `AW-Users` table:
   - `tokenUsage.currentMonth.year`, `tokenUsage.currentMonth.month`
   - `tokenUsage.currentMonth.totalTokensUsed` (weighted)
   - `tokenUsage.currentMonth.rawTokensUsed` (unweighted)
   - `tokenUsage.currentMonth.estimatedCostUSD`
   - `tokenUsage.currentMonth.resetDate` (ISO)
2. Update `agentModeService.ts` to increment user token usage after each LLM call
3. Add monthly reset logic (check on each request if month has rolled over)

### Phase 2: Limit Enforcement
4. Add `monthlyTokenLimit` to tier configs in `AW-Settings` → `subscription_types`
5. Add pre-check in Agent Mode: reject new sessions if user is at/over limit
6. Add 80% warning emission via Socket.IO
7. Allow in-progress sessions to complete (grace overage up to 5%)

### Phase 3: User-Facing
8. Add token usage display to customer portal Settings page
9. Add usage bar/indicator in Agent Mode sidebar
10. Add upgrade prompts when approaching/hitting limits

### Files to Modify
- `backend/src/services/agentModeService.ts` — token tracking, limit checks, model multiplier
- `backend/src/services/chatbotService.ts` — add `tokenUsage` to User interface
- `backend/src/services/db.ts` — add `updateUserTokenUsage()`, `getUserTokenUsage()`
- `backend/src/services/subscriptionService.ts` — add `monthlyTokenLimit` to tier configs
- `backend/src/controllers/agentModeController.ts` — pre-session limit check
- `customer-portal/src/pages/Settings.tsx` — usage display
- `customer-portal/src/components/AgentMode/` — usage bar, warning banner

---

# March 20, 2026: Investigation — AgentWeb.pro Lead Gen Path Broken

## Context

The lead generation process from AgentWeb.pro (our Webflow landing site) was broken for weeks without detection. Investigated the full lead capture flow using browser testing to identify all issues.

## Critical Finding: Nav Menu "Get Started" Links to Job Application Form

The hamburger menu's **"Get Started"** button links to a **job application form** on Surface:
- **Menu CTA URL:** `https://forms.withsurface.com/s/cmhlafdiv0001js0bfy1qaxhh` → "AgentWeb Job Application" (asks about work authorization, what you've built, etc.)
- **Correct URL (used by hero + bottom CTAs):** `https://forms.withsurface.com/s/cmdzs6o9i007rky04xg1157yk` → "Train Emma" lead capture form (asks for work email, name, company, phone)

**Impact:** On mobile, the hamburger menu is the primary navigation. Any visitor clicking "Get Started" from the nav menu was sent to a hiring form instead of becoming a lead. They likely bounced immediately. This silently killed lead conversion with no visible error.

## Other Issues Found

### Cloudflare Turnstile Error (600010)
- Console repeatedly logs `[Cloudflare Turnstile] Error: 600010` and `Failed to load resource` errors on all pages
- Turnstile is the bot-protection widget likely guarding the newsletter signup form
- The `failure_retry` path also fails, so it doesn't recover
- May allow spam submissions or block legitimate users in certain browsers

### No Lead Capture CTA on Content Pages
- `/case-studies` page lists 5 case studies but has no "Get Started" CTA in main content
- Same for `/blog` pages — only the footer newsletter form is available
- Visitors reading about results (e.g., "417 demo requests", "328 add to carts") have no obvious path to the lead form

### /build Page Skips Lead Capture
- "Start Free Trial" goes directly to Stripe checkout ($199/mo after 7-day trial)
- No email capture before the paywall — visitors who aren't ready to pay leave with zero data captured

### rankai.ai External Script
- Every page loads `https://rankai.ai/apply.js` which rewrites alt text, anchor titles, Open Graph meta tags, and injects schema markup after page load
- This external dependency modifies the DOM — worth verifying it's not interfering with lead capture elements or causing the Turnstile issue

## Lead Capture Paths Summary

| Location | CTA Text | Destination | Status |
|---|---|---|---|
| Homepage hero | "Get Started" | Surface lead form | OK |
| Homepage bottom | "Get Started" | Surface lead form | OK |
| **Nav menu** | **"Get Started"** | **Surface JOB APPLICATION** | **BROKEN** |
| /build hero | "Start Free Trial" | Stripe checkout | OK (no lead capture) |
| Footer (all pages) | Newsletter "Submit" | Webflow newsletter | OK (with Turnstile errors) |
| Nav menu | "Log In" | app.agentweb.pro/login | OK |
| Nav menu | "Contact" | mailto:founders@agentweb.pro | OK |

## Fix Required

These fixes must be made in the **Webflow editor** (not in this codebase):
1. **P0:** Fix nav menu "Get Started" link to point to `cmdzs6o9i007rky04xg1157yk` (the lead form, not the job application)
2. **P1:** Investigate and fix Cloudflare Turnstile error 600010
3. **P2:** Add "Get Started" CTAs to case studies and blog pages
4. **P3:** Update copyright year from 2025 to 2026

---

# March 19, 2026: Investigation — X/Twitter Outreach via Unipile

## Context

Investigated adding X/Twitter outreach support via Unipile, mirroring our existing LinkedIn outreach integration. Unipile's SDK includes `TWITTER` as a supported provider (`AvailableAccountProvider` union), and the hosted auth link API accepts `providers: ['TWITTER']`.

## Findings

### Unipile SDK Support

- The `unipile-node-sdk` package lists `TWITTER` as a valid provider alongside `LINKEDIN`, `WHATSAPP`, `INSTAGRAM`, `MESSENGER`, `TELEGRAM`, `MAIL`, `GOOGLE`, `OUTLOOK`, and `IMAP`.
- Account creation types (`accounts-create.types.d.ts`) include Twitter-specific schemas.
- The messaging API (`messaging.startNewChat`, `messaging.sendMessage`) is provider-agnostic and would work for Twitter DMs.
- The users API (`users.sendInvitation`, `users.getAllRelations`) maps to follow/following on Twitter.

### Implementation Plan (Designed but Not Built)

The plan was to mirror the LinkedIn outreach pattern:
- New platform type `'unipile_twitter'` in `connectedAccountsDb.ts`
- New service `xTwitterOutreachService.ts` reusing the shared Unipile client
- New auth route `xTwitterOutreachAuth.ts` with `providers: ['TWITTER']`
- New emma tool `x_twitter_outreach` with actions: `send-dm`, `get-profile`, `follow`, `search-users`, `list-following`, `get-posts`
- Frontend: callback page, Settings platform card, ConnectedAccountsList section

### Blocker: Unipile Twitter Support Suspended

Per Unipile's website and support team (March 2026): **Twitter/X integration is no longer actively maintained.** Their support indicated it may return in a few months. The SDK types still include `TWITTER` but the backend service may reject connections.

### Unipile Actively Maintained Integrations (as of March 2026)

Per Unipile support, the following providers are currently actively maintained:
- **Emails** (MAIL, GOOGLE, OUTLOOK, IMAP)
- **WhatsApp**
- **LinkedIn**
- **Telegram**
- **Instagram**

Twitter/X and Messenger are not on the active list.

## Decision

Paused implementation. Will revisit when Unipile confirms Twitter support is restored. The implementation design is documented above and in `.claude/plans/whimsical-conjuring-stroustrup.md` for when we're ready to proceed.

---

# March 19, 2026: Investigation — Sessions with 0 Messages

## Context

Production data shows a high ratio of sessions with 0 messages. For example, in a 24-hour window there were ~54 sessions but only ~22 had messages. This investigation identifies the root cause.

## Findings

### Session Creation Flow

1. **Frontend** (`customer-portal/src/pages/AgentMode.tsx:2176-2253`): `createNewSession()` calls `POST /api/agent-mode/sessions` eagerly — on page load when no sessionId is in the URL, or when the user clicks "New Chat".

2. **Backend controller** (`backend/src/controllers/agentModeController.ts:1529-1568`): Creates the session record immediately with `portalType: 'agent'`.

3. **Database layer** (`backend/src/services/chatbotService.ts:455-550`): For Agent Mode sessions (`portalType === "agent"`), the system message is `null`, so the session is created with **`messages: []`** (empty array). Messages are only added later when the user actually sends a message, and they go into the separate `AW-ChatMessages` table.

### Why So Many Empty Sessions

The primary cause is **eager session creation on page load**. Every time a user navigates to `/agent-mode` (or `/agent-mode/new`), a new session is created before they type anything. Common scenarios that produce empty sessions:

- **Page refresh**: User refreshes the Agent Mode page → new session created, old one abandoned
- **Navigation bounce**: User opens Agent Mode, then navigates away without sending a message
- **Multiple tabs**: Each tab/window opening Agent Mode creates its own session
- **URL routing**: When no sessionId is in the URL, the frontend routes to `/agent-mode/new` which triggers `createNewSession()`

Additional creation points that may produce empty sessions:
- **Admin/GTM Plan** (`backend/src/routes/admin.ts:3558`): Creates sessions for GTM work items
- **GTM Plan Route** (`backend/src/routes/gtmPlan.ts:1309`): Creates sessions during GTM plan operations
- **Slack Bot** (`backend/src/routes/slack.ts:230`): Creates sessions on Slack events

### Key Data Points

- `messageCount` on the session record reflects the count of messages in the `AW-ChatMessages` table (separate from the legacy `messages` array on the session itself)
- Sessions with `messageCount = 0` never had any user or assistant messages sent
- This is not a data integrity issue — the sessions genuinely have no messages

## Recommended Fix: Lazy Session Creation

**Approach**: Don't create a session until the user sends their first message.

### Frontend Changes (`customer-portal/src/pages/AgentMode.tsx`)

1. When navigating to `/agent-mode/new`, show an empty chat UI without calling `createNewSession()`
2. On first message send, call `createNewSession()` first, then send the message
3. The "New Chat" button should reset the UI state locally without creating a backend session

### Backend Changes (minimal)

No backend changes needed — the `POST /api/agent-mode/sessions` endpoint works fine. The change is purely about **when** the frontend calls it.

### Expected Impact

This should reduce empty sessions by ~60% (the ratio seen in production). Sessions created by admin/GTM/Slack flows would still exist but are a much smaller volume.

---

# March 19, 2026: storywithai.info Blog Publishing — GoDaddy Website Builder Investigation

## Context

Customer site `storywithai.info` uses GoDaddy for CMS. Investigated whether we can support GoDaddy API or MCP for automated blog publishing.

## Site Details

- **Platform:** GoDaddy Website Builder 8.0 (Starfield Technologies)
- **Generator meta tag:** `<meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 8.0.0000"/>`
- **Site ID:** `137516a9-3722-4cf9-8003-6a1c6c535872`
- **Blog URL:** `https://storywithai.info/blogs` (50 existing posts)
- **Read-only feeds:** `/blogs/f.json`, `/blogs/f.rss`, `/blogs/f.atom`
- **Content CDN:** `img1.wsimg.com/isteam/ip/{siteId}/` (images), `img1.wsimg.com/blobby/go/{siteId}/` (scripts)
- **Blog server:** DPS/2.0.0 (Digital Publishing System)

## GoDaddy API Investigation

GoDaddy offers 12 REST APIs at `developer.godaddy.com`, **none of which support CMS or blog content management**:

| API | Purpose |
|-----|---------|
| Domains | Domain registration, DNS, availability |
| Certificates | SSL certificate management |
| Abuse, Aftermarket, Agreements, ANS, Auctions, Countries, Orders, Parking, Shoppers, Subscriptions | Infrastructure/account management |

**Authentication:** API Key + Secret via `Authorization: sso-key [KEY]:[SECRET]` header. Rate limit: 60 req/min.

**Key limitation:** GoDaddy's ToS prohibits commercial use of their API behind a paywall.

## GoDaddy MCP Investigation

- **No CMS/blog MCP exists.** Only domain-related MCPs found.
- One community MCP (`Harshalkatakiya/godaddy-mcp`) — domain availability checks only, 2 GitHub stars.
- Nine auto-generated MCP wrappers — all cover registrar APIs (domains, orders, certs), not content.
- GoDaddy is not listed in the official MCP servers directory.

## Internal API Discovery

GoDaddy Website Builder uses `content.godaddy.com/api` internally:
- Responds with `"Missing X-App-Key header."` when called without auth
- CORS headers allow `GET,POST,PUT,PATCH,DELETE` — confirms write operations exist
- Required headers: `x-app-key`, `authorization`, `x-csrftoken`
- Requires GoDaddy SSO JWT token — not accessible externally
- **Undocumented, likely violates GoDaddy ToS.** No one has reverse-engineered it publicly.

## Recommendation

**Browser automation via our agent engine (Playwright)** is the most practical path:
1. Fits our existing architecture — this is what our platform does
2. Customer doesn't need to change their site
3. Log into `websites.godaddy.com`, navigate to blog editor, create/publish posts through UI
4. Fragile to GoDaddy UI changes, but no better alternative exists for this proprietary CMS

**Alternatives considered:**
- **Migrate blog to supported CMS** (Webflow/BaseHub/WordPress) — most reliable long-term, but requires customer buy-in and migration effort
- **Subdomain approach** (`blog.storywithai.info` on supported CMS) — good option since blog already exists at `/blogs`, but changes URL structure
- **Reverse-engineer internal API** — fragile, undocumented, ToS-violating, not recommended

---

# March 18, 2026: Suspicious Bot Account Signups — No Payment Gate on Registration

## Accounts Investigated

Three suspicious accounts signed up over consecutive days with gibberish Gmail addresses using the Gmail dot trick (dots in local part are ignored by Gmail, allowing unique-looking emails that deliver to one inbox):

| Email | Signed Up (UTC) | User ID |
|-------|-----------------|---------|
| `noqid.eho.b.6.4@gmail.com` | 2026-03-14 23:39 | `3f4a357e-ecb6-41c1-9ffd-40de73d27725` |
| `s.a.c.e.wo.mag.or2.8.1@gmail.com` | 2026-03-15 14:54 | `0b989e86-e5cf-4947-bb1e-46f337e23c89` |
| `l.i.j.o.ba.yug.ido.4.7@gmail.com` | 2026-03-17 21:06 | `cf9ab519-7592-424c-b75e-609283057248` |

All three accounts were deactivated (`isActive: false`).

## Behavior

All accounts followed an identical automated pattern:
- Signed up via email/password (not Google OAuth)
- Within 1–6 seconds of signup, 4 chat sessions were auto-created as the bot navigated: `dashboard` → `plan-Onboarding` → `plan/Onboarding` → `agent-mode`
- Zero user messages sent, zero tasks created, zero executions — no actual product usage
- One account also hit `forgot-password` 16s after signup
- Two accounts returned days later and visited the `settings` page

## Root Cause: Registration Endpoint Has No Payment Verification

The Stripe payment flow is entirely optional and easily bypassed:

1. **Intended flow:** User visits pricing → Stripe Checkout → redirect to `/register?session_id=cs_xxx` → email pre-filled and locked → set password → account created
2. **Actual exploit:** Bot goes directly to `POST /api/auth/register` with `{email, password}` — no `session_id` required. The backend creates the account with `roles: ["customer"]` unconditionally.

**Backend** (`POST /api/auth/register`): No Stripe session validation. Assigns `customer` role to all signups regardless of payment.

**Frontend** (`Register.tsx`): The `session_id` query param only pre-fills the email field; it's completely optional. Registration works without it.

**ProtectedRoute**: Only checks for `customer` role (which all registrants get). No subscription status or payment verification.

The only protection is a rate limiter (10 req/15min per IP), which the bots circumvented by signing up once per day.

## Future Fix (Deferred)

Options to prevent this:
1. **Require Stripe session validation** in the register endpoint — verify `session_id` with Stripe before creating the account
2. **Don't assign `customer` role at registration** — use a `pending` role and upgrade to `customer` only after Stripe webhook `checkout.session.completed`
3. **Add email verification** — require confirmation link click before activation
4. **Add CAPTCHA** (reCAPTCHA/hCaptcha/Turnstile) to the registration form

---

# March 11, 2026: LinkedIn API Limitations — Activity URNs, Post Monitoring, and Metrics Caching

## LinkedIn Activity URN vs Share URN

LinkedIn uses two different URN systems for posts:
- **Activity URNs** (`urn:li:activity:NNNNN`) — used in post URLs (e.g., `/posts/username_title-activity-NNNNN-hash`, `/feed/update/urn:li:activity:NNNNN/`)
- **Share URNs** (`urn:li:share:NNNNN`) or **ugcPost URNs** (`urn:li:ugcPost:NNNNN`) — used by LinkedIn's API internally

**Critical finding:** The numeric IDs in activity URNs are DIFFERENT from share URN numeric IDs. There is NO LinkedIn API to convert between them. LinkedIn's Posts API (`GET /rest/posts/{urn}`) only accepts share or ugcPost URNs and returns 400 for activity URNs.

## Why "Monitor Post by URL" Was Removed

We attempted to build a feature that lets users paste a LinkedIn post URL to start tracking its metrics. This was abandoned because:

1. **Most LinkedIn post URLs use activity URNs** — The `/posts/username_title-activity-NNNNN-hash` format (most common when sharing) contains an activity ID, not a share ID.
2. **LinkedIn Posts API rejects activity URNs** — `GET /rest/posts/urn:li:activity:NNNNN` returns 400 "not a valid urn type".
3. **No activity→share conversion API exists** — We tested `q=activity` finders, social metadata, and other endpoints. None return the share URN for a given activity URN.
4. **socialMetadata endpoint** (`GET /rest/socialMetadata/urn:li:activity:NNNNN`) is the only API that accepts activity URNs, but it only returns reaction counts and comment counts — no impressions, no post content, no share URN.
5. **Personal tokens get 403** on the Posts API (`UGC_FORBIDDEN`), so even for share URNs, personal posts can't be fetched directly.

**Conclusion:** Monitoring arbitrary LinkedIn posts by URL is not viable with the current LinkedIn API. Posts must be created through AgentWeb to be tracked.

## Metrics Caching Fix

When the LinkedIn API rate-limits or errors, the adapter's `getPostMetrics()` was returning all-zero metrics to the frontend. On subsequent page loads, if the cache TTL had expired, another API call would fail again, showing persistent 0s.

**Fix:** On API failure, fall back to stale cached metrics from DynamoDB instead of returning 0s. Only return 0s if no cached metrics exist at all.

## Activity URN Metrics Fallback

For posts stored with `urn:li:activity:` URNs (legacy data from the removed monitor feature), the `memberCreatorPostAnalytics` API throws "Invalid post URN format". The adapter now detects activity URNs and uses the `socialMetadata` endpoint as a fallback, providing likes and comments (but not impressions).

---

# March 8, 2026: Daily AI News - Amino Scheduled Chat Failure — Missing Tools for Basic Subscription

**User:** `sue@aminocapital.com` (Amino Capital, Basic subscription)

**Problem:** The "Daily AI News - Amino" scheduled chat failed to run because some required tools are not available under the Basic subscription. New skills were recently created (e.g., Landing Page skill for Advanced/Super Premium) that claimed tools previously available via the `__other_skills__` virtual skill. This moved those tools out of `__other_skills__`, causing Basic subscription users to lose access.

**Root cause:** The `__other_skills__` virtual skill dynamically resolves to tools NOT associated with any published skill. When new skills are published and claim tools, those tools leave `__other_skills__`. If a subscription type (e.g., Basic) relies on `__other_skills__` for tool access, users silently lose tools whenever new skills are created.

**How subscription → tools resolution works:**
1. User's `subscriptionType` → `getSubscriptionTypeConfig()` → `allowedSkills[]` (skill IDs)
2. `resolveSkillsToToolNames(skillIds)` → expands each skill ID to its `toolNames[]`
3. `__other_skills__` resolves to tools not claimed by any published skill (dynamic, shrinks as skills are added)
4. Foundation tools (18) are always available regardless of subscription
5. Scheduled chat pre-flight check (`agentModeController.ts:810-867`) validates `requiredFunctionCalls` against allowed tools, fails with error email if any are disallowed

**Action taken:** Created a new skill "Tools for Basic Subscription" via admin UI with 38 explicit tools and no system prompt. This skill is added to the Basic subscription's `allowedSkills`, ensuring Basic users have a stable set of tools regardless of how other skills change.

**Tools in "Tools for Basic Subscription" (38):**
```
create_blog_article, publish_blog_article, repair_blog_article, create_social_media_posts,
list_cms_categories, generate_image, create_image_task_from_prompt, generate_video,
list_task_templates, create_task_from_template, create_task_from_prompt, create_revision,
perform_deep_research, list_connected_account_posts, load_connected_account_metrics,
post_on_connected_account, get_post_analytics, create_knowledge_base, update_knowledge_base_file,
attach_knowledge_base_files, create_gtm_plan, read_gtm_plan, update_gtm_plan, list_gtm_plans,
add_gtm_phase, update_gtm_phase, add_gtm_work_items, update_gtm_work_item, delete_gtm_items,
get_gtm_common_items, add_gtm_common_items, send_gtm_status_report, comment_on_linkedin_post,
react_to_linkedin_post, linkedin_outreach, create_html_from_template, update_html_file,
list_html_templates
```

**Tools excluded from Basic (in other premium skills):**
- CRM/Leads (17 tools): get_leads, get_lead_details, create_lead_list, etc.
- Books (8 tools): create_book, generate_book_content, add_characters, etc.
- Email: email, send_for_review
- Meta Ads: get_meta_ads_metrics, list_meta_ads_campaigns

**Key files:**
- `backend/src/services/subscriptionService.ts` — subscription → skill → tool resolution
- `backend/src/services/skillService.ts` — skill CRUD (AW-Skills table)
- `backend/src/controllers/agentModeController.ts:810-867` — scheduled chat tool validation
- `backend/src/services/agentModeService.ts:1717` — FOUNDATION_TOOLS definition

**Lesson:** When creating new skills, always check if the tools being claimed are currently accessed by subscription tiers via `__other_skills__`. Prefer explicit tool skills per subscription tier over relying on `__other_skills__` for stable access.

---

# March 6, 2026: xcures SEO Config — GA Permission Denied

**User:** `agentwebintegration@xcures.com` (userId: `f958eb3e-4e82-4227-8aa8-634476498a62`)

**Config in DynamoDB (AW-Users):**
- `seoDomains`: `["xcures.com"]`
- `googleAnalyticsPropertyId`: `"277333489"`
- `gaFilteredDomains`: `[]`

**Findings:**
- **Google Search Console:** Working. No errors in prod logs for `sc-domain:xcures.com`.
- **Google Analytics:** `PERMISSION_DENIED` — service account does not have access to GA4 property `277333489`.

**Prod log (Mar 6):**
```
Error fetching Google Analytics metrics: Error: 7 PERMISSION_DENIED: User does not have sufficient permissions for this property.
```

**Action needed:** xcures team must grant **Viewer** access to the service account email in GA4 Admin → Property access management for property `277333489`. The same service account (from `prod/AgentWeb/Google/SearchConsole` secret) is used for both GSC and GA.

---

# March 6, 2026: MCP Server IDOR Vulnerability — userId Override in Tool Arguments

**Problem:** The Emma MCP server (`backend/src/mcp/server/mcpServerCore.ts`) allows tool callers to override the authenticated user's identity by passing a `userId` in tool call arguments. In the request handler:

```typescript
const context = {
  userId: userId || sessionContext?.agentUserId,
  // userId from tool args takes precedence over the authenticated user
};
```

Any authenticated user (with a valid API key, OAuth token, or static MCP token) can pass any `userId` and operate on another user's private data.

**Reproduction (tested on production `api.agentweb.pro`):**

1. Initialize MCP session with a valid API key:
   ```
   POST /mcp with Authorization: Bearer aw_<key>
   → Returns mcp-session-id header
   ```

2. Call `list_knowledge_base_files` with a different user's ID:
   ```json
   {"method":"tools/call","params":{"name":"list_knowledge_base_files","arguments":{"userId":"<other_user_id>"}}}
   ```

3. Result: Returns the target user's **private** knowledge bases (16 KBs, 116 files), including private persona data, LinkedIn posts, Google Drive folders, ClickUp docs, and signed GCS download URLs.

**Severity:** High — IDOR (Insecure Direct Object Reference). Affects all MCP tools that accept `userId` in arguments, potentially including leads, tasks, GTM plans, brand guidelines, connected accounts, etc.

**Root cause:** The MCP tool execution layer trusts caller-supplied `userId` over the authenticated identity (`agentUserId` from the API key). Standard REST API routes don't have this issue because `req.user` is derived from the JWT token and cannot be overridden by request parameters.

**Architecture context:** We evaluated two approaches for exposing Emma capabilities:
- **Approach A (current):** 90+ internal Emma tools exposed directly via MCP. Suffers from this IDOR issue, large tool surface area, and tight coupling to internal schemas.
- **Approach B (recommended):** Expose AgentWeb backend REST APIs as MCP tools. All requests go through JWT auth middleware where `req.user` is derived from the token, not caller parameters. Smaller tool surface (~20-30 tools), stable API contract, consistent auth model.

**Immediate fix needed:** In `mcpServerCore.ts`, stop allowing `userId` from tool arguments to override the authenticated user:
```typescript
// Before (vulnerable):
userId: userId || sessionContext?.agentUserId,

// After (fixed):
userId: sessionContext?.agentUserId,  // Always use authenticated identity
```

**Long-term fix:** Migrate to Approach B — backend API MCP wrapper with JWT-based auth for all operations.

**Production log analysis (no external attacks detected):**

Reviewed full bundle logs from production (`Agentweb-backend-env-prod-3`) for March 6, 2026. All `/mcp` requests came from only two source IPs:
- `98.46.137.148` — external user via `claude-code/2.1.69-2.1.70`. Two sessions (`b773311b`, `485aac4a`) at 02:48-02:49 UTC. Actions: `initialize` → `tools/list` only. No `tools/call` with userId override.
- `73.157.80.155` — our IP. Four sessions for testing: two via claude-code (session setup), two via curl (IDOR reproduction).

No evidence of exploitation by external users beyond our own security testing.

**Fix deployed and verified (PR #613, merged March 6):**

The fix allows `userId` override only for internal clients (`isInternal=true`, i.e. backend-to-backend via `MCP_ACCESS_TOKEN`). External clients (API keys, OAuth) always use the authenticated `agentUserId`.

Post-deploy verification on production:
1. Called `list_knowledge_base_files` with `userId: "1743956381327"` (different user) → returned the API key owner's 19 KBs / 20 files (not the target user's data).
2. Called `list_knowledge_base_files` without userId → returned identical 19 KBs / 20 files.
3. Before the fix, the same call with userId override returned the target user's 16 KBs / 116 files (including private data like "Harsha's persona", "Harsha's worst LinkedIn posts").

The userId parameter is now correctly ignored for external clients.

**Files:** `backend/src/mcp/server/mcpServerCore.ts` (tool request handler), `backend/src/mcp/server/mcpServer.ts` (session/auth management), `backend/src/__tests__/mcp.userIdOverride.test.ts` (regression tests)

**Approach B implemented (March 7, 2026):**

Migrated from Approach A (90+ internal tools exposed directly) to Approach B (REST API wrappers). The MCP server now exposes ~26 tools that call backend REST APIs via HTTP self-calls with short-lived JWTs, going through the same `authenticateToken` middleware as web UI requests. This eliminates the entire class of IDOR vulnerabilities by design.

**Why Approach A (direct internal tools) was problematic:**
1. **IDOR vulnerability** — caller-supplied `userId` in tool args overrode the authenticated identity, allowing cross-user data access.
2. **No audit trail** — direct service calls bypass the REST API layer where request logging, rate limiting, and usage tracking happen. Actions taken via MCP tools were invisible to the audit/analytics pipeline.
3. **No data recording** — REST API route handlers record metrics (response times, error rates, request counts per user) and trigger side effects (webhooks, notifications, activity feeds). Direct service calls skip all of this, creating data gaps between MCP and portal usage.
4. **Large attack surface** — 90+ tools exposed internal schemas and service methods that were never designed for external consumption.

**Key changes:**
- Replaced `tools.ts` (75 tools) and `portalTools.ts` (12 tools) with `apiTools.ts` (~30 tools). Each tool calls `mcpFetch()` which generates a short-lived JWT for the authenticated user and makes an HTTP request to `localhost` REST endpoints.
- Internal tools (`install_skills`, `list_available_skills`, `search_web`, `generate_image`, `send_email`, `save_file`) are registered with `internal: true` flag — available to Emma's agent engine internally but hidden from external MCP clients via `getToolDefinitions()` filtering.
- External agents access AI capabilities (image gen, web search, email) through Emma chat sessions (`emma_send_message`) rather than direct tool calls.
- MCP Emma sessions use the exact same skill-first flow as the customer portal — no MCP-specific behavior.
- Tool count: External MCP clients see 26 tools, Emma's internal registry has 32.

**Architecture:**
```
MCP Client → MCP Server (API key auth) → mcpFetch() → localhost REST API → authenticateToken middleware → route handler → service → DB
```

**Verification — 10 side-by-side MCP vs REST API comparison tests (all passed):**

| # | Test | MCP Result | REST Result (Portal) |
|---|------|-----------|---------------------|
| 1 | list_tasks | 18 tasks | 18 tasks |
| 2 | list_lead_lists | 3 lists | 3 lists |
| 3 | list_gtm_plans | dict (matching) | dict (matching) |
| 4 | manage_brand (read) | same company_name | same company_name |
| 5 | manage_market_strategy (read) | dict (matching) | dict (matching) |
| 6 | list_knowledge_bases | dict (matching) | dict (matching) |
| 7 | list_connected_accounts | dict (matching) | dict (matching) |
| 8 | emma_create_session | `associatedSkills=[]`, `portalType=agent` | identical |
| 9 | emma_list_sessions | 36 sessions | 36 sessions |
| 10 | list_task_executions | 1 execution | 1 execution |

**End-to-end Emma session tests via MCP (all use same skill-first flow as customer portal):**

| Test | Tool Calls | Result |
|------|-----------|--------|
| Image generation | `install_skills` (147ms) → `search_knowledge_base` (1533ms) → `generate_image` (189s) | S3 image URL returned |
| Market report | `search_web` (439ms) → `search_web` (617ms) | 1916-char report with market data |
| Blog article | `install_skills` (126ms) → `generate_blog_post` (42s) | Full blog post generated via AI pipeline |
| Short video | `install_skills` (181ms) → `list_available_skills` (78ms) | Correctly reported video gen not available (skill not published on test env) |

Bug found and fixed during testing: `generate_blog_post` tool had wrong input schema (`title_draft`/`content_draft` instead of `topic`), causing 400 errors. Fixed to match the actual REST API (`POST /api/blog/generate` expects `topic`, `keywords`, `tone`, `length`).

**Files:** `backend/src/mcp/server/apiTools.ts` (tool registrations), `backend/src/mcp/server/httpClient.ts` (JWT + fetch helper), `backend/src/mcp/server/registry.ts` (internal flag support), `backend/src/__tests__/mcp.apiTools.test.ts` (tests)

# March 5, 2026: Dev Env Launch Fails on Elastic Beanstalk

**Problem:** Notion-triggered cloud dev env launch failed with `ENOENT: no such file or directory, open '/var/app/test-env/user-data-dev-auto.sh'`. The `devEnvService.ts` reads the script via `fs.readFileSync` with a path relative to `__dirname`, but `test-env/` is at the repo root and not included in the backend deploy zip.

**Fix:** Copy `user-data-dev-auto.sh` into `dist/` during CI packaging (both `tests.yml` and `deploy.yml`), and update the path in `devEnvService.ts` from `../../../test-env/user-data-dev-auto.sh` to `../user-data-dev-auto.sh`.

**Collateral fix:** Deleted orphaned security group `sg-075b576a4253b70d4` created before the failure. Also added DynamoDB permissions to `agentweb-test-env-ec2-role` IAM policy (prod read-only, dev read-write, plus ListTables/DescribeTable).

**Files:** `backend/src/services/devEnvService.ts`, `.github/workflows/tests.yml`, `.github/workflows/deploy.yml`

**PR:** #608

# March 4, 2026: Admin Users Tab Performance Fix

**Problem:** Admin Users tab was slow — `getAllUsers()` called `getTasksByUserId()` per user, which fetched full task details AND 3 sub-queries per task (executions, schedules, subscribers). For U users with T tasks each: U × (1 + 3T) DynamoDB calls.

**Fix:** Added `taskDb.getUserTaskCount()` using `Select: "COUNT"` on the existing `UserTasksIndex` GSI. Now `getAllUsers()` makes exactly U × 1 count queries (plus workflow count + chat session count, all parallelized). Zero sub-queries.

**Impact:** For 50 users averaging 10 tasks each: **1,550 queries → 50 queries** (~97% reduction). Response time scales linearly with user count, not user × task count.

**Files:** `backend/src/services/db.ts` (new `getUserTaskCount`, updated `getAllUsers`), `backend/src/__tests__/admin.usersPerformance.test.ts`
# March 4, 2026: Speed Up Reports/Images/Videos Loading — Incremental Asset Caching

**Problem:** The Images and Reports pages took ~10.5s to load for a test user with only 36 images / 74 reports.

**Root Cause:** `getExecutionsWithAssets()` in `backend/src/routes/tasks.ts` loaded ALL agent-mode sessions with ALL their messages on every page view:
1. `getUserSessions(userId, 'agent')` loaded 208 sessions with all messages (208 DynamoDB queries)
2. For each session, `getChatSession()` redundantly reloaded the same messages (another 208 queries)
3. This happened separately for images, videos, and html-reports — so the same data was loaded 2-3x
4. Total: ~400-600 DynamoDB queries per page load, most redundant

**Solution:** Rui's incremental asset caching approach — store discovered assets directly on the `AW-ChatSessions` record and only scan new messages on subsequent loads. This was the optimal solution, beating the alternatives considered (separate cache table, Redis cache, frontend pagination) by being simpler, requiring no new infrastructure, and achieving near-zero latency on warm loads.

**Implementation:**

1. **New fields on `ChatSession`:** `assetCache` (images/videos/htmlReports arrays), `assetScanIndex` (message index scanned up to), `messageCount` (total messages, atomically incremented)
2. **New methods on `ChatbotDB`:**
   - `getSessionsWithoutMessages()` — metadata-only session query (no message table reads), with DynamoDB pagination
   - `getMessagesFromIndex(sessionId, fromIndex)` — partial message loading for delta scans
   - `updateAssetCache()` — fire-and-forget cache writes to session record
3. **Refactored `getExecutionsWithAssets()`:** Single session load shared across all asset types, with 3-tier cache logic:
   - Cache up-to-date (`assetScanIndex >= messageCount`) → zero DB reads
   - Delta scan (`assetScanIndex < messageCount`) → only load new messages
   - First time (no cache) → full scan, then cache
4. **`scanMessagesForAssets()` helper:** Single-pass extraction of images, videos, and HTML reports from messages (consolidates 3 separate scanning loops)
5. **`messageCount` tracking:** Atomically incremented on `addMessageToSession`, `addMessagesToSession`, and `migrateMessagesToMessagesTable`
6. **Frontend:** Added `loading="lazy"` to image grid in `customer-portal/src/pages/Images.tsx`

**Bugs Fixed During Testing:**
- `getSessionsWithoutMessages()` initially lacked DynamoDB pagination — sessions beyond the 1MB page limit were silently dropped
- Cache logic for legacy sessions (no `messageCount` field) caused image count discrepancy between first/second loads
- `migrateMessagesToMessagesTable()` didn't set `messageCount`, causing cache to miss new messages added to migrated sessions

**Test Results:**

| Scenario | Before | After |
|---|---|---|
| Images page (36 images, 15 tasks) | ~10.5s | **~1.0s** (warm cache) |
| Reports page (74 reports, 34 tasks) | ~10.5s | **~1.0s** (warm cache) |

Consistency verified: all loads return identical counts (36 images / 15 tasks, 74 reports / 34 tasks).

**Tests Added:**
- `chatbotService.assetCache.test.ts` — 10 tests covering getSessionsWithoutMessages, getMessagesFromIndex, updateAssetCache, incrementMessageCount
- `scanMessagesForAssets.test.ts` — 12 tests covering image/video/HTML extraction, deduplication, timestamps, uploads, default filenames
- Updated existing test files to use new mock patterns (agentModeMessageLoading, videoFavorites, imageFeedback, messagesTable)

**Files Modified:**
- `backend/src/services/chatbotService.ts` — ChatSession interface, 4 new methods, messageCount tracking in migration
- `backend/src/routes/tasks.ts` — Refactored getExecutionsWithAssets, new scanMessagesForAssets helper, addCachedAssetsToResult helpers
- `customer-portal/src/pages/Images.tsx` — loading="lazy" on img tags

---

# March 3, 2026: AWS Bedrock Cost Investigation ($7.7k in February)

**Problem:** February AWS bill was $7,742.75, majority from Claude Opus 4.6 and Sonnet 4.6 on Bedrock.

**Root Cause:** Chat sessions (agent mode) are the primary cost driver — not task executions.

**February Bedrock Usage (Chat Sessions):**
- **Claude Sonnet 4.6:** 224 sessions — top user: `juan@usehaven.ai` (232 sessions, 9,046 function calls)
- **Claude Opus 4.6:** 139 sessions — top user: `childrenstorywithai@gmail.com` (40 sessions, 504 fn calls), plus anon users and `agentweb@xcures.com`
- Task executions used almost zero Bedrock (10 calls total, all Claude 3.5 Sonnet v2)

**Other LLM usage (not on AWS bill):** GPT-5.2 (320 sessions), GPT-5 (157), Gemini-3-pro (292) — these are Azure/Google costs.

**Monitoring Enabled:** Bedrock Model Invocation Logging → `s3://agentweb-bedrock-logs/invocation-logs/` (enabled 2026-03-03). This logs caller identity, model, and token counts per request.

**Cost Reduction Options:**
1. Default anon/demo users to Sonnet instead of Opus (5x cheaper per token)
2. Cap function calls per session to prevent runaway usage
3. Track per-user token usage in DynamoDB for billing visibility
4. Consider session-level token budgets

**Querying Cost Data:**
- AWS Cost Explorer only works from the parent/management account (not member account 992382574572)
- The `facetoon_image_user` IAM user now has `ce:GetCostAndUsage` permission but can only see the member account's own costs (~$0.12/month)
- For per-user breakdown, query `AW-ChatSessions` table: filter by date, group by `userId` + `llmModel`, count `calledFunctions`

---

# February 28, 2026: Notion MCP Integration for Sprint Task Management

**Purpose:** Enable Claude Code to pull dev items directly from the Notion "Sprint Tasks - Argusoft" database via MCP.

**Setup:**

1. **Create a Notion internal integration** at https://www.notion.so/profile/integrations
   - Choose **"Internal integration"** (not public/OAuth)
   - Copy the **Internal Integration Secret** (starts with `ntn_`)
   - No webhooks or redirect URIs needed

2. **Connect the integration to your Notion pages:**
   - Open the "Sprint Tasks - Argusoft" database in Notion
   - Click "..." menu (top right) → **Connections** → **Connect to** → select the integration
   - Repeat for any other pages/databases you want accessible

3. **Configure `.mcp.json`** in the repo root (already gitignored):
   ```json
   {
     "mcpServers": {
       "notion": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@notionhq/notion-mcp-server"],
         "env": {
           "OPENAPI_MCP_HEADERS": "{\"Authorization\":\"Bearer <YOUR_NOTION_TOKEN>\",\"Notion-Version\":\"2025-09-03\"}"
         }
       }
     }
   }
   ```

4. **Restart Claude Code** to load the new MCP server

**How it works:**
- The Notion MCP server exposes tools for searching, reading, and querying Notion databases
- Claude Code calls these tools on demand (pull-based, no webhooks)
- `.mcp.json` is gitignored since it contains the API token

**Important: Database ID vs Data Source ID:**
- The Notion API has two ID types: `database_id` and `data_source_id`
- Use `mcp__notion__API-post-search` with `"filter": {"property": "object", "value": "data_source"}` to find the database
- For `mcp__notion__API-query-data-source`, use the **data_source_id** (found in relation properties), NOT the database_id
- Sprint Tasks database ID: `2bf09247-c951-8122-a327-ee39ef7a6ec7`
- Sprint Tasks data source ID: `2bf09247-c951-812a-bd0a-000bd4c05bbf` (use this for queries)

**Troubleshooting:**
- If Notion tools aren't available after restart, check `npx @notionhq/notion-mcp-server` runs without errors
- If queries return empty results, verify the integration is connected to the target page/database in Notion
- Token rotation: update the `ntn_` token in `.mcp.json` and restart Claude Code

---

# February 27, 2026: Agent Mode LLM Performance — Opus vs Sonnet Timing Investigation

**Problem:** A customer session (`5b1c1270-57b8-4de0-95c7-a787115b965e`) on `anthropic.claude-opus-4-6-v1` took ~49 minutes (29 min system time). No per-turn timing instrumentation existed to diagnose which LLM turns were slow.

**Investigation:**

Added per-turn timing instrumentation to `agentModeService.ts`:
1. **`callLLM()` timing** — logs model name, duration, token count after every LLM API call
2. **Iteration summary** — logs iteration number, model, tool names, sessionId per agent loop turn
3. **Tool execution timing** — logs tool name, duration, sessionId per tool call

Log format examples:
```
AgentMode: LLM call completed [model=anthropic.claude-opus-4-6-v1, duration=2883ms, tokens=N/A]
AgentMode: Iteration 1 [model=anthropic.claude-opus-4-6-v1, tools=search_web, sessionId=abc123]
AgentMode: Tool executed [name=search_web, duration=549ms, sessionId=abc123]
```

**Benchmark — same prompt ("What are the top 3 B2B lead generation strategies for SaaS companies?"):**

| Metric | Opus (`claude-opus-4-6-v1`) | Sonnet (`claude-sonnet-4-6`) |
|---|---|---|
| LLM call 1 | 2,883ms | 1,829ms |
| LLM call 2 | 2,808ms | 9,800ms (final) |
| LLM call 3 (final) | 19,656ms | — |
| Iterations | 3 | 2 |
| Tools used | search_web, read_page_source ×2 | install_skills |
| **Total wall clock** | **~28.3s** | **~11.8s** |

**Finding:** Opus is ~2.4x slower than Sonnet. The biggest bottleneck is the final response generation (19.6s vs 9.8s for Sonnet). Opus also uses more tools (3 iterations vs 2), compounding latency from extra LLM calls + tool execution.

**Performance improvement — parallel tool execution:** Tools within a single iteration were executed sequentially. When the LLM returns multiple tool_calls in one response, they are independent and can run concurrently. Changed the tool execution loop from sequential `for...await` to `Promise.all()` for parallel execution.

**Before/after comparison (Opus, Iteration 2 with 2× `read_page_source`):**

| | Before (sequential) | After (parallel) |
|---|---|---|
| read_page_source #1 | 1,208ms | 80ms |
| read_page_source #2 | 1,216ms | 1,291ms |
| **Tool phase wall clock** | **2,424ms** (sum) | **~1,291ms** (max) |

The parallel version runs both tools concurrently, so wall clock = max(individual durations) instead of sum. Savings grow with more concurrent tools and longer-running tools. In a full work plan session with dozens of multi-tool iterations, this compounds significantly.

**Full Opus session comparison (same prompt, same model):**

| Metric | Before (`abd13579`) | After (`240300f7`) |
|---|---|---|
| LLM call 1 | 2,883ms | 2,933ms |
| LLM call 2 | 2,808ms | 2,875ms |
| LLM call 3 (final) | 19,656ms | 19,177ms |
| Tool: search_web | 549ms | 347ms |
| Tool: read_page_source ×2 | 1,208 + 1,216ms (seq) | 80 + 1,291ms (parallel) |
| **Tool phase Iter 2** | **~2,424ms** | **~1,291ms** |

LLM call durations are consistent (network/model variability). The tool execution phase in Iteration 2 dropped from ~2.4s to ~1.3s — a **~47% reduction** in that phase.

**Heavy-context benchmark — production session `5b1c1270` (97 messages, "Facebook Marketing Strategy"):**

Same follow-up prompt ("Summarize the key findings from this session and give me 3 actionable next steps") sent to both models on the same session context:

| Model | LLM Call Duration | Tools | Relative |
|---|---|---|---|
| Opus | 29,855ms | none | 1.24x slower |
| Sonnet | 24,047ms | none | baseline |

On a heavy-context session, Opus is ~24% slower per LLM call — a smaller gap than the 2.4x on lightweight prompts because input processing (not generation) dominates. Across a full work plan with 20-30 iterations, this ~6s/call overhead compounds to minutes of extra wall time. Combined with Opus's tendency to use more tools per turn (3 iterations vs 2 in the lightweight test), total session time difference can be 2x+.

**Files changed:**
- `backend/src/services/agentModeService.ts` — timing logs + parallel tool execution
- `backend/src/__tests__/agentModeService.llmTiming.test.ts` — 10 tests (timing instrumentation + parallel execution)

---

# February 26, 2026: Instagram Business Login — "Unsupported request" in Production

**Symptom:** Connecting an Instagram Business account via Connected Accounts failed in production with `IGApiException` code 100: `"Unsupported request - method type: get"`. Both `getLongLivedToken` (`graph.instagram.com/.../access_token`) and `getInstagramBusinessMe` (`graph.instagram.com/.../me`) returned the same error. The initial OAuth token exchange (POST to `api.instagram.com/oauth/access_token`) succeeded.

**Investigation:**
- Confirmed `graph.instagram.com/v24.0/me` and `graph.instagram.com/v23.0/me` are valid endpoints (curl with invalid token returns code 190, not code 100).
- The code 100 "Unsupported request" error is not a version issue — it's specific to the access token being returned by the OAuth flow.
- Decoupled `META_INSTAGRAM_API_VERSION` from `META_API_VERSION` (PR #565) — did not fix the issue.

**Root cause:** The Facebook Developer App must have Instagram Business Login permissions approved through **App Review** for production use. Without approval, the OAuth flow still completes and returns a token, but that token cannot be used with `graph.instagram.com` API endpoints — all GET requests fail with code 100.

For **development/testing only**, adding the Instagram Business account in the "Generate access tokens" section under API Setup with Instagram Login allows the token to work without App Review. This is limited to accounts explicitly added in that section.

**Fix:**
- **Development/Testing:** In the Facebook Developer portal → your app → Instagram → API Setup with Instagram Login → "Generate access tokens" section: add the Instagram Business account. This grants test access for that specific account.
- **Production:** Submit the app for App Review with the required Instagram Business Login permissions (`instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights`). Once approved, any Instagram Business account can connect without being manually added.

**Key takeaway:** This is an app-level configuration, not a code issue. The OAuth flow succeeds without proper permissions setup, but the returned token is non-functional for API calls — making the error misleading.

---

# February 25, 2026: Long-Running Test Env & IP Allowlist Fix

- Added `--no-watchdog` flag to `./test-env/test-env.sh launch` to skip the 24-hour auto-shutdown cron. Use for long-running test environments that you teardown manually.
- Fixed bug where the test-env-access UI showed the developer's IP as "not accessible" on launch. The launch script added the IP to the AWS security group but not to `allowlist.json`. Now seeds the allowlist at launch.

---

# February 24, 2026: Growth Estimate — Month-over-Month Comparison

Ran `node src/scripts/growth-comparison.js 2026-02-24` to compare 3 rolling 30-day periods.

| Metric | Jan 25 - Feb 24 | Dec 25 - Jan 24 | Nov 25 - Dec 24 |
|---|--:|--:|--:|
| Agent Mode Sessions | 1,033 (+130, +14%) | 903 (+143, +19%) | 760 |
| Generated Articles | 989 (+485, +96%) | 504 (+264, +110%) | 240 |
| Approved Articles | 15 (+9, +150%) | 6 (+6, new) | 0 |
| Published Articles | 62 (+53, +589%) | 9 (+9, new) | 0 |
| Generated Posts | 298 (+37, +14%) | 261 (+198, +314%) | 63 |
| Approved Posts | 7 (-2, -22%) | 9 (+9, new) | 0 |
| Published Posts | 27 (+16, +145%) | 11 (+11, new) | 0 |
| Generated Images | 345 (+5, +1%) | 340 (+182, +115%) | 158 |
| Approved Images | 10 (-14, -58%) | 24 (+24, new) | 0 |

**Data sources:**
- Sessions & tool call counts: `AW-ChatSessions` (`calledFunctions` on each session, bucketed by session `createdAt`)
- Approved articles/posts/images: `AW-AssetApprovals` (status=`approved`, bucketed by `updatedAt`)
- Article = `blog-*` filename; Post = `social-media-post*`, `linkedin-post*`, `x_thread*`, `twitter-thread*` filenames; Image = `assetType=image`

**Script:** `backend/src/scripts/growth-comparison.js` — accepts an optional end date argument (defaults to today). Run from the `backend/` directory.

---

# February 24, 2026: SEO/GEO Engagement Time Is Total, Not Average

The "Top Pages by Engagement" table on the SEO/GEO page displays **total** engagement time, not average. The backend (`seo.ts`) requests GA4's `userEngagementDuration` metric, which is cumulative across all sessions. The frontend (`SEO.tsx`) renders it directly via `formatTime()` with no averaging. For product metrics, the backend separately computes `avgDuration` by dividing `totalDuration` by `pageViews`, but this is not used in the top pages table.

---

# February 24, 2026: `create_html_from_template` JSON Failure + Reports Model Admin Bug

## Problem 1 — Amino Daily News Template Failure

Production session `8400bace-...` (Daily AI News - Amino) using `gemini-3.1-pro-preview` failed 25 times on `create_html_from_template` with "LLM returned invalid JSON for variable substitution".

### Root Cause

Three issues combined:

1. **`tools.ts:1175` used `args.llmModel` but `llmModel` is in `context`, not `args`** — the model passed to `createHtmlFromTemplate` was undefined/wrong.
2. **Gemini doesn't reliably honor `response_format: { type: 'json_object' }`** — it returns JSON wrapped in markdown code blocks (`` ```json ... ``` ``), causing `JSON.parse()` to fail.
3. **No `max_completion_tokens` was set** — risking output truncation on large templates.

### Fix

- Changed `args.llmModel` → `context?.llmModel` in `tools.ts:1175`
- Added JSON code-block stripping fallback: first tries `JSON.parse`, then strips `` ```json ``` `` wrappers and retries, with raw response logging on failure
- Added `max_completion_tokens: 16384` to the `callLLM` call (matching `createHtmlFile` and `createHtmlTemplate`)

## Problem 2 — Reports Model Dropdown Shows All Models

The Reports Model dropdown in the admin page's Agent Mode tab showed all 8 agent mode models (GPT, Gemini, Claude) when it should only show models suitable for report generation.

### Root Cause

The `<Select>` at `AdminDashboard.tsx:7199` used `supportedModels` (from `/api/agent-mode/public/llm-models`) which returns all models in `llmModels`. This was always the case since commit `e324fb8f` (Jan 13), but became worse as models were added:
- Jan 13: 4 models → Feb 20: 8 models (every new model automatically appeared)

### Fix

- Added `getReportsModelOptions()` to `agentModeService.ts` — filters `llmModels` to `anthropic.*` keys only
- Added `GET /api/agent-mode/public/reports-model-options` endpoint
- Updated `AdminDashboard.tsx` to load and use the filtered list for the Reports Model dropdown (with fallback to `supportedModels` if endpoint fails)

---

# February 23, 2026: Updated User Guide — ClickUp & Google Drive Documentation

Added sections to the user-facing guide (Notion) documenting the ClickUp Knowledge Base integration and Google Drive Shared Folders integration. Covers setup instructions, agent capabilities, supported file types, and security.

---

# February 23, 2026: Enabled Branch Protection on Main

Neither `AgentWebPro/agentweb` nor `AgentWebPro/agentweb-customer-portal` had branch protection on `main`. Enabled protection on both repos via GitHub API with: strict status checks, force pushes blocked, branch deletion blocked, and enforce admins enabled. Required PR reviews was initially set to 1 but later removed.

**Verification:** After each change, read back the protection settings via `gh api repos/{owner}/{repo}/branches/main/protection` and confirmed `protected: true`, correct rule values, and `enforce_admins.enabled: true`. Also confirmed `required_pull_request_reviews` was absent from the response after removing the review requirement.

---

# February 21, 2026: Agent Mode — Dropped Assistant Messages (Aaron's Session)

## Problem
Production session `ec70e7f2-d42b-46df-a390-86c79879cfd5` (user Aaron, Claude Opus 4.6) failed with 400 errors after ~37 messages. All LLM models returned Bad Request.

## Root Cause
The assistant message between DB indices 22 (user "yes.") and 23 (tool result) was missing, creating an invalid user→tool sequence. Two orphaned `tool_call_id`s (`tooluse_s5lgU4Vkm2yK65qRQiodQ2` for `update_brand_guidelines`, `tooluse_ufMCSFsi6MNxI7pZByZr1T` for `update_market_strategy`) had no matching assistant message.

**Bug 1 — Stale `initialMessageCount`:** `generateMarketingResponse` captures `initialMessageCount = messages.length` once, then uses `messages.slice(initialMessageCount)` at the end to extract response messages. When `install_skills` fires mid-response, `updateConversationContext` splices context messages at the front of the array (net ±1 length change), but `initialMessageCount` was never adjusted. A net -1 (e.g., Available Skills removed, not re-added) causes the slice to skip the first assistant message.

**Bug 2 — Silent batchWrite drops:** `addMessagesToMessagesTable` ignored `UnprocessedItems` from DynamoDB `batchWrite`, silently losing throttled writes.

## Fix (PR #540)
1. Adjust `initialMessageCount += delta` after each `updateConversationContext` call
2. Retry `UnprocessedItems` with exponential backoff (up to 3 retries)

## Production Repair
After deploying the fix, the session still crashed because the corrupted data remained. Ran `/tmp/repair-session.py` to insert a synthetic assistant message at index 23 (with the two orphaned `tool_call_id`s) and shifted all subsequent messages up by 1. Session is now functional.

## Copied Session in Dev
Session was copied to dev tables (`Dev-AW-ChatSessions`, `Dev-AW-ChatMessages`) with userId `6c2ef3ca-c9fa-432e-b510-85127a0752f4` for testing. The dev copy was NOT repaired (same corrupted data as prod pre-repair).

**TODO: Delete the copied session from dev tables.**

---

# February 18, 2026: Runaway ts-node-dev Processes Overheating Machine

Two `ts-node-dev` processes (PIDs 70909, 70910) from the `agentweb` clone were stuck at 100% CPU each for ~10 hours, consuming ~200% CPU total. They were running `server.ts` via `ts-node-dev` and had accumulated 345+ minutes of CPU time. Regular `kill` was ignored; required `kill -9` to terminate. Machine cooled down immediately after.

**Lesson:** When running `npm run dev` in multiple repo clones, check for orphaned `ts-node-dev` processes if the machine gets hot. Use `ps aux | sort -k3 -rn | head -10` to find CPU hogs quickly.

# February 18, 2026: Subdomain Landing Page Setup for Haven (usehaven.ai)

## Approach
Use a CNAME record so we manage the subdomain on Vercel while the client's primary DNS stays untouched. No Nameserver access needed.

## Steps

1. **Add subdomain in Vercel**: Project Settings > Domains > add `start.usehaven.ai`. Vercel will show "Invalid Configuration" until DNS propagates.

2. **Client DNS request** — ask their IT/DNS admin to add one record:
   - **Type:** CNAME
   - **Name (Host):** `start`
   - **Value (Points to):** `ca0c21bca6304a7a.vercel-dns-016.com.`
   - **TTL:** 3600 (or default)

3. **SSL is automatic**: once the CNAME resolves to Vercel, they auto-provision a Let's Encrypt certificate and handle renewal every 90 days. No action needed.

## Creating a Vercel Project Synced to AgentWebPro Org

1. Go to [vercel.com/new](https://vercel.com/new)
2. Under "Import Git Repository", select the **AgentWebPro** GitHub org from the dropdown
3. Find and import the target repo (e.g. `haven-landing`)
4. Configure build settings (framework preset, build command, output directory) and environment variables as needed
5. Click **Deploy**

The project will now auto-deploy on every push to the default branch. To add the custom subdomain, go to Project Settings > Domains and follow the steps above.

**Make PR preview URLs public**: Project Settings > Deployment Protection > disable Vercel Authentication.


# February 18, 2026: Google Drive Integration — MCP vs Direct API

## Investigation
Explored options for integrating Google Drive into the knowledge base:

1. **Anthropic's `@anthropic-ai/google-drive-mcp`** — archived, no longer maintained
2. **Google Workspace MCP server** ([gemini-cli-extensions/workspace](https://github.com/gemini-cli-extensions/workspace)) — found via Google's official MCP list at https://github.com/Google/mcp
   - Provides Drive, Docs, Sheets, Slides, Calendar, Gmail, and Chat access
   - Uses OAuth with a built-in client ID — authenticates as a real Google user via browser login
   - **Incompatible with service account approach**: the admin-configured "shared folders" model requires a service account that has access to specific folders shared with it. The Workspace MCP server authenticates as the end user, so scoping access to admin-designated folders doesn't work.
   - Also requires an interactive browser session on first auth, which doesn't work headlessly on the agent engine
3. **`googleapis/gcloud-mcp`** — only covers GCP infrastructure (gcloud CLI, observability, Cloud Storage buckets), not Google Drive

## Decision
Integrate with the Google Drive API directly using a service account rather than relying on an MCP server. This allows:
- Admin configures folder IDs shared with the service account → stored on the user record
- Backend reads files from those folders via the Drive API using service account credentials
- No interactive browser login needed — works headlessly on the agent engine
- Access is scoped to only the folders explicitly shared by the admin

The Google Workspace MCP server can be reconsidered in the future if per-user OAuth MCP sessions are supported (see Feb 12 ClickUp investigation for similar pattern), or if a service-account-compatible Drive MCP server becomes available.

## Current State
- Admin endpoint and UI for configuring shared folder IDs on user records: done
- Customer portal Knowledge Base page shows configured folders with Drive links: done
- Direct Drive API integration for listing/reading files: TODO


# February 17, 2026: Foundation Tools Blocked by Subscription Filtering

## Problem
Scheduled chats failing with "required function calls are not allowed by your subscription" for `search_web` and other foundation tools. Multiple customer error emails sent. Additionally, foundation tools were hidden from the Skills config page and the customer-portal scheduled chat config, making them impossible to assign or select.

## Root Cause
Foundation tools (`search_web`, `read_file_content`, etc.) were never added to the allowed list returned by `getAllowedFunctionCalls()` in `subscriptionService.ts`. Three places were affected:
1. **Scheduled chat pre-flight check** (`agentModeController.ts:744`) — rejected foundation tools as disallowed
2. **`/api/agent-mode/function-calls` endpoint** — `filterFunctionCalls` stripped foundation tools for non-admin users, hiding them from customer-portal scheduled chat config
3. **Skills page** (`Skills.tsx`) — `?forSkillConfig=true` query param triggered a backend filter excluding foundation tools, preventing them from being assigned to skills

Bug introduced Dec 14, 2025 (`5bc0ad80`) but only surfaced after Feb 14, 2026 (`90005233`) when skills-based subscriptions replaced wildcard subscriptions.

## Fix
1. Scheduled chat check: filter out foundation tools from the disallowed list using `agentModeService.getFoundationToolNames()`
2. `getAvailableFunctionCalls` endpoint: inject foundation tools into the allowed list before filtering for non-admin users
3. Removed the `forSkillConfig` backend filter and frontend query param so all tools (including foundation) appear on the Skills page

Backend 27.6.4, partner-portal 12.7.2. Unit tests updated.


# February 16, 2026: Scheduled Chat Silent Failure Bug

## Problem
Session `097840bc-7338-4a09-8c90-bf112230e17b` ("What's Up with AI Daily") completed steps 1–4 of its work plan but step 5 ("Publish to LinkedIn") never executed. No error was recorded — messages array was empty, no run result saved, no email sent.

## Root Cause
In `agentModeController.ts`, the `runScheduledChat()` promise's `.catch()` handler (line ~3449) only called `console.error`. It never saved a failure `runResult` to DynamoDB or sent an error notification email. Runtime crashes (LLM timeouts, network errors) were silently lost.

## Fix
Added to the `.catch()` block:
1. Save a failure `runResult` via `scheduleDb.addRunResult()` so failures are visible in the UI
2. Send error notification email to configured recipients

Backend version bumped to 27.5.3. Unit test added to cover the new behavior.


# February 12, 2026: ClickUp Integration via MCP

## Investigation
- ClickUp provides a remote MCP server at `https://mcp.clickup.com/mcp` (OAuth 2.1, read-only scope)
- Supports 20+ tools: search, tasks, comments, time tracking, workspace hierarchy, members, chat, docs
- AgentWeb already has external MCP client infrastructure (`mcpClientService.ts`) — plan is to connect to ClickUp's MCP server directly with per-user OAuth tokens
- Main gap: current MCP client uses a single shared token per server; need to extend it to support per-user OAuth connections

## Approach
- Option A (chosen): Connect to ClickUp's remote MCP server directly, inheriting all their tools automatically
- Add ClickUp as a connected account type with OAuth flow
- Extend `mcpClientService` to support per-user MCP sessions

## Status
- Submitted ClickUp MCP Server Allowlist Request Form for redirect URIs:
  - `https://api.agentweb.pro/api/auth/clickup/callback` (Production)
  - `https://api-stage.agentweb.pro/api/auth/clickup/callback` (Staging)
  - `http://localhost:3001/api/auth/clickup/callback` (Development)
- Waiting for ClickUp approval before proceeding with implementation


# February 12, 2026: PixelFlow Form Tracking Audit — start.waldium.com

## Pages Checked
- `https://start.waldium.com/` (v1)
- `https://start.waldium.com/v2`

## Result: Form submission NOT tracked on either page

**Base script**: Installed correctly on both pages (same API key, site ID, endpoint).

**Missing event classes** (required per [PixelFlow docs](https://docs.pixelflow.so/articles/event-classes-on-html-websites-4c49z)):

| Element | Required Class | Status |
|---|---|---|
| Form container | `info-frm-cntr-pf` | Missing |
| Submit button | `action-btn-lead-011-pf` | Missing |
| Email input | `info-cust-em-pf` | Missing |

Both pages share the same `LeadForm` React component. Adding the three classes to that component will fix both pages.

# February 11, 2026: Staging Backend Down (Agentweb-backend-env-1)

## Problem
Staging EB environment `Agentweb-backend-env-1` was Severe/Red. Deployment of `backend_v26.6.1-staging-pr455` repeatedly failed with command timeout on instance `i-0645dba745fc59889`.

## Investigation
- Instance EC2 system checks passed (running, reachable) but EB agent was completely unresponsive
- All EB commands timed out: deployments, log retrieval, restart — nothing got through
- The first deployment of the version at 07:00 UTC succeeded, but a subsequent redeploy at 08:36 UTC hung and the instance never recovered
- 4 consecutive deployment attempts all timed out (600s command timeout)
- Root cause: `t3.small` (2GB RAM) exhausted memory — `npm install` during deployment + Node.js app exceeded available resources, freezing the EB agent

## Resolution
1. Rebooted the instance via EC2 Console — environment recovered to healthy
2. Upgraded instance types from `t3.small` to `t3.medium` / `t3.large` to prevent recurrence
3. Configuration update completed successfully, environment Green/Ok

# February 10, 2026: CRM Web Enrichment Production Failure Investigation (v26.2.0)

## Investigation Summary
- Environment checked: `Agentweb-backend-env-prod-3` (AWS Elastic Beanstalk, `us-west-2`)
- Logs inspected from full bundle and tail logs
- Main failing workflow: `POST /api/crm/lists/:listId/leads/enrich-web?mode=enrich`

## Key Findings
- Primary failure is Google Custom Search quota/rate limiting:
  - `Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'`
  - Observed repeatedly in `web.stdout.log` during enrich runs.
  - Example lines:
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:285`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:45596`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:46733`
- Nginx upstream timeout occurred for the enrich endpoint:
  - `/tmp/eb-prod3-bundle/var/log/nginx/error.log:247`
  - `upstream timed out ... POST /api/crm/lists/.../leads/enrich-web?mode=enrich`
- Secondary issue: occasional LLM JSON parsing failures:
  - `LLMService: Error generating content: SyntaxError...`
  - Examples:
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:45`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:45252`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:46165`
- `connect() failed (111: Connection refused)` entries align with deployment restarts and are not the main enrich failure cause.

## Impact
- Enrichment batch jobs report many failed leads due to `searchWeb` quota errors.
- Some enrich requests run long enough to hit upstream timeout.
- JSON parse failures reduce successful enrichments further.

## TODO (Feb 10, 2026)
- [ ] Add server-side rate limiting and retry/backoff for `searchWeb` (respect Google per-minute quota).
- [ ] Reduce effective enrichment search concurrency in production (current burst is too high).
- [ ] Move enrich processing to async job execution with progress polling to avoid long blocking HTTP request timeouts.
- [ ] Add early circuit-breaker behavior when quota errors spike (fail fast with clear status instead of repeated retries).
- [ ] Harden JSON extraction path:
  - [ ] enforce strict JSON response mode/instructions
  - [ ] keep retry with stricter prompt
  - [ ] add safe fallback parse guardrails
- [ ] Add metrics and alerts:
  - [ ] quota error count
  - [ ] enrich timeout count
  - [ ] per-batch success/fail rate
- [ ] Document operational limits for enrichment batch size and recommended concurrency.

# February 08, 2026: MCP Session Concurrency Fix (v25.9.0)

## Problem
Scheduled chats failing with "Bad Request: No valid session ID provided" errors. Multiple concurrent chat sessions in the same worker process were sharing a single MCP client connection, causing session ID conflicts.

## Root Cause
- Worker process creates ONE AgentModeService with ONE McpClientService
- All concurrent chat sessions used the SAME MCP client with SAME session ID
- When multiple chats ran simultaneously, MCP server returned "has session: false"
- Production logs showed: `MCP session: abf29003-1882-423c-ba87-57ee2c9e7749, chat sessionId: 9816f8e4...` but `has session: false`

## The Fix
Implemented session-based client pooling in `backend/src/mcp/client/mcpClientService.ts`:
- Added `sessionClientPools: Map<chatSessionId, ClientPool>` to isolate clients per chat session
- Created `getSessionClient(serverName, chatSessionId)` method - each chat gets its own MCP client
- Modified tool execution to use `getSessionClient()` instead of shared client
- Added automatic cleanup of stale session pools (1 hour timeout, configurable via `MCP_CLIENT_SESSION_TIMEOUT_MS`)
- Added `releaseSessionClients(chatSessionId)` for manual cleanup

## Changes
**Files modified:**
- `backend/src/mcp/client/mcpClientService.ts` (~150 lines added)
- `backend/src/__tests__/mcp.mcpClientService.test.ts` (6 new tests)
- `backend/src/scripts/test-mcp-session-isolation.ts` (test script)
- `backend/src/docs/user-release.ts` (Feb 08 entry)
- `backend/package.json` (version bump to 25.9.0)

**Key change in tool execution:**
```typescript
// Before: All sessions share same client
execute: async (args, context) => {
  const result = await client.callTool(...);  // ← Shared
}

// After: Each session gets its own client
execute: async (args, context) => {
  const sessionClient = await this.getSessionClient(name, context.sessionId);
  const result = await sessionClient.callTool(...);  // ← Isolated
}
```

## Testing
Run verification test (10 concurrent sessions):
```bash
cd backend
npx ts-node src/scripts/test-mcp-session-isolation.ts
```

Expected output:
```
✓ Result: 10/10 unique MCP sessions
✓ Session creation time: ~595ms
✓ Active session pools: 10
✓ Total MCP clients created: 10 (10 sessions × 1 servers)
✓ SUCCESS: Each chat session has isolated MCP client
```

All unit tests pass:
```bash
npm test
# Test Suites: 185 passed, 185 total
# Tests:       2226 passed, 2226 total
```

## Performance & Safety
**Connection overhead with 10 concurrent sessions:**
- Before: 3 MCP connections (shared, broken)
- After: 30 MCP connections (10 sessions × 3 servers)
- Creation time: ~600ms for 10 session pools
- Memory: ~50-100MB additional overhead
- ✅ Acceptable for Node.js (can handle 100+ connections easily)

**Memory safety:**
- Tool implementations are stateless (async functions)
- Each session has isolated MCP client pool with unique session IDs
- Shared state is minimal (read-only configs, safe caches)
- No threading issues (Node.js async model)
- All data passed as parameters (no mutable globals)

**Scalability:**
- Works well with 2-20 concurrent sessions
- If >50 concurrent chats needed, consider worker pool architecture

## Deployment Verification
After deployment, monitor for:
- `[MCP-SESSION] Creating new client pool for session: {id}` (new logs)
- `[MCP-SESSION] Connected to {server} with MCP session ID: {mcpId} for chat session: {chatId}` (new logs)
- No "has session: false" errors (old bug eliminated)
- Connection count: `netstat -an | grep :3001 | wc -l`

# February 07, 2026: MCP Session ID Issue in Worker Process

## Problem
Production scheduled chats and agent mode tool calls were failing with error:
```
StreamableHTTPError: Streamable HTTP error: Error POSTing to endpoint:
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"},"id":null}
```

## Investigation Timeline

### Symptoms
- Production backend (v25.6.0) on AWS Elastic Beanstalk experiencing multiple failures
- Errors occurred at 16:23:30 UTC and 16:25:28 UTC on Feb 7, 2026
- Affected tools: `read_brand_guidelines`, `read_market_strategy`, `search_knowledge_base`, `create_work_plan`
- All errors originated from `[Worker]` process, not main backend

### Root Cause
The **Worker process** (generateMarketingResponseWorker.ts) creates its own AgentModeService instance with an independent MCP client. The StreamableHTTPClientTransport was not properly establishing the MCP session before tool calls were made:

1. Worker initializes and creates MCP client
2. Client calls `connect(transport)`
3. Connection completes but session handshake may not be fully established
4. Tool calls are made immediately without valid `mcp-session-id` header
5. MCP server rejects requests with error code -32000

### The Fix
Added session validation in `backend/src/mcp/client/mcpClientService.ts`:
- Wait 100ms after connection for session initialization to complete
- Validate that `transport.sessionId` is set before proceeding
- Throw error if session ID is not established
- Added comprehensive logging for debugging

### Architecture Notes
- Main backend has its own MCP client with independent session
- Worker process has a separate MCP client with its own session
- Both connect to the internal MCP server at `http://localhost:PORT/mcp/server`
- Sessions timeout after 1 hour of inactivity (configurable via `MCP_SESSION_TIMEOUT_MS`)
- Session cleanup runs every hour (configurable via `MCP_CLEANUP_INTERVAL_MS`)

### Production Deployment Requirements
After this fix, deploy to production with version bump to include:
- Session validation logic
- Enhanced debug logging (`[MCP-DEBUG]`, `[MCP-SERVER-DEBUG]`, `[Worker-DEBUG]`)
- Session ID tracking throughout the tool call lifecycle

### Testing
Local testing showed the fix working correctly:
- Worker MCP session established successfully
- Tool calls (`read_brand_guidelines`, `create_work_plan`) executed without errors
- Session ID properly included in all HTTP requests

# Continue with Google not working in dev
It could be due to auth related code was changed and the change would require restart `npm run dev` in order for the Google Login to work again.

# prod deployment on AWS Beanstalk
June 03, 2025: a deployment to backend failed and it failed to revert back to previous version. Restarting the app server and rebuilt the environemnt not worked. To resolve the issue, we had to clone the environment and then pointed the dns record in route 53 to the new environment.

June 04, 2025: another outage of the backend. To resolve the issue and improve reliability, updated the environment to use t3-small instead of t3-micro as first option and t3-medium as second option. It was t3-micro then t3-small.

June 16, 2025:
# Known issues of Gemini model with browser use
Gemini models cannot work with the BaseModel argument with function call. Also it has a strange issue that require minimum 1 argument. We needed to add patch to use simpler argument for gemini models.

June 19, 2025
The latest version of browser-use (0.2.7) has an issue of using the same persistent storage for session data which mixed the cookie files from different users. 

June 21, 2025
When restoring a previous good version of browser-use, an issue about old_history table or index crash arised. It was initially suspected to be issue with browser use or playwright but after several round of testings the issue was with the memory dependency of browser use. Uninstall the component solved the issue as this is not a hard dependency:
`pip uninstall -y mem0ai`
To reinstall it, run
`pip install "browser-use[memory]"`
# Update September 24, 2025: got the error again but realized we are using python3 at dev which seems not an issue until Rui's MacBook Pro accidentally crashed and probably crashed the python3 install. The issue has been fixed with a reinstall of all dependencies with requirements.txt and playwright reinstall. No prod change should be made. It was purely a dev issue.
To fix browser-use version - 
pip install "browser-use[memory]==0.1.48"
Force to install on dev
python3 -m pip install "browser-use[memory]==0.1.48" --break-system-packages
python3 -m pip install -r requirements.txt --break-system-packages
python3 -m playwright install chromium
## Test playwright afterwards
python3 -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); browser = p.chromium.launch(); print('✅ Chromium browser launched successfully'); browser.close(); p.stop()"

Issue with reverted PRs: when there are reverted PRs, there is risk that changes may mess up, possibly due to accumulated changes are too many that github seems may start truncate. We encountered such issue when deploying the data analysis PR. A resolution was to start clean which causes much less confusion.

July 28, 2025
# DynamoDB Index Management

## Adding UserIdIndex to TaskExecutions Table

When deploying the Images feature, you may encounter an error: `ValidationException: The table does not have the specified index: UserIdIndex`. This happens because the TaskExecutions table is missing the UserIdIndex that's required for the `getAllTaskExecutionsByUserId` method.

### Manual Fix via AWS Management Console

1. **Access DynamoDB Console**
   - Go to AWS Management Console
   - Navigate to DynamoDB service
   - Click on "Tables" in the left sidebar

2. **Select the TaskExecutions Table**
   - Find the table named `Dev-AW-TaskExecutions` (development) or `AW-TaskExecutions` (production)
   - Click on the table name to open its details

3. **Add the Index**
   - In the table details page, scroll down to the "Indexes" section
   - Click "Create index" button
   - Fill in the following details:
     - **Partition key**: `userId` (String)
     - **Sort key**: `startTime` (String)
     - **Index name**: `UserIdIndex`
     - **Index capacity**: Copy from base table
     - **Attribute project**: All
   - Click "Create index"

4. **Wait for Index Creation**
   - The index will show "Creating" status initially
   - This process can take several minutes depending on table size
   - Monitor the status until it changes to "Active"

5. **Verify the Index**
   - Once the index is active, you can verify it by:
     - Going back to the table's "Indexes" section
     - Confirming `UserIdIndex` shows "Active" status
     - The index should have `userId` as partition key and `startTime` as sort key

### Prevention for Future Deployments

The `create-tables.ts` script has been updated to include the `UserIdIndex` by default for new deployments. This ensures that future table creations will automatically include the required index.

August 07, 2025
testing with gpt-5 models: Azure does offer gpt-5-chat but has insufficient quota error; OpenAI offers all models but gpt-5 require removal of temperature but even after it is removed, it is not responding to extract-content call. gpt-5-chat-latest has error about tools not supported

August 25, 2025
deploying Growth Genius: creating a beanstalk service could easily got stuck because it would just fail: create a new environment failed, copy from customer portal environment and then deploy the genius app failed. It may not be able to recover from failure. be able to fetch the log or not makes a difference. For example, the first time I was not able to fetch the log, which indicates a different problem when next time I was able to fetch it which showed a different problem, though from the deployment log they were like same failure.

August 28, 2025
supporting multiple image input for openai model require using latest openai model
> pip install --upgrade openai

We have issues creating new environment in elastic beanstalk. We tested using AWSEBSSecurityGroup for EC2 security groups because the service instances (EC2) needs to communicate with the load balancer but it still not working.

Sept. 14, 2025
Debug with full log from Elastic Beanstalk: web.stdout.log has the app log.

October 10, 2025
## DynamoDB: Add UserIdIndex to AW-TaskSchedules

If you need to add the `UserIdIndex` GSI to the `AW-TaskSchedules` table (used by Scheduled Chats), use these commands.

Prerequisites:
- AWS CLI configured for the target account/region (`aws configure`)
- Region: `us-west-2` (override with `--region` if different)

Add index in Development (Dev- prefixed table, provisioned capacity):

```bash
aws dynamodb update-table \
  --table-name Dev-AW-TaskSchedules \
  --attribute-definitions AttributeName=userId,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"UserIdIndex","KeySchema":[{"AttributeName":"userId","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Add index in Production (no prefix, PAY_PER_REQUEST billing mode):

```bash
aws dynamodb update-table \
  --table-name AW-TaskSchedules \
  --attribute-definitions AttributeName=userId,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"UserIdIndex","KeySchema":[{"AttributeName":"userId","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Verify index status (repeat until `IndexStatus` is `ACTIVE`):

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-TaskSchedules \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`UserIdIndex`].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

List all GSIs on the table:

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-TaskSchedules \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

Notes:
- GSI creation is asynchronous; queries against `UserIdIndex` work after status becomes `ACTIVE`.
- Replace `Dev-AW-TaskSchedules` with `AW-TaskSchedules` for production.

## DynamoDB: Add EmailDomainLeadEmailIndex to AW-EmailEvents

If you need to add the `EmailDomainLeadEmailIndex` composite GSI to the `AW-EmailEvents` table (for efficient lead engagement queries), use these commands.

Prerequisites:
- AWS CLI configured for the target account/region (`aws configure`)
- Region: `us-west-2` (override with `--region` if different)

Add index in Development (Dev- prefixed table):

```bash
aws dynamodb update-table \
  --table-name Dev-AW-EmailEvents \
  --attribute-definitions AttributeName=emailDomain,AttributeType=S AttributeName=leadEmail,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"EmailDomainLeadEmailIndex","KeySchema":[{"AttributeName":"emailDomain","KeyType":"HASH"},{"AttributeName":"leadEmail","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"},"ProvisionedThroughput":{"ReadCapacityUnits":5,"WriteCapacityUnits":5}}}]' \
  --region us-west-2
```

Add index in Production (no prefix):

```bash
aws dynamodb update-table \
  --table-name AW-EmailEvents \
  --attribute-definitions AttributeName=emailDomain,AttributeType=S AttributeName=leadEmail,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"EmailDomainLeadEmailIndex","KeySchema":[{"AttributeName":"emailDomain","KeyType":"HASH"},{"AttributeName":"leadEmail","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Verify index status (repeat until `IndexStatus` is `ACTIVE`):

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-EmailEvents \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`EmailDomainLeadEmailIndex`].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

List all GSIs on the table:

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-EmailEvents \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

After the index is active, run the repair-tables script to update the table schema:

```bash
cd backend
NODE_ENV=development npx ts-node src/scripts/@repair-tables.ts
```

For production, use:
```bash
cd backend
NODE_ENV=production npx ts-node src/scripts/@repair-tables.ts
```

## DynamoDB: Add AdminUpdatedAtIndex to AW-ChatSessions

If you need to add the `AdminUpdatedAtIndex` GSI to the `AW-ChatSessions` table (for admin chat history pagination), use these commands.

Prerequisites:
- AWS CLI configured for the target account/region (`aws configure`)
- Region: `us-west-2` (override with `--region` if different)

Add index in Development (Dev- prefixed table):

```bash
aws dynamodb update-table \
  --table-name Dev-AW-ChatSessions \
  --attribute-definitions AttributeName=adminListPartition,AttributeType=S AttributeName=updatedAt,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"AdminUpdatedAtIndex","KeySchema":[{"AttributeName":"adminListPartition","KeyType":"HASH"},{"AttributeName":"updatedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"},"ProvisionedThroughput":{"ReadCapacityUnits":5,"WriteCapacityUnits":5}}}]' \
  --region us-west-2
```

Add index in Production (no prefix):

```bash
aws dynamodb update-table \
  --table-name AW-ChatSessions \
  --attribute-definitions AttributeName=adminListPartition,AttributeType=S AttributeName=updatedAt,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"AdminUpdatedAtIndex","KeySchema":[{"AttributeName":"adminListPartition","KeyType":"HASH"},{"AttributeName":"updatedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Verify index status (repeat until `IndexStatus` is `ACTIVE`):

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-ChatSessions \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`AdminUpdatedAtIndex`].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

Notes:
- Do not specify `ProvisionedThroughput` when the table billing mode is `PAY_PER_REQUEST` (production).
- After the index is active, backfill `adminListPartition` for existing items so they show up in the index.

Backfill in Development:

```bash
cd backend
NODE_ENV=development npx ts-node src/scripts/repair-chat-sessions-admin-index.ts
```

Backfill in Production:

```bash
cd backend
NODE_ENV=production npx ts-node src/scripts/repair-chat-sessions-admin-index.ts
```

## Port Management

### Finding and Killing Processes on Port 3001

When you need to free up port 3001 (commonly used by development servers), use these commands:

1. **Find processes using port 3001:**
   ```bash
   lsof -ti:3001
   ```
   This will return the Process IDs (PIDs) of all processes using port 3001.

2. **Kill the processes:**
   ```bash
   kill -9 <PID1> <PID2> ...
   ```
   Replace `<PID1>`, `<PID2>`, etc. with the actual PIDs returned from the previous command.

## Memory System Issues (October 14, 2025)

### Azure OpenAI Models Failing with Database Errors

If Azure OpenAI models (gpt-4o, gpt-4.1) fail with errors like:
- `"there is already another table or index with this name: old_history"`
- `"no such column: prev_value"`

This indicates corrupted memory database files in the mem0 system used by browser-use.

### Quick Fix

Run the memory cleanup script:
```bash
cd agent-engine
conda activate agent-engine
python memory_fix_v2.py
```

This will:
- Clean up all corrupted mem0 database files
- Configure memory system to use in-memory database
- Resolve database schema issues

### Manual Cleanup (if script not available)

```bash
# Remove all mem0 directories
rm -rf /tmp/mem0_*
rm -rf ~/.mem0

# Set environment variables
export MEM0_DATABASE_URL="sqlite:///:memory:"
export MEM0_BACKEND="sqlite"
```

### Prevention

The memory fix only needs to be applied once when the issue occurs. It doesn't need to run automatically on every startup.

### Alternative: Disable Memory Entirely

If memory issues persist, you can disable the memory system:
```bash
export MEM0_DISABLED="true"
export BROWSER_USE_MEMORY_DISABLED="true"
```

### Files Created for Reference

- `agent-engine/memory_fix_v2.py` - Enhanced memory fix script
- `agent-engine/tests/test_memory_fix_v2.py` - Comprehensive tests
- `agent-engine/MEMORY_FIX_V2_SUMMARY.md` - Detailed documentation

November 23, 2025
There was two outages in recent three days. To debug, I downloaded the full log files and then asked Cursor to look into and she found that Emma was running workflows for too long and thus blocked health checks from AWS which then got Elastic Beanstalk to go unhealthy and go crazy to mess up.

November 24, 2025
Added oncall alert on Agentweb-backend-env-prod-3 env as it is currently the prod backend and most risky outage.

November 29, 2025
## Azure Anthropic Foundry API Hanging Issue with Long Prompts

The Azure Anthropic Foundry API (via `@anthropic-ai/foundry-sdk`) experiences hanging behavior when processing long prompts, particularly when combined with large `max_tokens` values. Testing revealed that prompts exceeding approximately 500 characters can cause the API to hang indefinitely, with requests timing out after 30-90 seconds or never completing. This issue appears to be a limitation of the Azure Anthropic Foundry service itself rather than a bug in the SDK libraries, as both `@anthropic-ai/foundry-sdk` (v0.2.0) and `@anthropic-ai/sdk` (v0.71.0) are at their latest versions.

Because of this, it is hard to use Anthropic LLM via Azure.

December 02, 2025
VEO 3.1 integration doc: https://ai.google.dev/gemini-api/docs/video?example=dialogue#javascript_2

December 06, 2025
## CVE-2025-55182 (React2Shell) Security Check

### Assessment: Project is NOT directly impacted

**Status**: ✅ Not vulnerable

### Findings

1. **Frontend Applications (Safe)**:
   - `customer-portal`: React 18.3.1 ✅
   - `partner-portal`: React 18.3.1 ✅
   - `growth-chat`: React 18.3.1 ✅
   - All frontend applications use React 18.x, which is NOT affected by CVE-2025-55182

2. **Backend (Low Risk)**:
   - Has React 19.0.0 installed as a transitive dependency via `reactflow` and `@reactflow/core`
   - **NOT using React Server Components (RSC)** - no `react-server-dom-*` packages found
   - No Next.js or RSC frameworks detected
   - Backend is a standard Express.js server, not using RSC functionality

### Why It's Not Vulnerable

CVE-2025-55182 (React2Shell) is a critical pre-authentication remote code execution (RCE) vulnerability that specifically affects:
- React 19.0.0, 19.1.0, 19.1.1, and 19.2.0
- **React Server Components (RSC)** functionality
- Frameworks using RSC (Next.js 15.x/16.x, React Router, Waku, Parcel RSC, Vite RSC)

While the backend has React 19.0.0 installed, it does **not** use React Server Components, so the vulnerability does not apply.

### Recommendations

1. **Monitor for Future Changes**:
   - If you plan to add React Server Components or upgrade to Next.js 15.x/16.x, ensure you use patched React versions:
     - React 19.0.1, 19.1.2, or 19.2.1+
     - Next.js 15.0.5+, 15.1.9+, 15.2.6+, 15.3.6+, 15.4.8+, 15.5.7+, or 16.0.7+

2. **Optional Cleanup**:
   - Consider removing React 19.0.0 from backend dependencies if `reactflow` is not actively used
   - Or pin `reactflow` to a version that doesn't require React 19

3. **Regular Security Audits**:
   - Run `npm audit` regularly to check for security vulnerabilities
   - Monitor React and Next.js security advisories

### Verification Commands

To verify React versions in the future:
```bash
# Check frontend React versions
cd customer-portal && npm list react react-dom
cd partner-portal && npm list react react-dom
cd growth-chat && npm list react react-dom

# Check backend React version (if needed)
cd backend && npm list react react-dom
```

### References
- CVE-2025-55182 Scanner: https://cve-2025-55182.com/
- React Security Advisory: https://github.com/facebook/react/security

## Dec 15, 2025
to support pdf file uploads for Knowledge Base, add OCR Parser for PDF file formats so that Vertex AI Search will uses this parser to parse PDF files.

## Dec 23, 2025
After resolving conflicts, we need to use force push to remote. On Github Desktop, instead of clicking on the pull and push button, we should select force push from it because otherwise a pull will happen again which will get the conflicts happen again.

## Dev 30, 2025
If tests fail in PR, we could rerun the step in the PR to see whether it is a random issue. This worked for customer-portal.

## Jan 2, 2026
### LinkedIn Configuration Update
Renamed LinkedIn credential functions and updated secret paths to clarify personal vs. company credentials.

- **Personal Profile Integration**:
  - Dev Secret: `dev/AgentWeb/LinkedIn/Personal`
  - Prod Secret: `prod/AgentWeb/LinkedIn/Personal`

- **Organization/Company Page Integration**:
  - Dev Secret: `dev/AgentWeb/LinkedIn/Company`
  - Prod Secret: `prod/AgentWeb/LinkedIn/Company`

## January 06, 2026
### Scheduled Chat Run History: Optimized Storage to Prevent DynamoDB Size Limits

#### Problem
The `runResults` array stored in `AW-TaskSchedules` table was hitting DynamoDB's 400KB item size limit. The `actualResponse` field (containing the full AI response text) was the primary contributor to item size, often taking 1-20KB per entry.

#### Solution
Instead of storing `actualResponse` in the database, we now:
1. **Exclude `actualResponse` when storing** run results to DynamoDB
2. **Reconstruct `actualResponse` on-demand** from session messages only when needed (when sending emails)
3. **Keep `actualResponse` in error cases** where there's no session to reconstruct from

#### Implementation Details
- Helper function `getActualResponseFromSession()` extracts the last assistant message from the session
- `actualResponse` is removed from the result object before calling `addRunResult()`
- Reconstruction happens in:
  - `sendScheduledChatTestEmail()` - when user clicks "Send Email" in Run History
  - `sendDailyDigestEmail()` - when sending daily digest emails

#### Size Estimates

**Per Entry (without `actualResponse`):**
- Base fields: ~530 bytes
  - scheduleId, runId, sessionId (UUIDs): ~120 bytes
  - status, passed, attempt, executionTime: ~30 bytes
  - createdAt (ISO string): ~30 bytes
  - Arrays (keywordMatches, keywordMisses, functionCallMatches, etc.): ~200-400 bytes
  - functionCallDetails object: ~100-500 bytes
- **Average: ~800 bytes per entry**

**Per Entry (with `actualResponse` - old method):**
- Base fields: ~530 bytes
- actualResponse: 1-20KB (average ~3-5KB)
- **Average: ~3,800-6,500 bytes per entry**

**Savings per entry: ~3-5KB**

#### Capacity Estimates

DynamoDB item size limit: **400KB**
- Base schedule data (scheduleName, description, startingMessage, etc.): ~2-5KB
- Available space for runResults: **~395-398KB**

**Old Method (with `actualResponse`):**
- 395KB ÷ 6.5KB (worst case) = **~60 entries**
- 395KB ÷ 3.8KB (average) = **~104 entries**

**New Method (without `actualResponse`):**
- 395KB ÷ 0.8KB = **~490 entries**

**Improvement: ~8x more entries can be stored** (from ~60-100 entries to ~490 entries)

#### Notes
- `actualResponse` is still available when needed (emails) via on-demand reconstruction
- Error cases (no session) still store `actualResponse` since it can't be reconstructed
- Frontend Run History display doesn't need `actualResponse`, so no performance impact on viewing history

Ran repair script to clean up actualResponse
NODE_ENV=production npx ts-node src/scripts/repair-scheduled-chat-run-results.ts 
Repairing TaskSchedules table to remove actualResponse from runResults: {
  environment: 'production',
  region: 'us-west-2',
  tablePrefix: '',
  tableName: 'AW-TaskSchedules'
}
Starting repair process...

(node:82443) NOTE: The AWS SDK for JavaScript (v2) is in maintenance mode.
 SDK releases are limited to address critical bug fixes and security issues only.

Please migrate your code to use AWS SDK for JavaScript (v3).
For more information, check the blog post at https://a.co/cUPnyil
(Use `node --trace-warnings ...` to show where the warning was created)
Processing batch: 14 schedules (Total scanned: 14)
Processing batch: 8 schedules (Total scanned: 22)
  ✓ Updated 10 schedules, cleaned 734 runResults entries so far...
Processing batch: 34 schedules (Total scanned: 56)
  ✓ Updated 20 schedules, cleaned 1066 runResults entries so far...
Processing batch: 20 schedules (Total scanned: 76)
  ✓ Updated 30 schedules, cleaned 1533 runResults entries so far...
Processing batch: 13 schedules (Total scanned: 89)
Processing batch: 19 schedules (Total scanned: 108)
  ✓ Updated 40 schedules, cleaned 2179 runResults entries so far...

==================================================
Repair process completed!
==================================================
Total schedules scanned: 108
Total schedules updated: 43
Total schedules skipped: 65 (no runResults or already cleaned)
Total runResults entries cleaned: 2179
Total errors: 0
==================================================

✅ Repair completed successfully!

## Jan 14 2026
Configured Claude Code and use AWS Bedrock for the LLM: https://code.claude.com/docs/en/amazon-bedrock. In future, we could also use Azure as it starts to offer Claude models but no quota at the moment.

## Jan 29, 2026
Install playwright mcp for claude
claude mcp add playwright -- npx -y @playwright/mcp@latest

## Feb 2, 2026
### Google Analytics Not Receiving Data from app.agentweb.pro

#### Problem
After publishing GTM container updates to add tracking for app.agentweb.pro, no data was appearing in Google Analytics property 489864500. The Product Analytics API endpoint (`/api/seo/product-metrics`) returned zero data for app.agentweb.pro despite tracking being configured.

#### Initial Investigation
- GTM Preview showed events firing (page_view, scroll, user_engagement) ✅
- Network requests showed GA4 events being sent to `server-side-tagging-50006506707.us-central1.run.app/g/collect` ✅
- BUT no data appeared in GA4 Realtime reports or historical data ❌
- Even www.agentweb.pro stopped receiving data on Feb 2 (had data on Feb 1)

#### Root Cause Analysis

**Issue 1: Domain Configuration**
- GA4 data stream was configured with "exact match" for `agentweb.pro`
- This blocked app.agentweb.pro subdomain from being accepted
- **Fix**: Changed domain matching from "exact match" to "contains" with entries:
  - `agentweb.pro`
  - `withsurface.com`
  - `agentwebforms.com`
  - `app.agentweb.pro`

**Issue 2: GTM Tag Configuration (Primary Issue)**
- GTM had two GA4-related tags:
  1. `FB_CONVERSIONS_API-1430870751246428-Web-Tag-GA4_Config` (Type: "Google Tag")
  2. `FB_CONVERSIONS_API-1430870751246428-Web-Tag-GA4_Event` (Type: "Google Analytics: GA4 Event")
- The GA4_Event tag referenced a Google Tag named **"AgentWeb"** that didn't exist
- The GA4_Config tag was named differently and wasn't firing in GTM Preview
- Without the Config tag firing, Event tags had no configuration to send data to

**Issue 3: Incorrect Trigger**
- GA4_Config tag was using "DOM Ready" trigger
- "Google Tag" type must fire on "Initialization - All Pages" to load gtag.js before other tags

#### Debugging Process

1. **Verified tracking firing**: Used browser DevTools to confirm GA4 events in network tab
2. **Checked GA4 real-time data**: No activity showing for app.agentweb.pro
3. **Analyzed GTM Preview**: Found GA4_Config tag in "Tags Not Fired" section
4. **Discovered tag reference mismatch**: GA4_Event looking for "AgentWeb" tag that didn't exist
5. **Tested historical data**: Confirmed all tracking (even www.agentweb.pro) stopped on Feb 2

#### Solution

1. **Renamed GTM Tag**:
   - Changed `FB_CONVERSIONS_API-1430870751246428-Web-Tag-GA4_Config` to `AgentWeb`
   - This allowed GA4_Event tag to find and reference the correct config tag

2. **Fixed Trigger**:
   - Changed AgentWeb tag trigger from "DOM Ready" to **"Initialization - All Pages"**
   - "Google Tag" type must fire early to initialize gtag.js

3. **Updated GA4 Domain Settings**:
   - In GA4 Admin → Data Streams → Configure tag settings
   - Changed domain matching to "contains" instead of "exact match"
   - Added app.agentweb.pro to allowed domains list

4. **Published GTM Container**:
   - Saved all changes
   - Published new container version
   - Verified in GTM Preview that AgentWeb tag now fires at Initialization

#### Verification

**Immediate Results**:
- ✅ GTM Preview shows "AgentWeb" tag firing at Initialization
- ✅ GA4_Event tags firing successfully with configuration
- ✅ GA4 Realtime report shows activity from app.agentweb.pro
- ✅ Page titles like "AgentWeb - Marketing Operations" appearing in real-time data

**Expected Timeline**:
- Real-time data: Available immediately ✅
- Historical data (Product API): 24-48 hours for data to populate
- Full metrics backfill: Up to 72 hours

#### Configuration Details

**GA4 Property**:
- Property ID: `489864500`
- Measurement ID: `G-KKJE0Q33LF`
- Data Stream: "AgentWeb" (https://www.agentweb.pro)

#### Important Note on Localhost Traffic

**Localhost traffic is still sent to Google Analytics but filtered in Customer Portal**:
- Development traffic from `localhost` is currently being sent to GA4 property 489864500
- The backend Product Analytics API (`/api/seo/product-metrics`) filters out localhost traffic using dimension filters:
  ```typescript
  dimensionFilter: {
    andGroup: {
      expressions: [
        { filter: { fieldName: "hostName", stringFilter: { matchType: "CONTAINS", value: user.productDomain } } },
        { notExpression: { filter: { fieldName: "hostName", stringFilter: { matchType: "CONTAINS", value: "localhost" } } } }
      ]
    }
  }
  ```
- **Result**: Customer Portal shows accurate production-only metrics, but Google Analytics UI will show inflated numbers that include localhost traffic
- **Recommendation**: Follow the guide in `GA4_EXCLUDE_LOCALHOST_GUIDE.md` to prevent localhost traffic from reaching GA4 entirely (Method 3 or 4 recommended)

## February 04, 2026

### LinkedIn Import Stuck at 0% - WebSocket Connection Failure

**Symptom**: LinkedIn import feature in CRM page showed progress stuck at 0%, no data imported to database, WebSocket connection errors in browser console showing malformed URL: `ws://https/socket.io/`

**Root Causes**:

1. **Missing nginx WebSocket configuration in production**
   - Elastic Beanstalk's nginx proxy doesn't support WebSocket upgrade by default
   - Socket.IO connections were blocked at the nginx layer
   - Development worked because it connects directly to backend (no nginx proxy)

2. **Incorrect nginx configuration placement**
   - Initial fix placed `websocket.conf` in `.platform/nginx/conf.d/`
   - This directory is for `http` block context (global settings)
   - `location` blocks are NOT allowed in `http` context → deployment failed
   - Correct location: `.platform/nginx/conf.d/elasticbeanstalk/` (for `server` block context)

3. **Frontend Socket.IO URL parsing bug**
   - Code used: `buildApiUrl("").replace("/api", "")`
   - For staging URL `https://api-stage.agentweb.pro/api`:
     - Incorrectly replaced "api" everywhere including in "api-stage"
     - Result: `https://-stage.agentweb.pro` (broken URL)
     - Socket.IO saw malformed URL and created: `ws://https/socket.io/`
   - Fix: Use regex to only remove `/api` at the end: `.replace(/\/api\/?$/, "")`

**Resolution Steps**:

1. **Added WebSocket nginx configuration**:
   ```
   backend/.platform/nginx/conf.d/elasticbeanstalk/websocket.conf
   ```
   - Includes `location /socket.io/` block with WebSocket upgrade headers
   - `proxy_set_header Upgrade $http_upgrade`
   - `proxy_set_header Connection "upgrade"`
   - Extended timeouts for long-running imports (3600s)

2. **Fixed Socket.IO URL parsing** in `customer-portal/src/pages/CRM.tsx`:
   ```typescript
   const apiUrl = buildApiUrl("");
   const socketUrl = apiUrl.replace(/\/api\/?$/, ""); // Only remove /api at END
   ```

**Debugging Process**:

1. **Initial Investigation**:
   - Checked Elastic Beanstalk logs via AWS CLI
   - Required adding IAM permissions for CloudWatch Logs and Beanstalk access
   - Found no `mode=import` requests in nginx access logs (only `mode=preview`)
   - Realized import never started due to WebSocket connection failure

2. **Backend Log Analysis**:
   - Preview requests returned HTTP 200 with valid JSON (~2,185 bytes)
   - Successfully parsed 2,986-5,538 connections and 5,484-7,132 messages
   - No server-side errors logged
   - WebSocket server initialized correctly

3. **Deployment Failures**:
   - First attempt: Used `map` directive in `conf.d/` → failed (wrong context)
   - Second attempt: Used `location` block in `conf.d/` → failed (wrong context)
   - Third attempt: Moved to `conf.d/elasticbeanstalk/` → succeeded

4. **Frontend WebSocket Error**:
   - Browser console showed malformed WebSocket URL
   - Traced to `.replace("/api", "")` matching "api" in hostname
   - Fixed with regex to only match `/api` at end of string

**Key Learnings**:

- **Elastic Beanstalk nginx structure**:
  - `.platform/nginx/conf.d/` → `http` block (no location blocks allowed)
  - `.platform/nginx/conf.d/elasticbeanstalk/` → `server` block (location blocks allowed)
  - Refer to AWS docs: https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/platforms-linux-extend.proxy.html

- **IAM Permissions for Log Access**:
  - Need `AWSElasticBeanstalkReadOnly` policy
  - Need `CloudWatchLogsReadOnlyAccess` policy
  - Can also add `elasticbeanstalk:RetrieveEnvironmentInfo` permission

- **WebSocket Testing**:
  - Always test Socket.IO connections in staging before production
  - Check browser console for WebSocket connection errors
  - Verify correct URL format: `wss://domain.com/socket.io/` not `ws://https/socket.io/`

- **String Replace Gotchas**:
  - Be careful with `.replace()` when URL contains similar substrings
  - Use regex with anchors (`$` for end of string) for precise replacements
  - For staging URLs like `api-stage.agentweb.pro`, simple string replace is dangerous

## Research Session Investigation (2026-03-17)

Investigated session `b34576c1-70f9-40da-a628-6fc8f9a3b129` ("Test: Weekly Competitor News Researcher", user `f958eb3e`, schedule `6588424c`).

**Observation:** On attempt 3 the LLM ignored explicit instructions to perform a deeper re-search, simply repeating the previously generated output instead of running new searches.

**Root cause:** The schedule's `requiredFunctionCalls` includes `search_web`, but `search_web` is not actually required for this schedule — the LLM's research workflow already calls search tools organically. Having `search_web` as a required function causes `runVerifiedChat` to retry when the function hasn't been called yet, and on retries the LLM sees its previous output in the conversation history and repeats it rather than executing fresh searches.

**Mitigation:** Remove `search_web` from the schedule's `requiredFunctionCalls`. The schedule only truly requires `read_market_strategy` to load competitor info. The LLM will still call search tools as part of its natural research flow without needing them enforced as required calls.

**Broader notes:**
- The `runVerifiedChat` retry prompt (lines 583-618 of `agentModeController.ts`) intentionally avoids re-requesting tools that already ran. When all required functions have been called but the work plan isn't complete, it sends generic "complete pending steps" messages. This means retries don't force the LLM to use different search parameters.
- 229 sessions use `perform_deep_research`. Overall 84% succeed at producing blog articles. `gemini-3-pro-preview` has a 23% failure rate vs 1% for `gemini-3.1-pro-preview`.
- 42 sessions show durations >2 hours (stuck/zombie sessions), likely due to long-running deep research polls that don't properly clean up.

## Message Limit & Context Window Investigation (2026-03-19)

### Current State

Agent Mode sessions are capped at **300 messages** (`MAX_MESSAGE_SIZE_PER_SESSION` in `backend/src/config.ts`). Raised from 150 in a previous release.

### Bug Found: 10-User-Message Sliding Window

**`buildMarketingContext()`** (agentModeService.ts:1785) currently slices conversation history to only the **last 10 user messages** + associated assistant/tool responses. This means the LLM is blind to most of the conversation history in any session with more than ~10 exchanges. This is a bug — context from earlier messages is silently dropped.

**Code location:** Lines 1801-1813 in `buildMarketingContext()`:
```
let userCount = 0;
let startIdx = 1;
for (let i = filteredHistory.length - 1; i >= 0; i--) {
  if (filteredHistory[i].role === 'user') {
    userCount++;
    if (userCount === 10) { startIdx = i; break; }
  }
}
const sliced = filteredHistory.slice(startIdx);
```

**Fix:** Remove this sliding window entirely. All messages should be included in context.

### How Context is Built Today

```
1. System prompt
2. Skills context (available + installed skills)
3. Account memory (cross-session facts)
4. Last 10 user messages + their assistant/tool responses  <-- BUG: should be ALL messages
5. Task statuses
6. Work plan (if active)
7. Current user message
   |
trimToolMessagesForContext()  (truncate old tool outputs to 8000 chars)
   |
callLLM()
```

**Key files:**
- `agentModeService.ts:774` — `generateMarketingResponse()` main entry
- `agentModeService.ts:1785` — `buildMarketingContext()` slices to last 10 user msgs
- `agentModeService.ts:12015` — `trimToolMessagesForContext()` truncates old tool results
- `chatbotService.ts:806` — `getMessagesFromMessagesTable()` loads from DynamoDB
- `config.ts:4` — `MAX_MESSAGE_SIZE_PER_SESSION = 300`

### Proposed Solution: Summarization + `query_message_details` Tool

Two complementary mechanisms that together enable **unlimited messages**:

1. **Periodic Summarization:** Every 200 messages, generate a summary using Gemini Flash Lite and inject it as a system-level context message. Original messages are preserved in DB but replaced by summaries in the LLM context.

2. **`query_message_details` Tool:** A foundation tool that lets the LLM retrieve specific details from older messages on-demand. Uses Gemini Flash Lite (~$0.01/query, 1-2s latency) to answer questions against the full message history.

**Why this works:**
- Summaries give the LLM a high-level map of the full conversation
- The tool lets the LLM drill into details when needed (the LLM decides when)
- Gemini Flash Lite has ~1M token context window — can read hundreds of messages cheaply
- No new infrastructure needed — just another tool + cheap LLM call
- Scales infinitely — only summaries accumulate (~500 tokens each)

**Architecture:**
```
Messages 1-200:     [Summary A injected as system message]
Messages 201-400:   [Summary B injected as system message]
Messages 401-600:   [Summary C injected as system message]
Messages 601-700:   [Full detail messages in context]

System prompt says: "Use query_message_details to look up specific details
from earlier in the conversation when needed."

When LLM needs detail -> calls query_message_details("what was the blog URL?")
  -> Gemini Flash Lite reads relevant messages, answers the question
  -> Result returned as tool response
```

**Cost for a 1000-message session:** ~$0.18 extra (4 summaries + ~10 detail queries).

### Implementation Plan

**Phase 1: Core Changes**
1. Remove the 10-user-message sliding window in `buildMarketingContext()`
2. Add `generateConversationSummary()` method using Gemini Flash Lite
3. Add `query_message_details` foundation tool + `handleQueryMessageDetails()` handler
4. Inject summaries into context via `buildMarketingContext(summaries)` parameter
5. Store summaries on session record (`ChatSession.summaries[]`)
6. Add `updateSessionSummaries()` to `ChatbotDB`
7. Raise `MAX_MESSAGE_SIZE_PER_SESSION` to 10,000
8. Update system prompt with "Long Conversation Support" guidance

**Phase 2: Polish**
- Frontend: show "Conversation summarized up to message X" indicator
- Admin controls: summarization interval, enable/disable
- Smart triggers: summarize based on token count, not just message count

### Files to Modify
- `backend/src/config.ts` — raise message limit
- `backend/src/services/agentModeService.ts` — remove window, add summarization, add tool handler, add to foundation tools
- `backend/src/services/chatbotService.ts` — add `summaries` to ChatSession, add `updateSessionSummaries()`
- `backend/src/emma/tools.ts` — register `query_message_details` tool
