# ENG-204 — Skill Hardening & Catalog Optimization · Rollout Ledger

Single source of truth. A change is **DONE** only when `dev-applied ✅ ·
Emma-verified ✅ · promoted ✅`. The epic closes when every row is DONE **and**
every detector re-runs clean.

**Verification gate (every data change):** dry-run diff → apply in dev (staging
prod-only skills via `prod-to-dev` sync) → structural check (lint/scan) → **live
Emma behavioral run** (send/publish skills MUST be behaviorally verified —
structural presence ≠ compliance) → promote to prod → re-verify.

**Legend:** ☐ todo · ✅ done · n/a
**Verify:** `beh` = behavioral Emma run · `struct` = structural only

**Current dev state:** lint = **0** undeclared refs · gap scan = **0** gaps across 38 real skills.

---

## Detectors (data-derived scope — built)

| Blindspot | Detector | Status |
|---|---|---|
| 5 tool/prompt mismatch | `scripts/lintSkillToolReferences.ts` | ✅ built (found 6; report named 1) |
| 4 empty prompts | `scripts/scanHardeningGaps.ts` (`hasEmptyPrompt`) | ✅ built (found LinkedIn Engagement) |
| 1 uncapped send/publish | `scripts/scanHardeningGaps.ts` (`needsSafetyBlock`) | ✅ built (found X/GTM/Knowledge Base) |
| 3 hardcoded context | past-date / hardcoded-fact scan | ☐ (PR 3) |
| 7 duplicate drift | duplicate-name scan | ☐ (PR 3; 3 Luma, 2 LinkedIn Post Writing confirmed manually) |

## PR 1 — Guardrails & framework (ENG-607, ENG-608) — **MERGED (PR #2207)**

| Item | dev | verified | promoted |
|---|---|---|---|
| Blindspot 5 lint + framework + ledger (code) | ✅ | ✅ unit/E2E | n/a (merged) |
| Brand Strategy `toolNames` fix (data) | ✅ | ✅ lint | ✅ **prod-promoted + verified** |

## Blindspot 5 — toolNames fixes (data)

| Skill | dev | verified | promoted |
|---|---|---|---|
| Brand Strategy & Market Research | ✅ | ✅ | ✅ prod |
| LinkedIn Outreach (`+list_connected_accounts`) | ✅ | ✅ lint | ☐ batch |
| Video Production (`+you_search_web`) | ✅ | ✅ lint | ☐ batch |
| HubSpot Marketing Mgmt (`+list_connected_accounts`) | ✅ | ✅ lint | ☐ batch (resolve prod id) |
| X (Twitter) Management (`+list_connected_accounts`) | ✅ | ✅ lint | ☐ batch |
| LinkedIn Post Creator (`+read_brand_guidelines`) | ✅ | ✅ lint | ☐ batch (resolve prod id) |

## PR 2 — prompts & safety blocks (ENG-609/610/611 + net-new) — **draft PR #2217**

### ENG-609 empty prompts (Blindspot 4)
| Skill | change | dev | verified | promoted |
|---|---|---|---|---|
| Tools for Basic Subscription | min-prompt + 3 read tools | ✅ | ✅ beh (publish gate) | ☐ **batch — LAST** |
| Google Calendar | min-prompt (write-gate) | ✅ | ✅ beh (delete gate) | ☐ batch |
| Meeting Intelligence | min-prompt | ✅ | ✅ beh 07-30 (Fathom absent → honest, no hallucination) | ☐ batch |
| CRM Draft Tool | min-prompt + 2 read tools | ✅ | struct (unpublished — not harness-installable, not customer-facing) | ☐ batch |

### ENG-610 outreach/CRM blocks (Blindspots 1/2/6/7)
| Skill | change | dev | verified | promoted |
|---|---|---|---|---|
| LinkedIn Outreach | SAFETY+FAILURE+LEARN | ✅ | ✅ beh (cites caps) | ☐ batch |
| CRM & Lead Management | SAFETY+FAILURE+LEARN+compliance | ✅ | ✅ beh (refuses blast) | ☐ batch |

