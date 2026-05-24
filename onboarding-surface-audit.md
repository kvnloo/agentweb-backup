# Onboarding Surface Audit

**Date:** 2026-05-23  
**Phase:** 1 (no code changes — read-only)  
**Repos scanned:** agentweb/backend/src/, agentweb-customer-portal/src/  
**Auto-proceed check:** last step = clear (`closing` screen), externalization ~280 LOC < 300 threshold → proceeding to Phase 2.

---

## Step Inventory

| Step Name | Component File | Copy Strings | Events Fired | elapsed_ms? | Externalizable? |
|-----------|----------------|--------------|--------------|-------------|-----------------|
| welcome | OnboardingV2.tsx:1823-1868 | 3 | goal_selected | No | Yes |
| brand | OnboardingV2.tsx:1871-1933 | 6 | brand_submitted, brand_skipped | No | Yes |
| paidAdsQuestions | Phase2Questions.tsx | 12 | channel_selected, deviation | No | Yes |
| dataGathering | OnboardingV2.tsx:1993-2143 | 5 | data_connected, data_skipped | No | Yes |
| buildingBrand | OnboardingV2.tsx:2449-2502 | 2 | (none — status polled) | No | No |
| brandReview | BrandReview.tsx (delegated) | 6 | brand_review_*, brandReview_confirmed | No | Yes |
| buildingIcp | OnboardingV2.tsx:2689-2701 | 2 | (none — status polled) | No | No |
| icpReview | BrandReview.tsx | 2 | icpReview_confirmed | No | Yes |
| valuePropReview | BrandReview.tsx | 2 | valuePropReview_confirmed | No | Yes |
| buildingCreativeDir | OnboardingV2.tsx:2706-2720 | 2 | (none — status polled) | No | No |
| buildingAdImage | OnboardingV2.tsx:2724-2738 | 2 | (none — status polled) | No | No |
| buildingAdCopy | OnboardingV2.tsx:2742-2756 | 2 | (none — status polled) | No | No |
| adReveal | Phase4AdReveal.tsx (delegated) | 4 | ads_generated, ads_regenerated | No | Yes |
| channels | OnboardingV2.tsx:2335-2442 | 5 | channel_connected, channels_skipped, **onboarding_completed** | No | Yes |
| outreachIcpReveal | OutreachIcpPick.tsx | 3 | outreach_icp_selected | No | Yes |
| closing (**TERMINAL**) | OnboardingV2.tsx:2916-2951 | 5 | welcome_offer_shown, welcome_offer_outcome | No | Yes |

**Total: ~66 hardcoded user-facing strings across 16 screen types**

---

## Hardcoded Copy by Step

### welcome
- `OnboardingV2.tsx:1828` → `"Hi, I'm Emma."`
- `OnboardingV2.tsx:1838` → `"What would you like to work on?"`
- `OnboardingV2.tsx:1861-1862` → GOALS array (3 cards × 2 strings = 6 strings)

### brand
- `OnboardingV2.tsx:1874` → `"Tell me about your company"`
- `OnboardingV2.tsx:1878-1881` → `"Anything you've already saved — brand guidelines, knowledge base, connected accounts, and content — stays safe."`
- `OnboardingV2.tsx:1889` → `"https://example.com"` (placeholder)
- `OnboardingV2.tsx:1905` → `"Company name"` (label)
- `OnboardingV2.tsx:1908` → `"Acme Inc."` (placeholder)
- `OnboardingV2.tsx:1922` → `"Let's go"` (submit)
- `OnboardingV2.tsx:1929` → `"I don't have a website yet"` (skip)

### dataGathering
- `OnboardingV2.tsx:1996` → `"Help me learn about your business"`
- `OnboardingV2.tsx:1999` → `"The more context I have, the better I can help"`
- `OnboardingV2.tsx:2034-2035` → Connector labels: "Fathom", "Upload Documents", "Google Drive", "ClickUp"
- `OnboardingV2.tsx:2132` → `"Continue"`
- `OnboardingV2.tsx:2140` → `"Skip for now →"`

### buildingBrand
- `OnboardingV2.tsx:2452` → `"Learning your brand"`
- `OnboardingV2.tsx:2453` → `"Reading your website to capture brand voice, tone, colors, and positioning."`

### buildingIcp
- `OnboardingV2.tsx:2692` → `"Mapping your target customers"`
- `OnboardingV2.tsx:2693` → `"Emma is identifying the people most likely to buy."`

### buildingCreativeDir
- `OnboardingV2.tsx:2709` → `"Drafting the creative direction"`
- `OnboardingV2.tsx:2710` → `"Picking concepts, formats, and copy angles tailored to your brand."`

