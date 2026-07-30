# ENG-204 — Skill Hardening & Catalog Optimization · Rollout Ledger

Single source of truth for the rollout. A change is **DONE** only when
`dev-applied ✅ · Emma-verified ✅ · promoted ✅`. The epic closes when every row
is DONE **and** every detector re-runs clean (final reconciliation).

**Verification gate (every data change):** dry-run diff → apply in dev (staging
prod-only skills via `prod-to-dev` sync) → `getSyncStatus()` field-diff → live
Emma run (unattended where safety matters) → promote per-skill → re-verify.

**Legend:** ☐ todo · ⧗ in progress · ✅ done · n/a
**Source:** `report` = named in the Skills Optimization Report · `scan` = found
by a live detector (data-derived, may exceed the report).

---

## Detectors (data-derived scope — do NOT trust the report alone)

| Blindspot | Detector | Status | Notes |
|---|---|---|---|
| 5 tool/prompt mismatch | `scripts/lintSkillToolReferences.ts` | ✅ built | dev scan: **6** skills (report named 1) |
| 4 empty prompts | empty-`systemPrompt` scan | ☐ | to add |
| 3 hardcoded context | hardcoded-fact / past-date scan | ☐ | to add |
| 7 duplicate drift | duplicate-name scan | ☐ | prod has 3 Luma, 2 LinkedIn Post Writing (confirmed by manual scan) |
| 1 send-safety / 2 failure / 6 measurement | missing-block scan (marker absence) | ☐ | to add |

---

## PR 1 — Guardrails & framework (ENG-607, ENG-608)

| Item | Skill / file | id | src | dev | verified | promoted |
|---|---|---|---|---|---|---|
| Blindspot 5 lint + tests | `skillToolReferences` | — | report | ✅ code | ✅ unit | n/a (code) |
| Hardening framework | `skillHardening/*` | — | — | ✅ code | ✅ unit | n/a (code) |
| Ledger scaffold | this file | — | — | ✅ | — | n/a |

## Blindspot 5 — toolNames fixes (data; from the lint scan)

| Skill | prod id | add to toolNames | src | dev | verified | promoted |
|---|---|---|---|---|---|---|
| Brand Strategy & Market Research | 4e7dde78 | you_search_web, search_knowledge_base, list_knowledge_base_files, read_knowledge_base_files | report+scan | ☐ | ☐ | ☐ |
| LinkedIn Outreach | 29afee58 | list_connected_accounts | scan | ☐ | ☐ | ☐ |
| HubSpot Marketing Management | 6d4d59cd (dev) | list_connected_accounts | scan | ☐ | ☐ | ☐ |
| X (Twitter) Management | 4e9bcad6 (dev) | list_connected_accounts | scan | ☐ | ☐ | ☐ |
| LinkedIn Post Creator from Latest News | 4750fd16 (dev) | read_brand_guidelines | scan | ☐ | ☐ | ☐ |
| Video Production | 8714d8c5 | you_search_web | scan | ☐ | ☐ | ☐ |

> NOTE: prod vs dev skillIds differ for several skills — resolve each against
> the table being edited before applying. Prod-only skills must be staged via
> `syncSkill(prodId,'prod-to-dev')` first.

## PR 2 — prompts & safety blocks (ENG-609, ENG-610, ENG-611)

| Item | Skill | prod id | change | src | dev | verified | promoted |
|---|---|---|---|---|---|---|---|
| Empty prompt | Tools for Basic Subscription | 3d7c0a14 | min prompt (publish gate) — **promote LAST** | report | ☐ | ☐ | ☐ |
| Empty prompt | Google Calendar | 7b65a0eb | min prompt + write-gates | report | ☐ | ☐ | ☐ |
| Empty prompt | Meeting Intelligence | afe8f202 | min prompt | report | ☐ | ☐ | ☐ |
| Empty prompt | CRM Draft Tool | 1347cbc4 | min prompt | report | ☐ | ☐ | ☐ |
| Blocks safety+failure+learn+compliance | CRM & Lead Management | 6748045e | append | report | ☐ | ☐ | ☐ |
| Blocks safety+failure+learn+compliance | LinkedIn Outreach | 29afee58 | append | report | ☐ | ☐ | ☐ |
| Ads budget+failure | all ads skills (Meta/Google/LinkedIn) | (multiple) | append adsBudget+failure | report | ☐ | ☐ | ☐ |

## PR 3 — structural (ENG-612, ENG-613, ENG-614)

| Item | Skill | id | change | src | dev | verified | promoted |
|---|---|---|---|---|---|---|---|
| Context freshness + dedup | Luma Event (×3) | eab2ba45 / a80b5360 / a831f5c8 | de-hardcode (Rui Wang/June-18/IDs), keep 1 delete 2 | report+scan | ☐ | ☐ | ☐ |
| Context freshness | Inbound Website Lead Engagement | 92ed7c80 | de-hardcode list names/ICP + safety/failure | report | ☐ | ☐ | ☐ |
| Split | Video Production | 8714d8c5 | private Scrollbook + generic published | report | ☐ | ☐ | ☐ |
| Dedup delete | LinkedIn Post Writing (×2) | 23c80388 / aabe2602 | keep 8-tool, delete other | report+scan | ☐ | ☐ | ☐ |

## PR 4 — new skills wave 1 (ENG-615, ENG-616)

| # | Skill | ships hardened | dev | verified | installed |
|---|---|---|---|---|---|
| #2 | ICP Lead Scoring & Prioritization | — | ☐ | ☐ | ☐ |
| #6 | Speed-to-Lead <5 min | yes (unattended) | ☐ | ☐ | ☐ |
| #1 | Intent Signal Prospecting Engine | yes (unattended) | ☐ | ☐ | ☐ |
| #3 | Multi-Touch Email Nurture Sequencer | yes (unattended) | ☐ | ☐ | ☐ |

## PR 5 — new skills wave 2 (ENG-617, ENG-618)

| # | Skill | gate | dev | verified | installed |
|---|---|---|---|---|---|
| #4 | AEO / Answer-Engine Optimization | — | ☐ | ☐ | ☐ |
| #5 | Cross-Channel Sequence Orchestrator | needs #3 | ☐ | ☐ | ☐ |
| #7 | Website Visitor De-anonymization | **privacy review (blocking)** | ☐ | ☐ | ☐ |
| #8 | Organic X/Twitter Posting & Reply | — | ☐ | ☐ | ☐ |
| #9 | Personalized Outbound Video at Scale | — | ☐ | ☐ | ☐ |
| #10 | Reddit/Community Intent Mining | — | ☐ | ☐ | ☐ |

---

## Backups
Row snapshots (pre-change) are written to `backend/skill-backups/` (gitignored)
by `skillHardening/backup.ts` before any mutation/delete. Restore = `updateSkill`
with the snapshot JSON.
