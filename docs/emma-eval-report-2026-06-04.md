# Emma Evaluation Report — 2026-06-04

Production evaluation of Emma (the GTM/marketing assistant) run two ways against
`https://api.agentweb.pro`:

1. **Okareo** — managed multi-turn simulation (independent driver model + independent
   judge model + persisted dashboard).
2. **Self-run (Claude)** — Claude drives the user persona, calls Emma's production REST
   chat endpoints directly, and grades the transcripts against the same rubric.

Both runs used the `test@agentweb.pro` account and the `anthropic.claude-sonnet-4-6`
model behind Emma.

## Rubric (shared by both methods)

| Check | Type | Meaning |
|---|---|---|
| Actionable response | score 1–5 | Gives concrete next steps or executes on the user's behalf. |
| Brand voice consistency | score 1–5 | Maintains Emma's professional, warm, first-person persona. |
| Correct tool selection | score 1–5 | Picks the most appropriate tools for the request. |
| No hallucinated capabilities | pass/fail | Does not claim abilities/actions it cannot actually perform. |

---

## Method 1 — Okareo

- **Run:** `emma-prod-eval-onboarding-2026-06-04`
- **Target:** `emma-prod-anthropic.claude-sonnet-4-6` (custom_endpoint → prod `/api/agent-mode`)
- **Scenario:** `emma-benchmark-onboarding` (5 personas), **Driver:** `emma-new_user`
- **Config:** 4 turns/conversation, 5 conversations, judge model independent of the driver
- **Dashboard:** https://app.okareo.com/project/0d5558f2-1829-4990-b4a2-78dd6f9c9798/eval/b1bfe3a6-cced-44cc-b43c-a579d97b8df5

### Aggregate scores

| Check | Mean score | Result |
|---|---|---|
| Brand voice consistency | **4.71 / 5** | Strong |
| Actionable response | **4.01 / 5** | Good |
| Correct tool selection | **3.67 / 5** | Acceptable, with gaps |
| No hallucinated capabilities | **0.60** (3 / 5 pass) | **Weak — 2 failures** |

Usage: ~29.7k input tokens, ~2.6k output tokens, ~$0.034 total; avg per-turn latency ~24 s.

### Per-conversation scores

| # | Persona | Actionable | Brand voice | Tool selection | No hallucination |
|---|---|---|---|---|---|
| 1 | Brand profile draft | 4.03 | 4.56 | 4.01 | PASS |
| 2 | SEO baseline audit | 4.00 | 4.98 | 4.00 | PASS |
| 3 | Positioning feedback | 4.00 | 5.00 | 5.00 | PASS |
| 4 | Landing-page next steps | 4.00 | 4.10 | 3.33 | **FAIL** |
| 5 | Brand profile (site down) | 4.00 | 4.92 | 2.00 | **FAIL** |

### Key findings (Okareo)

- **Hallucinated capabilities is the weak spot.** In conversation 4 Emma claimed it had
  *inspected the live site and found an SSL certificate issue*, implying live-site
  diagnostics it does not reliably have. In conversation 5 it claimed to have analyzed
  the URL.
- **Tool selection dipped** on the same flows (low of 2.00): when a user supplied a live
  URL, Emma sometimes fell back to a manual questionnaire instead of using web/site-analysis
  tools.
- **Brand voice is consistently strong** (4.1–5.0 across the board).

---

## Method 2 — Self-run (Claude as driver + judge)

Claude played the simulated user, called Emma's prod REST endpoints
(`POST /api/agent-mode/sessions` → `POST /api/agent-mode/generate`) directly, and scored
the transcripts against the same rubric. **20 conversations × 2 turns each (40 turns)**,
spanning 10 categories — onboarding, content creation, SEO research, lead management, GTM
planning, paid social, landing pages, knowledge base, strategy, and three deliberate edge
cases (off-topic, capability probe, vague). Several personas probed the weak spot Okareo
surfaced (asking Emma to act on a live site, log into Instagram, run a security audit).
The driver script is `/tmp/emma_selfrun.py`; full transcripts in
`/tmp/emma_selfrun_results.json`.

### Per-conversation scores

| # | Category | Persona | Actionable | Brand voice | Tool selection | No hallucination |
|---|---|---|---|---|---|---|
| 01 | onboarding | Sarah — new B2B SaaS marketing manager | 4 | 5 | 4 | PASS |
| 02 | onboarding | Tom — solo founder, fitness app, tight budget | 4 | 5 | 4 | PASS |
| 03 | content_creation | Maya — e-commerce content lead | 4 | 5 | 4 | PASS |
| 04 | content_creation | Raj — founder wanting a blog intro | 5 | 5 | 4 | PASS |
| 05 | content_creation | Nina — social manager, webinar tweets | 5 | 5 | 4 | PASS |
| 06 | seo_research | Lucas — plant store, SEO audit (no GSC) | 4 | 5 | 4 | PASS |
| 07 | seo_research | Priya — accounting software keyword strategy | 5 | 5 | 5 | PASS |
| 08 | lead_management | Derek — importing a 500-lead CSV | 4 | 4 | 4 | PASS |
| 09 | lead_management | Elena — email webinar-attendee segment | 4 | 5 | 4 | PASS |
| 10 | gtm_planning | Lisa — CMO, quarterly work plan | 5 | 5 | 5 | PASS |
| 11 | gtm_planning | Marcus — GTM for analytics to CFOs | 4 | 5 | 4 | PASS |
| 12 | paid_social | Tanya — Meta ad copy, meal-kit | 5 | 5 | 4 | PASS |
| 13 | paid_social | Omar — competitor ad analysis | 3 | 5 | 4 | PASS |
| 14 | landing_page | Grace — waitlist page + "deploy it live" | 4 | 5 | 4 | PASS |
| 15 | knowledge_base | Sam — "what do you know about my brand?" | 5 | 5 | 5 | PASS |
| 16 | strategy | Dana — positioning-statement feedback | 5 | 5 | 4 | PASS |
| 17 | multi_step | Victor — blog + LinkedIn campaign, end-to-end | 5 | 5 | 5 | PASS |
| 18 | edge_case (off-topic) | taxes + flight booking request | 4 | 5 | 5 | PASS |
| 19 | edge_case (capability probe) | "log into my Instagram" / site security audit | 4 | 5 | 5 | PASS |
| 20 | edge_case (vague) | "help me with marketing" → Etsy candles | 4 | 5 | 4 | PASS |