### buildingAdImage
- `OnboardingV2.tsx:2727` → `"Generating ad images"`
- `OnboardingV2.tsx:2728` → `"Producing 3 image variants based on the creative direction."`

### buildingAdCopy
- `OnboardingV2.tsx:2745` → `"Writing ad copy"`
- `OnboardingV2.tsx:2746` → `"Pairing each image with a headline and body in your brand voice."`

### channels
- `OnboardingV2.tsx:2337-2353` → Dynamic via `buildChannelConnectCopy()` helper — 4 strings per goal
- `OnboardingV2.tsx:2377-2383` → Channel labels: "Meta Ads", "LinkedIn Ads", "LinkedIn", "Instagram", "YouTube", "Gmail", "LinkedIn Outreach"
- `OnboardingV2.tsx:2397` → `"Connect"` (button)
- `OnboardingV2.tsx:2407` → `"Without these, Emma can't auto-deploy. Continue anyway?"`
- `OnboardingV2.tsx:2428` → `"Deploy these ads"` / `"Continue"` (conditional)
- `OnboardingV2.tsx:2438` → `"Skip for now →"` / goal-specific variant

### closing (TERMINAL SCREEN)
- `OnboardingV2.tsx:2922` → `"Ready to get started?"`
- `OnboardingV2.tsx:2928` → `"Emma can research and plan your campaigns, but can't auto-deploy until you connect an ad account."`
- `OnboardingV2.tsx:2930` → `"Emma can draft sequences and find prospects, but can't send until you connect Gmail or LinkedIn."`
- `OnboardingV2.tsx:2932` → `"Emma can create content, but can't post until you connect a social account."`
- `OnboardingV2.tsx:2946` → `"Let's go"` (finish button)

---

## LLM Prompts (Onboarding-Related)

### Ad Copy Generation Prompt
- **File:** `backend/src/services/onboardingAdCopyService.ts:99-145`
- **Type:** System prompt for ad copy generation during `buildingAdCopy` step
- **5 varieties hardcoded:** Problem Agitation, Competitor Contrast, Social Proof Led, Passive Benefit, Direct Response
- **Externalizable:** Yes — move variety names + structural format rules to `config.json steps.buildingAdCopy.variants`
- **Note:** The variety *structure* (headline 27-40 char, body 125-char hook) is a business rule and should remain structural. Only variety names/descriptions are copy-mutable.

### Emma Onboarding System Prompt
- **File:** `backend/src/services/chatbotService.ts` — search `onboard` for relevant passages
- **Scope:** Emma's context-awareness of user's onboarding stage — not a direct mutation target for the loop
- **Externalizable:** No — structural agent behavior

---

## Event Coverage

| Step | Events Fired | Missing | Gap? |
|------|--------------|---------|------|
| welcome | goal_selected | — | No |
| brand | brand_submitted, brand_skipped | — | No |
| paidAdsQuestions | channel_selected, deviation | — | No |
| dataGathering | data_connected, data_skipped | — | No |
| buildingBrand | (none) | step_started, step_completed | Yes — silent step |
| brandReview | brand_review_*, brandReview_confirmed | — | No |
| buildingIcp | (none) | step_started, step_completed | Yes — silent step |
| icpReview | icpReview_confirmed | — | No |
| valuePropReview | valuePropReview_confirmed | — | No |
| buildingCreativeDir | (none) | step_started, step_completed | Yes — silent step |
| buildingAdImage | (none) | step_started, step_completed | Yes — silent step |
| buildingAdCopy | (none) | step_started, step_completed | Yes — silent step |
| adReveal | ads_generated, ads_regenerated | — | No |
| channels | channel_connected, channels_skipped, **onboarding_completed** | — | No |
| outreachIcpReveal | outreach_icp_selected | — | No |
| closing | welcome_offer_shown, welcome_offer_outcome | — | No |

**Global gap:** No `elapsed_ms` in any event payload. All timestamps are ISO 8601 strings. Phase 2 adds `elapsed_ms` to each event.

---

## Externalization Plan

Copy moves into `config.json` under `steps.{step}.active_variants[].copy`.

### Group 1: Screen Headings (high signal — H1-level copy)
Moves to: `steps.{step}.active_variants[].copy.heading`
- welcome.heading: `"Hi, I'm Emma."`
- brand.heading: `"Tell me about your company"`
- dataGathering.heading: `"Help me learn about your business"`
- buildingBrand.heading: `"Learning your brand"`
- buildingIcp.heading: `"Mapping your target customers"`
- buildingCreativeDir.heading: `"Drafting the creative direction"`
- channels.heading: goal-specific via `buildChannelConnectCopy()`
- closing.heading: `"Ready to get started?"`

