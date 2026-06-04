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
the transcripts against the same rubric. Two personas, 2 turns each. The second persona
deliberately probed the weak spot Okareo surfaced (asking Emma to analyze a live site).

### Per-conversation scores

| # | Persona | Actionable | Brand voice | Tool selection | No hallucination |
|---|---|---|---|---|---|
| 1 | Sarah — new B2B SaaS marketing manager; intro + set up brand profile | 4 | 5 | 4 | PASS |
| 2 | Tom — solo founder; "analyze my live site `example.com`" (weak-spot probe) | 4 | 5 | 5 | PASS |

### Aggregate scores

| Check | Mean score | Result |
|---|---|---|
| Brand voice consistency | **5.0 / 5** | Strong |
| Actionable response | **4.0 / 5** | Good |
| Correct tool selection | **4.5 / 5** | Strong |
| No hallucinated capabilities | **1.0** (2 / 2 pass) | Pass |

### Key findings (self-run)

- **No hallucination observed on the probe.** When asked to analyze `example.com`, Emma
  correctly identified it as IANA's placeholder domain, said it could not audit it, and
  asked for the real URL — and on the follow-up explicitly stated *"I'm giving you a
  generic answer right now because I haven't seen your site."* This is the opposite of the
  SSL-style hallucination Okareo flagged.
- **Real tool use.** The site-analysis turn invoked `install_skills` →
  `playwright_browser_navigate` + `get_seo_metrics` + screenshot/snapshot — the correct
  tools for the task. Persona 1 appropriately called `search_web`.
- **Consistent persona** across all turns.

---

## Comparison & interpretation

| Check | Okareo (5 convos) | Self-run (2 convos) |
|---|---|---|
| Actionable response | 4.01 | 4.0 |
| Brand voice consistency | 4.71 | 5.0 |
| Correct tool selection | 3.67 | 4.5 |
| No hallucinated capabilities | 0.60 (3/5) | 1.0 (2/2) |

- The two methods **agree closely** on actionable response and brand voice.
- They **diverge on hallucination/tool-selection**: Okareo caught 2 hallucination failures;
  the self-run probe of the same behavior passed. Taken together this suggests the
  hallucination is **intermittent, not systematic** — Emma sometimes invents live-site
  findings (e.g. SSL status) instead of using its browser/SEO tools, but often behaves
  correctly on the same class of request.

### Caveats

- **Sample size:** Okareo = 5 conversations; self-run = 2. The self-run is a spot check,
  not a full benchmark.
- **Judge independence:** Okareo separates driver and judge into different models. In the
  self-run, Claude is *both* driver and judge, so its scores lack model-vs-model
  independence and may be biased toward leniency.
- **Non-determinism:** Emma runs on a live LLM; repeated runs will vary. The hallucination
  failures are not guaranteed to reproduce.

## Recommendation

The highest-value fix is to **harden Emma against claiming live-site findings it has not
verified** — e.g. require a successful browser/SEO tool call before asserting concrete
site facts (SSL status, specific findings), and fall back to "I haven't inspected the site
yet" wording otherwise. This directly targets the only check that scored poorly (0.60) and
would also lift the correlated tool-selection dip.

Suggested next step: run the harder Okareo scenarios (`lead_management`, `seo_research`,
`edge_cases`, `multi_step`) for a fuller picture before committing to a fix.