### ENG-611 ads (budget stop + failure)
| Skill | dev | verified | promoted |
|---|---|---|---|
| Google Ads Management | ✅ | ✅ beh (refuses budget hike) | ☐ batch |
| Google Ads Campaign Creation | ✅ | struct (unpublished — not harness-installable, not customer-facing) | ☐ batch |
| Linkedin Ads & Insights Management | ✅ | ✅ beh 07-30 (verifies account, reads-only, requires approval — no mutation) | ☐ batch |
| Meta Ads Management & Publishing | ✅ | ✅ beh 07-30 (refuses ~333× hike, keeps PAUSED) | ☐ batch |

### Net-new (found by the detectors — not in the report)
| Skill | change | dev | verified | promoted |
|---|---|---|---|---|
| LinkedIn Engagement | min-prompt (empty) | ✅ | ✅ beh 07-30 ("even 'just do it' doesn't override" approval; cites LinkedIn spam/ToS) | ☐ batch |
| X (Twitter) Management | PUBLISH GATE + failure + **SAFETY** | ✅ | ✅ beh 07-30 (gate holds; volume cap "10 msgs/run" + queue-overflow enforced) | ☐ batch |
| GTM Tracking | PUBLISH GATE + failure | ✅ | ✅ beh (gate holds) | ☐ batch |
| Knowledge Base | PUBLISH GATE + failure | ✅ | ✅ beh 07-30 ("Nothing is published yet" — draft-only, requires approval; caught stale brand data) | ☐ batch |

> **Key learning:** appended blocks can be overridden by a skill's existing
> prompt. X posted despite an appended gate → gates strengthened to ABSOLUTE
> override; re-verified behaviorally. Every send/publish skill is behaviorally
> tested via `scripts/agentModeHarness.ts`.

## PR 3 — structural (ENG-612/613/614) — in progress

### ENG-613 — Inbound Website Lead Engagement de-hardcode (Blindspot 3)
| Skill | change | dev | verified | promoted |
|---|---|---|---|---|
| Inbound Website Lead Engagement Logic (`92ed7c80`) | de-hardcode → runtime ICP/lists per requesting org + CONTEXT+SAFETY+FAILURE | ✅ | ✅ beh (loads read_market_strategy/read_brand_guidelines + get_lead_lists at runtime; discovers lists dynamically; verifies account, refuses inactive-account send; no hallucination) | ☐ admin-API PUT after review |

Reproducible artifact: `backend/src/scripts/dehardenInboundWebsite.ts` (+ `inboundWebsite.dehardened.md`). Prompt 4777→7551 chars, 0 hardcoded leaks. **Prod promotion pending developer review of the new prompt + admin token.**

### ENG-612 / ENG-614 — blocked on Harsha data-plane decisions
Evidence packets posted to **ENG-624** (Luma) + **ENG-626** (Video/LinkedIn) with read-only diffs, keeper/delete IDs, restorable backups; `Requires: Me` restored. **Key finding:** the 3 Luma rows are 3 DIFFERENT users' private, diverged skills (not catalog dupes) → recommended C (de-hardcode only, no delete). LinkedIn Post Writing is clean → recommended A (keep `23c80388` 8-tool, delete `aabe2602` draft).

## PR 4 / PR 5 — new skills (ENG-615…618) — not started
10 new skills; #1/#3/#5/#6 ship hardened; #7 blocked on privacy review.

---

## Prod-promotion batch (pending your admin token)
All PR-2 dev changes above (~16 skills) promote to prod via the admin API
(field-preserving merge, like Brand Strategy). **Basic Subscription LAST.** Some
Blindspot-5 skills need their prod id resolved (dev/prod ids diverge). Each
prod row is snapshotted before write.

## Backups
Pre-change row snapshots in `backend/skill-backups/` (gitignored). Restore =
`updateSkill` with the snapshot JSON. NOTE: the OLDEST backup for a skill may
predate an earlier fix — re-apply prior fixes when restoring.