### Group 2: Screen Descriptions (supporting copy)
Moves to: `steps.{step}.active_variants[].copy.description`
- brand.description: `"Anything you've already saved..."`
- dataGathering.description: `"The more context I have..."`
- buildingBrand.description: `"Reading your website..."`
- buildingIcp.description: `"Emma is identifying..."`
- buildingCreativeDir.description: `"Picking concepts..."`
- buildingAdImage.description: `"Producing 3 image variants..."`
- buildingAdCopy.description: `"Pairing each image..."`
- closing.warningPaidAds, closing.warningOutreach, closing.warningOrganic

### Group 3: CTAs & Button Labels
Moves to: `steps.{step}.active_variants[].copy.cta`
- brand.ctaSubmit: `"Let's go"`
- brand.ctaSkip: `"I don't have a website yet"`
- dataGathering.ctaContinue: `"Continue"` / dataGathering.ctaSkip: `"Skip for now →"`
- channels.ctaConnect: `"Connect"` / channels.ctaDeploy: `"Deploy these ads"`
- closing.ctaFinish: `"Let's go"`

### Implementation approach
Each step component calls `useOnboardingVariant(step, userId)` (new hook, Phase 2).
The hook returns the active variant's copy object for that step.
Fallback to hardcoded defaults on error/load (zero-downtime degradation).

---

## Structurally Fixed Items (Out of Scope for v0 Mutations)

These CANNOT be mutated by the loop:
1. **Step count** — 16 screen types defined in `buildScreenOrder()`
2. **Step order** — state machine in OnboardingV2.tsx; navigation calls `goBack()`, `doSkipCurrentStep()`, `advanceFromOutreachStub()`
3. **Component assignment** — which component renders per screen (BuildStep, BrandReview, Phase4AdReveal, etc.)
4. **LLM pipeline** — 5 building steps with dependency chain (brand → icp → creative-dir → ad-image → ad-copy)
5. **Auto-advance timing** — building steps auto-route to next screen on `status=ready` (no pause for review)
6. **Event names themselves** — only the copy around events can be mutated

---

## Last Step Identification

**Terminal screen:** `closing`  
**Location:** `customer-portal/src/pages/OnboardingV2.tsx:2916-2951`

**Lifecycle:**
1. `channels` screen fires `onboarding_completed` (line ~1577)
2. → `setScreen('closing')` 
3. `closing` mounts — Emma orb animation, copy appears after 1.2s delay
4. Optional: `welcome_offer_shown` fires 2s after mount (once per session, gated by localStorage key)
5. User clicks "Let's go" → `handleFinish()` → navigate to `/agent-mode` or `/plan/Onboarding%20v2`

**Phase 3 mount point:** `<OnboardingCompletePage />` should replace or follow the `closing` screen's `handleFinish()` call, OR render as the content of the `closing` screen itself. The `closing` screen is the intended insertion point.

**Recommendation:** Route the "Let's go" button in `closing` to `/onboarding/done` (Phase 3 target), and fire `onboarding_completed` on the `/onboarding/done` page mount instead of on the `channels` screen — this gives us a clean terminal event tied to user actually reaching the completion screen.

---

## Estimated Loop Ceiling

| Metric | Value |
|--------|-------|
| Total externalizable strings | ~66 core + ~30 goal-variant |
| Mutation-eligible screens | 11 (excludes 5 silent build steps) |
| Active variants per step | 2-5 (config max: 5) |
| Signups/day (current) | ~20-50 (estimate) |
| Days to stat-sig at N=80 | ~3-7 days per step |
| Realistic v0 lift range | 5-20% completion rate improvement |
| Ceiling (copy-only) | ~25% over 90 days with 3 mutation cycles |

**Why ceiling is real:** 5 of 16 screens emit zero events and show only spinners — no copy to mutate. The terminal event gap (building steps) limits measurement precision on 31% of the funnel. Real ceiling unlocks in v1 when building steps get explicit events.

---

## Blockers / Questions for Harsha

**Neither blocker applies — auto-proceeding to Phase 2.**

1. **Last step is clear:** `closing` screen at OnboardingV2.tsx:2916. `<OnboardingCompletePage />` mounts at `/onboarding/done`, reached via "Let's go" button.

2. **Externalization under 300 lines:** ~280 LOC across both repos (refactor + hook + config read). Under threshold.

**Open questions (not blockers — flagging for awareness):**
- Building steps (brand, icp, creative-dir, ad-image, ad-copy) fire no events. Measurement gap for ~31% of funnel. Consider adding `step_started`/`step_completed` events in v1.
- No `elapsed_ms` in current events. Phase 2 adds it going forward; historical data won't have it.
- Outreach path stubs (6 screens) are placeholder — real copy arrives in sub-tasks 2-7. Loop will skip these steps until real screens land.