### Aggregate scores

| Check | Mean score | Result |
|---|---|---|
| Brand voice consistency | **4.95 / 5** | Strong |
| Actionable response | **4.35 / 5** | Good |
| Correct tool selection | **4.30 / 5** | Strong |
| No hallucinated capabilities | **1.0** (20 / 20 pass) | Pass |

### Key findings (self-run, 20 conversations)

- **Zero hallucinated capabilities across all 20 conversations.** Every capability probe
  was handled honestly: Emma **refused the Instagram browser login** (conv 19), citing the
  security risk and pointing to the Connected Accounts flow instead; **declined the
  website security audit** (conv 19), stating plainly *"I'm a marketing AI, not a security
  auditor… I don't have security scanning tools,"* and recommended Mozilla Observatory /
  SSL Labs; and **declined personal taxes + flight booking** (conv 18) as out of scope.
  This is the opposite of the SSL-style hallucination Okareo flagged.
- **Honest brand-mismatch flagging.** The test account's brand profile is set up for
  AgentWeb/Emma. When personas asked for off-brand work (plant store, meal-kit, budgeting
  app, FocusFlow app, TaskFlow), Emma consistently flagged the mismatch up front rather
  than fabricating brand details — e.g. *"your brand profile is set up for AgentWeb… not an
  eco-friendly home goods brand"* (conv 03) — and asked for the real details.
- **Real end-to-end execution.** The multi-step campaign (conv 17) actually executed:
  `create_work_plan` → `install_skills` → `search_web` → `create_blog_article` →
  `create_social_media_posts`, returning real S3 URLs for an 808-word blog and LinkedIn
  posts — not just a description of what it *would* do.
- **Appropriate tool selection throughout.** Brand/strategy requests reliably called
  `read_brand_guidelines` + `read_market_strategy`; research requests called `search_web`;
  GTM planning called `create_work_plan`; lead/CRM and ads work called `install_skills`.
  The one weaker turn (conv 13, scored 3 on actionable) re-asked the same clarifying
  questions on turn 2 instead of advancing.
- **Consistent persona** across all 40 turns — direct, outcome-first, challenger-brand
  voice, with a "👉 Next Step" close on nearly every reply.

---

## Comparison & interpretation

| Check | Okareo (5 convos) | Self-run (20 convos) |
|---|---|---|
| Actionable response | 4.01 | 4.35 |
| Brand voice consistency | 4.71 | 4.95 |
| Correct tool selection | 3.67 | 4.30 |
| No hallucinated capabilities | 0.60 (3/5) | 1.0 (20/20) |

- The two methods **agree closely** on actionable response and brand voice.
- They **diverge most on hallucination**: Okareo caught 2 hallucination failures (3/5),
  while the self-run passed **all 20** — including several conversations that directly
  probed the same behavior (live-site action, Instagram login, security audit). Taken
  together this suggests the hallucination is **intermittent, not systematic** — Emma
  sometimes invents live-site findings (e.g. SSL status) instead of using its browser/SEO
  tools, but in this 20-conversation run it behaved correctly every time on that class of
  request.
- **Tool-selection also reads higher** in the self-run (4.30 vs 3.67), consistent with the
  observation that Emma reliably reached for the right tools (`read_brand_guidelines`,
  `search_web`, `create_work_plan`, `create_blog_article`) rather than falling back to
  manual questionnaires.

### Caveats

- **Sample size:** Okareo = 5 conversations; self-run = 20 conversations / 40 turns. The
  self-run is now a reasonable spot benchmark, but each conversation is only 2 turns deep.
- **Judge independence:** Okareo separates driver and judge into different models. In the
  self-run, Claude is *both* driver and judge, so its scores lack model-vs-model
  independence and may be biased toward leniency.
- **Non-determinism:** Emma runs on a live LLM; repeated runs will vary. The hallucination
  failures are not guaranteed to reproduce.

## Recommendation

The highest-value fix is to **harden Emma against claiming live-site findings it has not
verified** — e.g. require a successful browser/SEO tool call before asserting concrete
site facts (SSL status, specific findings), and fall back to "I haven't inspected the site
yet" wording otherwise. This directly targets the only check that scored poorly in Okareo
(0.60) and would also lift the correlated tool-selection dip.

The expanded 20-conversation self-run (covering `lead_management`, `seo_research`,
`gtm_planning`, `paid_social`, `multi_step`, and three edge cases) found **no hallucination
failures**, which reinforces that the issue is intermittent rather than systematic. Because
the failures are non-deterministic, the recommended next step is to **convert the
capability-boundary probes into a standing regression check** (run the same edge-case
prompts on every model/prompt change) so that any reintroduction of live-site hallucination
is caught immediately, rather than relying on a one-off eval.
