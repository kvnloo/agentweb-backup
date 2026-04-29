## coding_agent "No GitHub / No Vercel" — Investigation (2026-04-29)

### Context

John (`founders@agentweb.pro`) reported that the `coding_agent` tool failed on the "Free AI Eval" landing page (`ai-eval-85a928ad`, `https://audit.agentweb.pro/ai-eval`) after 8 iterations with "No GitHub repository / No Vercel project" errors on all file-editing and deployment tools.

### Root Cause 1: Missing `githubRepoUrl` / `vercelProjectId` on DynamoDB record

The page record existed with `status: deployed` and a live `deployedUrl`, but `githubRepoUrl` and `vercelProjectId` were completely absent. Every coding agent tool — `list_files`, `read_file`, `edit_file`, `check_deployment` — calls `getLandingPage()` and checks these fields before doing anything.

**Why it happened:** `addPageToExistingRepo()` copies these fields from a sibling page at record creation, but the final deployed-status `UPDATE` only wrote `status` and `updatedAt`. If the initial PUT was incomplete for any reason, the record was permanently broken.

**Fix:** The `UPDATE` in `addPageToExistingRepo()` now also re-writes `githubRepoUrl` and `vercelProjectId` (`v0Service.ts`). Backfilled the specific record in production using `repair-landing-page-repo-fields.ts`.

### Root Cause 2: Stale `vercelProjectId` across all pages

After fixing root cause 1, `get_landing_page_preview_url` and `get_deployment_status` failed with 500. The stored Vercel project ID `prj_8MJIkLDVNod9XRj5Kbl0FIk7EhJ3` was stale — the Vercel project had been recreated. All 5 of john's pages had the old ID.

**Fix:** Checked the Vercel dashboard (`vercel.com/agentweb/agentweb-landing-page`), found the new project ID `prj_lH8z68FO47QtpLrLa45FnFRc2xwV`, and ran `repair-vercel-project-id.ts` to update all 5 pages in production.

### How to diagnose this in future

1. Check the DynamoDB record directly: `aws dynamodb get-item --table-name AW-LandingPages --key '{"id":{"S":"<page-id>"}}'` — look for `githubRepoUrl` and `vercelProjectId`.
2. If `vercelProjectId` is present but deployment APIs return 500, test it: `curl -H "Authorization: Bearer <VERCEL_TOKEN>" "https://api.vercel.com/v9/projects/<vercelProjectId>"`. A 404 means the project was recreated — check the Vercel dashboard for the new project ID.
3. When a Vercel project is recreated, update all pages sharing the old ID using `repair-vercel-project-id.ts` (update `OLD_ID`/`NEW_ID` constants first).

### Lesson

When the Vercel project is recreated or migrated, all `AW-LandingPages` records pointing to the old project ID become silently broken. There is no automatic sync. Any time Vercel project management happens (delete, transfer, recreate), run the repair script immediately.

---

## Emma 3-Dimension Scores Missing — Investigation (2026-04-28)

### Context

Emma was asked to pull chat history with `sync=true` and report per-session dimensional scores (`goalCompletion`, `dataAccuracy`, `outputQuality`). The scores were consistently absent from all sessions — Emma could only see the top-level integer score.

### Root Cause

The production `AW-Settings` table has a custom `default-scoring-prompt` that was saved on **2026-04-15**, before the dimensional scoring feature was introduced on **2026-04-26**. The old prompt ends with:

```
Respond with ONLY valid JSON: {"score": <1-5>, "reason": "<brief explanation>"}
```

`getDefaultScoringPrompt()` in `sessionScoringService.ts` checks the DB first and uses whatever is stored there. Since the DB prompt predates dimensions, the LLM never returns a `dimensions` field, and `parseDimensions()` always returns `undefined`. All 57 production sessions in the queried window had `dims=None`.

### Why PR #1347 Didn't Fully Fix It

PR #1347 (`fix(scoring): re-score sessions missing dimensional scores on sync`, 2026-04-27) fixed the **re-scoring guard** — sessions with a score but no dimensions were previously being skipped as "already scored." That guard was updated to re-score when `dimensions` is absent. However, re-scoring still used the old DB prompt, so the LLM still returned no dimensions. The guard fix was correct but incomplete.

### Fix

Update the `default-scoring-prompt` in `AW-Settings` (via Admin → Scoring Judges → Default edit icon) to append the dimensions instruction before the JSON format line:

```
In addition to the overall score, rate three specific dimensions (1-5 each):
- goalCompletion: Did the assistant fully accomplish what the user asked?
- dataAccuracy: Did the output contain plausible, consistent, and factually coherent data?
- outputQuality: Was the output well-structured, specific, and actionable?

Respond with ONLY valid JSON:
{"score": <1-5>, "reason": "<brief explanation>", "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>}}
```

The two custom `IMPORTANT` sections in the existing DB prompt ("Expected outcomes" and "Tool Execution after Nudges") should be preserved — they are prod-only additions not in the hardcoded fallback.

### Verification

Tested on dev by stripping dimensions from a live session, then calling `GET /api/admin/chat-sessions?sync=true`. Confirmed dimensions were backfilled correctly after the prompt update.

### Lesson

When adding new required fields to the scoring LLM output format, also update `AW-Settings` `default-scoring-prompt` if a custom version is stored. The hardcoded `DEFAULT_SCORING_SYSTEM_PROMPT` constant in `sessionScoringService.ts` is only a fallback — any stored DB override takes precedence.

---

# April 27, 2026: Investigation — Drip Campaigns vs. Sequences Overlap

## Context

Audit of the Drip Campaigns feature (customer-portal `/crm/drips`) added in PRs agentweb #1218, #1220, #1301 and agentweb-customer-portal #673 (all by Harsha Vankayalapati). The feature was originally built in partner-portal then migrated to customer-portal. Concern: it may duplicate or conflict with the Sequences feature already in the CRM.

## What Drip Campaigns Does

A drip campaign is a single-email broadcast that repeats on a cadence (every N hours/days/weeks) to all leads currently matching a segment filter. Key attributes:

- **Fields:** `name`, `subjectLine`, `templateHtml`, `segmentQuery` (lifecycle, minHeatScore, utmSource, leadListId), `cadenceUnit`, `cadenceValue`, `maxSends`, `isActive`, `killSwitch`
- **Execution:** `dripExecutor.ts` cron runs every 15 min; for each active campaign, queries matching leads and sends if cadence + safety gates pass
- **Emma tool:** `manage_drip_campaign` (list/get/create/update/pause/resume/delete)
- **Tables:** `AW-DripCampaigns`, `AW-DripSends`
- **Routes:** `backend/src/routes/dripCampaigns.ts`
- **UI:** `customer-portal/src/pages/Drips.tsx`

## What Sequences Does

A sequence is a multi-step email journey where leads enroll explicitly and advance through steps on configurable delays. Key attributes:

- **Fields:** `name`, `description`, `campaignType`, `status`, steps (each with `delayDays`, `subject`, `bodyHtml`), `enrollmentTrigger`, `enrollmentCondition`, `exitConditions`
- **Execution:** `dripSequenceWorker.ts` processes due enrollments; advances per-lead state, evaluates exit conditions
- **Emma tool:** None — UI only
- **Tables:** `AW-DripSequences`, `AW-SequenceEnrollments`
- **Routes:** `backend/src/routes/sequences.ts`
- **UI:** `customer-portal/src/components/crm/SequencesTab.tsx`, `SequenceBuilder.tsx`

## Comparison

| | Drip Campaigns | Sequences |
|---|---|---|
| Steps | Single email, repeating | Multi-step series |
| Trigger | Implicit cadence (cron matches leads) | Explicit enrollment (manual, lifecycle, list) |
| Per-lead state | `AW-DripSends` send history only | Full enrollment record with currentStep, nextSendAt |
| Exit conditions | Kill switch / isActive only | Lifecycle change, email engagement, unsubscribe |
| Emma tool | Yes | No |
| Use case | Broadcast to dynamic segment | Personalized nurture journey |

## Decision

**Drip Campaigns to be removed.** Sequences is the more capable and correctly designed feature — multi-step, per-lead state, enrollment conditions, exit conditions. Drip Campaigns was accidentally added by Harsha's Claude Code session and was not intentionally designed as a separate product feature. Harsha confirmed this and agreed to remove it.

Work required (tracked separately):
- Delete `customer-portal/src/pages/Drips.tsx` + route + nav entry
- Delete `backend/src/routes/dripCampaigns.ts`
- Delete `backend/src/services/dripCampaignDb.ts`, `dripSendsDb.ts`, `dripExecutor.ts`
- Remove `manage_drip_campaign` Emma tool from `backend/src/mcp/server/apiTools.ts`
- Re-assign `manage_drip_campaign` skill assignment (currently in CRM & Lead Management skill) to Sequences or remove
- Drop `AW-DripCampaigns` and `AW-DripSends` DynamoDB tables in prod (after confirming no active campaigns)

---

# April 26, 2026: Investigation — Design4Space Scheduled Chat 400 Error (Azure OpenAI Tool Limit)

## Context

Scheduled chat "Design4Space Website Scan" failed at `2026-04-26T14:19:08` with:

```
400 Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 143 instead.
```

Model: `gpt-5.4` (Azure OpenAI deployment). The earlier run at 04:59 succeeded; the 14:19 run failed.

## Root Cause

Azure OpenAI enforces a hard limit of 128 tools per API request. The session ended up with 143 tools split as:

- **34** foundation tools (always included)
- **22** Browser automation skill tools
- **2** SEO & Website Analytics skill tools
- **~85** from `__other_skills__` — the virtual catch-all skill

`__other_skills__` is auto-installed by `runVerifiedChat()` when a required function call isn't assigned to any named skill. The session needed `navigate_to` (which wasn't in any named skill), so the system installed `__other_skills__`, which at the time held ~85 orphaned tools — every registered tool not assigned to a published skill.

The 04:59 run succeeded because it had a different execution path that happened to stay under 128. The 14:19 manual test run hit the full tool list immediately after skill install.

## Fix 1 — Safety net (PR #1334)

Added `maxTools: 128` to all Azure OpenAI model configs (`gpt-5-chat-2`, `gpt-5.2-chat`, `gpt-5.4`) and truncation logic in `callLLM()` in `agentModeService.ts`. Prevents the hard 400 crash even if tool counts exceed the limit again.

## Fix 2 — Root cause (dev environment only, via partner portal UI)

Audited all registered tools against published skills. Found **65 orphaned tools** in `__other_skills__` that had never been assigned to any named skill. Assigned all of them to their proper skills via the Skills Management UI at `/skills`:

| Skill | Tools added |
|---|---|
| Meeting Intelligence | `fathom_route_action_items` |
| LinkedIn Outreach | `linkedin_outreach` |
| Meta Ads Management & Publishing | `list_meta_ads_campaigns`, `get_meta_ads_metrics` |
| CRM & Lead Management | `ask_crm`, `set_lead_contact_status`, `delete_leads_by_filter`, `update_lead_status`, `get_lead_list_statuses`, `configure_lead_statuses`, `analyze_crm_data`, `assign_lead`, `promote_to_deal`, `get_hot_leads`, `log_contact_event`, `import_leads_from_search`, `enrich_leads_preview`, `enrich_leads_execute`, `enrich_lead_custom`, `get_user_profile`, `report_product_issues`, `manage_drip_campaign` |
| Landing Page Builder | `get_landing_page_preview_url`, `publish_landing_page_changes` |
| Landing Page Design | `create_html_template` |
| Knowledge Base | `perform_deep_research`, `search_ads_knowledge_base`, `list_books`, `get_book_details`, `get_book_content`, `update_book_content`, `generate_book_content`, `create_book`, `create_book_outline`, `create_blog_article`, `publish_blog_article`, `list_cms_categories`, `repair_blog_article` |
| GTM Tracking | `account_summary`, `get_clarity_metrics`, `list_task_templates`, `create_task_from_template`, `create_task_from_prompt`, `create_image_task_from_prompt`, `create_revision`, `get_task_subscriber_metrics`, `remove_c2pa_from_image`, `rotate_primary`, `list_schedule_templates`, `manage_schedule_template`, `create_schedule_from_template`, `slack_list_channels`, `slack_get_recent_messages`, `slack_get_thread_replies`, `slack_send_message`, `send_for_review`, `notify_session`, `wait_seconds`, `search_tool_response`, `email`, `post_on_connected_account`, `perform_data_analysis` |
| B2B Ad Image Batch Generation | `bravesearch_brave_local_search`, `bravesearch_brave_video_search`, `bravesearch_brave_summarizer` |

After these assignments, `__other_skills__` is empty in dev.

## Decision

**Always assign new tools to a named skill when deploying them.** Do not leave tools unassigned — they silently pile into `__other_skills__` and inflate the tool count for any session that needs the catch-all. The `maxTools` truncation is a safety net, not a substitute for correct skill assignment.

---

# April 21, 2026: Investigation — Agent Mode "Unknown Error" with claude-opus-4-7

## Context

User `ftan@agentweb.pro` hit the generic "I apologize, but I encountered an error processing your request" error in Agent Mode when using model `anthropic.claude-opus-4-7`. This triggered an "Unknown Error in Generate Response" oncall alert.

## Root Cause

`anthropic.claude-opus-4-7` is registered in the model registry but **not provisioned on this AWS Bedrock account**. Bedrock returns:

```
ValidationException: anthropic.claude-opus-4-7 is not available for this account.
You can explore other available models on Amazon Bedrock.
```

This is a 400-class error, but the AWS SDK surfaces the HTTP status on `error.$metadata.httpStatusCode` rather than a top-level `error.status` field. The existing error classifier in `generateMarketingResponse` only checked `error.status === 400`, so the Bedrock ValidationException fell through to the generic catch-all and triggered the oncall alert instead of showing a sensible "issue processing your request" message.

## Fix

- Added `error.$metadata.httpStatusCode` as a fallback when reading the HTTP status in the error classifier (`agentModeService.ts`). Going forward, Bedrock validation errors will map to the correct user-facing message.
- The model is kept in the registry because: (1) it is admin-only (`getSupportedModels` filters out any model with "opus" for non-admins), so regular users are never exposed to it; (2) it may become available on this account in the future, at which point it will work automatically.
- If AWS provisions the model on this account, no code changes are needed — the inference profile ARN is already configured.

## Decision

**Do not remove `claude-opus-4-7` from the registry.** It is safely gated behind admin-only access, and the error classification fix means any future Bedrock unavailability errors will show a proper message rather than triggering a generic alert.

---

# April 8, 2026: Investigation — Lead Tech Stack Enrichment Options

## Context

Investigated options for enriching CRM leads to discover what software products/services lead businesses use — both customer-facing integrations and back-office tools.

## Current Enrichment Capabilities

- `crmEnrichmentService.ts` — web search (via agentModeService.searchWeb) + Gemini LLM extraction. Custom instructions + output fields. 20 parallel workers.
- ICP matching — OpenAI analysis of lead fields vs. user-defined ICPs.
- LinkedIn profile enrichment via Unipile integration.
- Existing guidance hint for `tech_stack` fields uses LLM inference from search results.

## Options Evaluated

**Option A: Pre-built "Tech Stack" enrichment template** — Add preset instruction + output fields to existing enrich-web flow. Zero new infrastructure. Misses back-office tools not in public web results.

**Option B: BuiltWith API** — REST API ($295/mo or $0.12/lookup), scans domains for frontend/web technologies. High accuracy for analytics, CDN, ecommerce, email marketing, payment processors. Doesn't cover internal back-office tools (Salesforce, payroll, etc.).

**Option C: Apollo.io Enrichment API** — `/organizations/enrich?domain=` returns `technology_names` array scraped from job postings and LinkedIn. Free tier 50/day. Best for back-office tools (Salesforce, NetSuite, Jira, AWS). Less accurate for smaller/newer companies.

**Option D: Job Posting Analysis via LLM** — Add second web search per lead targeting LinkedIn/Indeed job listings. "Experience with X required" reveals tech stack. Zero extra cost; only works for actively hiring companies.

**Option E: Browser automation (agent engine)** — Playwright scrapes company websites, integrations/partners pages, footer badges. Most thorough, ~30–60s per lead.

## Decision (final)

**Implement Option D (LLM + web search) via existing `CrmEnrichmentService`** — reuses the same LLM + Google Search pipeline already powering "Enrich with Web". The route uses a tech-stack-specific instruction that targets job postings ("Experience with X required"), integrations/apps pages, and partner badges.

- Route: `POST /api/crm/lists/:listId/leads/enrich-tech-stack` (in `crm.ts`)
- Service: `CrmEnrichmentService` with `sources: ['web_search']` and `TECH_STACK_INSTRUCTION` preset
- UI: "Discover Tech Stack" in CRM dropdown, dedicated dialog with LLM preview (2 sample leads enriched at preview time) + progress bar
- Fields: `tech_stack_analytics`, `tech_stack_cms`, `tech_stack_marketing`, `tech_stack_infrastructure`, `tech_stack_integrations`
- Zero extra cost; 20 parallel workers; ~2–5s per lead

**Note:** `builtWithService.ts` was created as an intermediate attempt (puppeteer scraping `builtwith.com`) but abandoned after BuiltWith captcha blocked automated access. The file remains in the repo but is no longer used by the route.

---

# April 8, 2026: Investigation — Who Started Running Ads for Waldium Account

## Background

User `amrutha@structuredlabs.com` (Waldium) has active Meta Ads campaigns and a recurring 48-hour performance check-in schedule running in their account. Rui (admin) did not recall initiating these, raising a question about which actions were taken by the admin vs. the user, and surfacing a broader gap: the platform has no comprehensive audit trail for actions taken via admin delegate access.

## Investigation

**User ID:** `1a9a40c5-5ec0-41de-996f-cee3b82fa74e`

Queried `AW-ChatSessions` (UserIdIndex GSI) and `AW-TaskSchedules` for this user. Found ~90 sessions spanning Dec 2025–Apr 2026.

### Session Attribution Summary

| Date | Session | Title | Initiated By | Notes |
|------|---------|-------|--------------|-------|
| Jan 7, 2026 | `37429d16` | Emotional Facebook Ad for Waldium DevRel Backlog | **User** (no delegate) | Ad creative only, no Meta Ads API |
| Feb 15–20 | `e13847b4` | AI Assistants Recommend Competitors Facebook Ad | **matthew@agentweb.pro** (delegate) | Ad creative only |
| Feb 15–Mar 25 | `3cccd7e3` | Waldium Multi-ICP AI Ad Video Generation Plan | **matthew@agentweb.pro** (delegate) | Ad video creation |
| **Mar 17** | `dc3b404d` | Meta Ads Multi-Campaign Performance Report | **ruiw@agentweb.pro** (delegate) | **First Meta Ads API session.** 58 msgs. Called `call_meta_ads_insights_api` x10, `call_meta_marketing_api` x1, `manage_scheduled_chat` x3. Created the recurring "Multi-Campaign Performance Report" schedule (every 3 days). |
| Mar 17 | `762ad27b` | Test: Waldium Meta Ads — Multi-Campaign Performance Report | Automated (scheduled) | First automated run of the above schedule |
| **Mar 31–Apr 2** | `d0a87f37` | Meta Ads Status Check – Running vs Paused Campaigns | **ruiw@agentweb.pro** (delegate) | 47 msgs, interactive. Called `call_meta_marketing_api` x4. Checked/changed campaign statuses, ran performance audit, helped with custom audience uploads. Judge score 5/5. |
| **Apr 2–6** | `3fcc89e8` | Meta Campaigns Schedule Lookup | **ruiw@agentweb.pro** (delegate) | 62 msgs, interactive. Set up the "Landing Page Lead Magnets - 48hr Check-in" monitoring schedule (every 2 days). Judge score 5/5. |

### Active Schedules

| Schedule ID | Created | Frequency | Status | Description |
|-------------|---------|-----------|--------|-------------|
| `135c535c` | Mar 17 | Every 3 days | Active | Waldium Meta Ads Multi-Campaign Performance Report |
| `77289d04` | Apr 6 | Every 2 days | Paused | Landing Page Lead Magnets - 48hr Check-in (campaign ID: 6865354788715, account: 883347640787043) |
| `623db84f` | Apr 7 | Daily | Active | Website Scan - waldium.com |

### Findings

1. **Admin (Rui, `ruiw@agentweb.pro`) initiated all Meta Ads API usage** via delegate access, starting March 17. The user (amrutha) never directly triggered Meta Ads API calls — her own sessions were limited to ad content creation (images, copy) in Jan–Feb.

2. **Rui does not recall these sessions.** The `delegateInfo` field records which admin account was used but not who was physically at the keyboard, nor what the original prompt was.

3. **The "Landing Page Lead Magnets" campaign (ID: 6865354788715) was pre-existing** in Meta Ads Manager — the monitoring schedule was set up to watch it, not to launch it.

4. **Root cause of the attribution gap:**
   - `AW-ChatSessions.startingMessage` is null for most sessions — original prompts are not persisted
   - `AW-TaskSchedules.createdBy` is null — no record of who created a schedule
   - Session messages are archived/cleared; only `calledFunctions` counts and judge scores survive
   - No dedicated admin action log exists

## Audit Gap Options Evaluated

Four options were considered:

- **Option A** — Persist `startingMessage` + add `createdByAdminEmail` to schedules (1–2 days, low effort)
- **Option B** — New `AW-AdminActions` table logging every delegate action (3–5 days)
- **Option C** — Email account owner when admin takes high-impact actions via delegate (2–3 days)
- **Option D** — Session message retention policy / compact session summaries (5–7 days)

## Decision

**No ad-hoc tracking added now.** These gaps are real but any point solution (e.g. logging just schedule creation, or just delegate sessions) would be incomplete and create a false sense of coverage.

The right fix is a **comprehensive user activity tracking solution** that covers all action types (sessions, schedules, task executions, config changes) across both user and admin-delegate contexts, with a queryable admin UI. That work should be scoped and prioritized as a standalone initiative rather than bolted on per-investigation.

**Until that exists:** When investigating admin delegate sessions, use `delegateInfo` on `AW-ChatSessions` + `calledFunctions` counts + judge scores as the best available signal.

---

# April 9, 2026: Investigation — Emma Taking Irrelevant Actions (CRM/Lead Creation During Website Scan)

## Context

Reported session: `f3e85582-8f82-4c62-a9d3-a37692e94088`
Schedule: `f6418b77-81a1-4dad-9c1f-6d77adff2c6e` ("Design4Space Website Scan")
User: `1f32123d-23b3-456e-81cd-52bae8bb5851`

A scheduled website scan session where Emma was observed creating a lead list and adding a contact to CRM — actions completely unrelated to the task.

## What Happened

The schedule's starting message was:
> "Visit and scan the website https://www.design4space.com.sg/. Report issues that are directly observable from the site..."

Emma completed the scan correctly (Playwright browser tools). The user then sent a follow-up in the same session:
> "write a short message to inform Connie about the results and suggested changes"

Emma's response to this follow-up:
1. Installed "CRM & Lead Management" skill (via `install_skills`)
2. Called `get_lead_lists` — checked for existing lead lists
3. Called `create_lead_list` — created a new list "Website Audit Contacts"
4. Called `add_leads_to_list` — added Connie as a CRM contact
5. Called `get_leads` + `update_email_draft_for_lead` — created a full email campaign draft

The user wanted a short text message to copy/paste. Emma instead built a full CRM workflow.

In addition, `install_skills` was called 3 times total across the session (Browser automation, CRM & Lead Management, other_skills), reflecting the same pattern: Emma installs whatever skill it thinks it needs, even when the requested output is plain text.

## Root Cause

Emma's system prompt instructs it to "analyze every request, identify all required skills/tools, and install them before executing." There is no rule saying: if the output is text, just write it — don't create data records.

When Emma saw "write a message to Connie," it interpreted this as needing CRM infrastructure (find the contact, draft a personalized email template, save to campaign). The system prompt actively encourages this kind of over-tooling via the Analyze-Install-Execute protocol.

### Relevant System Prompt Location

`backend/src/services/agentModeService.ts` — `getMarketingSystemPrompt()` method (~line 2046), the `## Critical Rules` section. This is where tool usage rules live.

## Fix Considered

Adding two Critical Rules to the system prompt:
- **Minimum Necessary Tools**: Only install skills when the output genuinely cannot be produced without them. "Write a message" = write text, no tools needed.
- **No Unsolicited Data Creation**: Never create persistent records (lead lists, contacts, GTM plans, campaigns) unless the user explicitly asks.

## Decision

**No action taken.** The fix direction is correct but the impact of modifying Emma's core system prompt is unclear. The Analyze-Install-Execute protocol is central to Emma's behavior across many workflows; adding blanket "don't use tools" rules could break legitimate flows where CRM or campaign tools are genuinely needed. The risk/reward tradeoff is uncertain without more testing.

**Longer-term options to consider:**
1. Add the two Critical Rules above and A/B test against a sample of real sessions
2. For scheduled chat sessions specifically, inject a stricter constraint in the schedule context (already injected at `agentModeController.ts:1403`) — e.g. "Only use tools required to complete the stated task. Do not install additional skills or create new records."
3. Add a session-level "allowed tool categories" config on the schedule definition, so the schedule creator can restrict which skill categories Emma can use at runtime

---

# April 6, 2026: Investigation — Claude Code Source Analysis (Agent Architecture Patterns)

## Background

Anthropic's Claude Code CLI source was recently deobfuscated and analyzed by the community (~386K–500K lines, ~1,900 files). Two primary analysis repositories surfaced:
- `github.com/chat2dev/ClaudeCodeAnalysis` — 7-part architectural breakdown
- `github.com/luzhenqian/Claude-Harness` — 31-article deep-dive series

Investigated what patterns could be borrowed into AgentWeb's agent infrastructure (`agentModeService.ts`, `toolRegistry.ts`, Emma pipeline).

## Key Findings

### 1. Tiered Context Compaction (three layers, zero-cost first two)

Claude Code uses a three-layer compaction strategy triggered before context overflow:

- **Layer 1 (free)**: Replace old `tool_result` content with `[result cleared]` placeholders. No LLM call — the model has already acted on these results.
- **Layer 2 (free)**: Use a pre-built "session memory" object maintained in the background after each turn (key decisions, completed actions, open questions). No extra API call — the summary is ready when needed.
- **Layer 3 (LLM call)**: Full summarization via a forked agent with an `<analysis>`/`<summary>` prompt structure. Strips reasoning from the stored output.

**Circuit breaker**: After 3 consecutive compaction failures, auto-compaction is disabled for the session. This was added after a production incident where 1,279 sessions experienced 50–3,272 consecutive failures, wasting ~250K API calls/day.

### 2. Hybrid Token Counting

Rather than re-estimating the full message history every turn (slow) or using pure heuristics (inaccurate), Claude Code uses the last API response's `usage.prompt_tokens` as an anchor and only estimates deltas for new messages (~4 chars/token). Four pressure thresholds: warning → auto-compact → blocking → effective-window.

AgentWeb already captures `response.usage` at `agentModeService.ts:1429-1445` — this data is available to implement the same pattern without any API changes.

### 3. Tool Safety Metadata + Smart Concurrency

Each tool declares `isConcurrencySafe(input)`, `isReadOnly(input)`, and optional `isDestructive(input)` at the type level. The `StreamingToolExecutor` runs read-only tools in parallel and serializes write tools. Critically, `isConcurrencySafe` accepts the actual input (same tool can be safe or unsafe depending on what it's operating on).

AgentWeb's `ToolRegistry` currently has no such metadata — `AgentTool` is `{name, definition, execute}` only. Tools already run in parallel (`agentModeService.ts:1503-1505`) but with no write-safety guarantee.

### 4. Tool Pair Integrity on Context Trim

When pruning old messages, Claude Code enforces that a `tool_use` (assistant message) is never left without its matching `tool_result`. An orphaned `tool_use` causes certain LLMs (especially Claude-family) to return an API error. The function `adjustIndexToPreserveAPIInvariants` enforces this.

AgentWeb's `trimToolMessagesForContext` (`agentModeService.ts:13144`) only trims `tool` role messages — it does not check or remove the paired assistant `tool_calls` block. This is a latent correctness issue for very long sessions.

### 5. Analysis-Output XML Separation in LLM Prompts

For complex structured outputs, Claude Code prompts include `<analysis>` (reasoning, gets stripped) and `<summary>` (output, gets stored) tags. The analysis block gets stripped before storing — the model reasons without the reasoning eating into future context budget. This reliably improves quality for structured generation (work plans, summaries, reports).

### 6. Max-Tokens Recovery Message

Claude Code's continuation injection explicitly bans preamble:
> *"Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces."*

AgentWeb's current version (`agentModeService.ts:1463`) says *"Please continue exactly where you left off"* — allows the model to start with an apology and restatement before resuming.

### 7. Error Withholding Pattern

Recoverable errors (`max_output_tokens`, `prompt_too_long`, media-size) are withheld from the caller while recovery is attempted. The error is only surfaced if all recovery strategies fail. This prevents SDK consumers from terminating sessions on transient errors.

AgentWeb has basic max-tokens continuation (3x) and backup model fallback, but `prompt_too_long` has no recovery path — it propagates immediately to the user.

## Current AgentWeb Gaps vs. Claude Code

| Area | AgentWeb Current | Claude Code Pattern |
|------|-----------------|---------------------|
| Context compaction | `trimToolMessagesForContext` (crude truncation) | 3-layer tiered strategy with circuit breaker |
| Token awareness | None | Hybrid counting + 4 pressure thresholds |
| Tool safety metadata | None (`AgentTool` has no `isReadOnly`) | `isConcurrencySafe`, `isReadOnly`, `isDestructive` per-tool |
| Tool pair integrity | Not enforced | `adjustIndexToPreserveAPIInvariants` |
| Prompt quality | Direct prompts | `<analysis>`/`<output>` separation for structured generation |
| Recovery message | Allows preamble | Explicitly bans apology/recap |
| `prompt_too_long` | Propagates immediately | Reactive compaction + retry |

## Decision

**No immediate adoption** — AgentWeb sessions are not yet long enough to make context compaction a user-visible problem. No urgent need to invest the engineering time.

**Future work signal**: If any of the following happen, revisit these patterns:

- Long agent sessions (>50 turns) start failing or degrading in quality
- Context window errors appear in production logs (`prompt_too_long` / 400 errors)
- Users report agents "forgetting" earlier context in long sessions
- We add sub-agent / coordinator-worker orchestration (then tool safety metadata becomes critical)

**Prioritized if/when adopted** (easiest wins first):
1. Fix max-tokens recovery message (1-liner, `agentModeService.ts:1463`)
2. Tool pair integrity in `trimToolMessagesForContext` (prevents latent API errors)
3. `<analysis>`/`<output>` separation in work plan / GTM plan generation
4. `isReadOnly` / `isDestructive` metadata on `AgentTool` interface
5. Token pressure thresholds using existing `response.usage` data
6. Full tiered context compaction (largest investment, highest long-session impact)

---

# April 4, 2026: Investigation — Axios Supply Chain Attack (AWS Security Alert)

## Background

Received an AWS Security email warning that our organization "may have been the target of potentially inappropriate activity" related to malicious axios npm package versions `1.14.1` and `0.30.4`, published March 30–31, 2026 via a hijacked maintainer account.

AWS recommended checking for network connections to `142.11.206.73:8000` during March 31, 5:15–8:15 PM PDT, rotating credentials on affected hosts, and auditing CloudTrail.

## Investigation

### Axios versions in our lock files

| Component | Resolved axios version | Status |
|---|---|---|
| backend | 1.9.0 | Safe |
| partner-portal | 1.11.0 | Safe |
| customer-portal | 1.11.0 | Safe |
| agent-engine | Python only — no axios | Not applicable |

The `1.14.1` hits that appeared in the lock file grep were for `tslib` (a TypeScript utility), not axios.

### Why we were never exposed

- **`npm ci` everywhere**: CI pipeline and cloud-dev test env both use `npm ci`, which installs exact lock file versions — no semver range resolution occurs.
- **Lock files were clean during the attack window**: Confirmed via `git show 32c1b508:backend/package-lock.json` — backend had axios `1.9.0` as of the March 31 commit. No package-lock.json changes landed during March 30–31.
- **EB deploys bundle the lock file**: The zip artifact includes `package-lock.json`, so EB also installs only locked versions.
- **Agent engine is Python**: No axios dependency at all.

### AWS Health Dashboard

Checked the Affected Resources tab — no resources listed. This confirms the alert was a false alarm. AWS sent these notifications broadly to any account that uses axios as a dependency, as a precautionary measure.

## Conclusion

No compromise. No credential rotation needed. No affected hosts.

The `package.json` semver ranges (`^1.9.0`, `^1.7.9`) would theoretically allow resolving to `1.14.1` under a bare `npm install`, but since all install paths use `npm ci` the lock file versions were always used. The malicious versions were removed from npm shortly after discovery. Low-priority housekeeping: update lock files to pin axios past `1.14.1` when convenient.

# March 29, 2026: Investigation — Sonnet 4.6 vs Opus 4.6 Cost & Quality Comparison for Agent Mode

## Problem

Agent Mode defaults to Opus 4.6 (`anthropic.claude-opus-4-6-v1`) for all sessions. Opus is the most expensive Claude model. Need to determine whether switching the default to Sonnet 4.6 would meaningfully reduce costs without degrading output quality for typical marketing tasks.

## Approach

Ran identical marketing tasks on both models using the test account (`test@example.com`) and compared cost, token usage, and output quality.

### Tasks Tested
1. **SWOT Analysis** — "Create a SWOT analysis for my business"
2. **LinkedIn Posts** — "Create 3 LinkedIn posts for my business"
3. **Email Nurture Sequence** — email marketing content
4. **Brand Guidelines Review** — brand strategy analysis
5. **Competitor Analysis** — competitive landscape research

## Results

### Cost Comparison (Same Tasks, Same Account)

| Task | Sonnet 4.6 Cost | Opus 4.6 Cost | Opus Premium |
|------|-----------------|---------------|--------------|
| SWOT Analysis | $0.091 | $0.677 | **7.4x** |
| LinkedIn Posts | $0.062 | $1.270 | **20.5x** |

**Average: Opus costs ~14x more per session for comparable marketing tasks.**

### Sonnet 4.6 — Full Test Results

| Task | Session | Cost | Output Tokens |
|------|---------|------|---------------|
| SWOT Analysis | 9246850b | $0.091 | 10,526 |
| LinkedIn Posts | 53c768c5 | $0.062 | ~7,000 |
| Email Nurture | d41e9b3c | $0.062 | ~7,000 |
| Brand Guidelines | dfdc46b6 | $0.106 | ~10,000 |
| Competitor Analysis | 067d7bd5 | $0.159 | ~14,000 |

**Average Sonnet session cost: $0.096**

### Opus 4.6 — Test Results

| Task | Session | Cost | Output Tokens |
|------|---------|------|---------------|
| SWOT Analysis | d3173b8a | $0.677 | 10,468 |
| LinkedIn Posts | 9b0603f3 | $1.270 | 8,654 |

**Average Opus session cost: $0.974**

### Pricing Reference

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|------------------------|
| Sonnet 4.6 | $3 | $15 |
| Opus 4.6 | $15 | $75 |

## Quality Assessment

Both models produced **excellent, production-quality** marketing outputs:

- **SWOT Analysis**: Both generated comprehensive strategic frameworks with tables, bullet points, and actionable recommendations. Indistinguishable quality.
- **LinkedIn Posts**: Both created well-crafted content. Opus was slightly more "feature-aware" — it discovered and used the `create_social_media_posts` tool to save posts directly, while Sonnet presented them inline. The extra tool usage drove Opus cost much higher.
- **Email/Brand/Competitor tasks** (Sonnet only): All produced thorough, well-structured outputs comparable to what Opus would generate.

### Key Observation

Opus's main advantage is being more likely to discover and use platform tools (e.g., `create_social_media_posts`, `install_skills`). However, this increases cost significantly (more iterations, more tool calls) and the end-user output quality is equivalent.

## Projected Monthly Savings

Assuming ~500 agent mode sessions/month:
- **Opus monthly cost**: ~$487 (500 × $0.974)
- **Sonnet monthly cost**: ~$48 (500 × $0.096)
- **Potential savings**: ~$439/month (~90% reduction)

## Recommendation

**Switch the default model to Sonnet 4.6.** The quality difference is negligible for marketing tasks, and the cost savings are dramatic (7-20x per session). Opus can remain available as a manual selection in the model dropdown for users who want it.

### Also Investigated: Auto_CostSaving Meta-Model

Explored building an `Auto_CostSaving` meta-model that dynamically routes between Claude models per iteration based on task complexity. Implementation was completed but ultimately unnecessary — since Sonnet handles all tested tasks at equivalent quality, a simple default switch is cleaner than a dynamic routing system.

**Decision:** Discard Auto_CostSaving code; switch default model to Sonnet 4.6 instead.

---

# March 28, 2026: Investigation — SESSION_MESSAGE_LIMIT_EXCEEDED on Scheduled Chat (BirdDog Blog Articles)

## Problem

Schedule `527a6748-abc5-4475-aa1e-e9e77cd09d09` ("BirdDog Blog Articles", user `7856055c-298f-4478-ba4c-183240fe2db2`) failed after ~80 minutes with:

```
SESSION_MESSAGE_LIMIT_EXCEEDED: Adding 14 message(s) would exceed the maximum of 300 messages per session (current: 289). Please start a new session to continue the conversation.
```

Session: `e1694c29-ca30-42cf-981a-2a30f1ed2eda`

## Root Cause

**The LLM refused to call `search_web` despite it being listed as a required function in the schedule config.** The `runVerifiedChat` retry loop kept requesting the LLM to call `search_web`, but the LLM repeatedly declined or ignored the instruction, causing the loop to retry up to its max attempts. Each retry added ~12-18 messages (user prompt + LLM response + tool calls + tool results), and after ~15 attempts the session had accumulated 289 messages — 11 short of the 300 hard limit.

This is fundamentally a **prompt-following issue** — the LLM did not comply with the instruction to call `search_web`, and the retry mechanism had no way to detect that the LLM was systematically refusing a specific tool call vs. simply needing another attempt.

A secondary issue: `runVerifiedChat` had **no pre-flight check** on the session message count before retrying, so it kept retrying until it hit the hard limit and crashed instead of stopping gracefully.

## Fix

1. **Config fix (immediate):** Removed `search_web` from `requiredFunctionCalls` in the schedule config. The tool is not essential for blog article generation — the LLM calls it organically when needed, and forcing it via `requiredFunctionCalls` creates a brittle dependency on the LLM's willingness to comply.

2. **Code fix (defensive):** Added a pre-flight message count check in `runVerifiedChat` (`agentModeController.ts`). Before each retry, the session's `messageCount` is compared against `MAX_MESSAGE_SIZE_PER_SESSION - 50`. If within 50 messages of the limit, the retry loop breaks gracefully and returns the partial result instead of crashing.

## Lesson

- **Don't require tool calls that aren't essential.** If the LLM can produce acceptable output without calling a specific tool, don't add it to `requiredFunctionCalls`. The retry loop will burn through attempts (and messages) trying to force a tool call the LLM may not see as necessary.
- **LLM prompt-following is not guaranteed** — especially for tool calls the model deems irrelevant to the task. Design retry logic to degrade gracefully rather than assuming the LLM will eventually comply.
- **Session message limits need proactive checking**, not just reactive enforcement. The hard limit at 300 was only checked when writing messages, not when deciding whether to retry.

---

# March 28, 2026: Investigation — Why Some Sessions Do Not Have Usage Data

## Problem

Some chat sessions in `AW-ChatSessions` have no `totalTokens` or `totalCost`, even though they contain messages and had LLM calls. Need to determine scope and root cause.

## Investigation

Analyzed last 500 sessions in production (queried `AdminUpdatedAtIndex`).

### Data Breakdown

| Portal Type | Total | With Usage | Without Usage | Multi-Msg Without Usage |
|-------------|-------|------------|---------------|------------------------|
| agent       | 118   | 96         | 22            | 4                      |
| emma-sidebar| 202   | 1          | 201           | 0                      |

### Emma-sidebar sessions (201 without usage) — NOT A BUG

These are auto-created sessions when a user navigates to a page. 196 of 200 `messageCount=1` sessions have `updatedAt ≈ createdAt` (within 1 second) — the session was created with a system message in AW-ChatMessages, but the user never actually chatted. No LLM calls were made.

The 1 Emma session that had a real conversation (7 messages) correctly has usage data.

### Agent sessions with messageCount=0 (18 without usage) — NOT A BUG

Sessions created but never started (e.g., predefined work plans set up but user hasn't interacted).

### Agent sessions with messages but no usage — 4 sessions

| Session | Type | Msgs | Model | Root Cause |
|---------|------|------|-------|------------|
| `f8cf70d9` | predefined-work-plan | 30 | gemini-3-pro | **Pre-dates usage tracking** (created 2026-03-16, earliest session with usage is 2026-03-26) |
| `c3615c1c` | predefined-work-plan | 25 | claude-opus-4-6 | **Same** — created 2026-03-16 |
| `a19cc80d` | scheduled | 2 | gemini-3.1-pro | Only system+user msgs, **AI response never persisted** (worker timeout/crash) |
| `1e5af232` | regular (slack-bot) | 2 | undefined | Only system+user msgs, **AI response never persisted**, model undefined |

### Root Causes

1. **Historical sessions**: Sessions created before usage tracking was deployed (pre March 26). All messages have `hasUsage=false`. No fix needed.

2. **Failed/incomplete sessions**: Worker crashed or timed out during `generateMarketingResponse`. Usage is completely lost because:
   - Usage extraction only happens when `response.responseMessages` are persisted via `addMessagesToSession`
   - If worker throws/times out, `responseMessages` is never populated
   - `incrementTokenUsage()` at chatbotService.ts:803 is never reached
   - No fallback to capture partial usage from the worker process

### Gap: Usage Lost on Worker Failure

When `generateMarketingResponseWorkerService.runInWorker()` fails:
- User message: saved (before worker call)
- AI response messages: NOT saved
- Token usage on session: NOT tracked
- User token allowance: NOT decremented (even though LLM was called)
- Error message: saved for scheduled sessions only

The worker (generateMarketingResponseWorker.ts) catches errors and sends them back to the parent process, but the error message contains no usage data. The LLM may have been called (and tokens consumed) before the error occurred.

## Architecture Note

**`chatbotService.ts` is legacy infrastructure** — it powers the partner portal chatbot and provides shared DB operations (session CRUD, message persistence, token tracking). The primary intelligence service is **`agentModeService.ts`** (Agent Mode), which handles all agent, emma-sidebar, scheduled, and Slack bot sessions. The `generateChatResponse()` function in chatbotService is only used by the partner portal's `/api/chatbot` endpoint and is not actively maintained. Future work should consolidate onto the Agent Mode path and deprecate the chatbot-specific response generation.

## Recommendations

1. **Capture partial usage on worker failure**: When the worker throws, include accumulated usage data in the error payload so the parent can still call `incrementTokenUsage()`.
2. **Backfill historical sessions**: For sessions created before usage tracking (pre March 26), usage data is unrecoverable since individual message usage was never recorded.
3. **Monitor for incomplete sessions**: Add alerting for sessions where `calledFunctions` is populated but `totalTokens` is missing — indicates a worker failure with lost usage.

# March 27, 2026: Investigation — Sessions Not Showing Up in Customer Portal

## Problem

Admin page (Users tab) shows 15+ sessions for a customer (`harshitshah1989@gmail.com`), but the customer portal only shows 1 session. The session counts between admin and customer views are inconsistent.

## Root Cause

**Portal type filtering mismatch between admin count and customer portal query.**

### Production data for the affected user (userId: `100c8fa5-8444-4dfb-81b3-805f29d8e39e`)

- **16 total sessions** in `AW-ChatSessions`
  - 1 session with `portalType = 'agent'` (main agent chat)
  - 15 sessions with `portalType = 'emma-sidebar'` (Emma assistant sidebar)
  - None archived

### Admin page count (`db.ts` → `getChatSessionCount`)

Queries `AW-ChatSessions` `UserIdIndex` with only an archived filter — counts ALL session types:
```
COUNT(sessions WHERE userId = :userId AND (archived not set OR archived = false))
```
Result: **16 sessions**

### Customer portal list (`agentModeController.ts:1570`)

Defaults `portalType` to `'agent'` when not passed by the frontend:
```typescript
const portalType = (req.query.portalType as string) === 'emma-sidebar'
  ? 'emma-sidebar' as const : 'agent' as const;
```
The frontend hook (`useAgentModeSessions.ts` → `loadSessions`) calls `GET /api/agent-mode/sessions?limit=50` without a `portalType` parameter, so it defaults to `'agent'` and only returns agent sessions.

Result: **1 session**

### Additional note on emma-sidebar session creation

The 15 emma-sidebar sessions were created in rapid bursts (many within seconds of each other around 09:13 and 09:59 UTC on March 26), suggesting repeated page loads or sidebar reconnections are creating new sessions each time.

## Fix Options

1. **Fix admin count** — filter `getChatSessionCount` by portalType so it matches what the customer sees (or show a breakdown)
2. **Show emma-sidebar sessions in customer portal** — include them in the session list
3. **Both** — accurate admin counts AND full session visibility in customer portal

---

# March 27, 2026: Investigation — Landing Page Preview URLs Returning `not_found`

## Problem

The coding agent's `get_landing_page_preview_url` tool was consistently returning `buildStatus: "not_found"` for draft branch preview deployments. Observed in session `2db6affe-75f1-4502-8cbc-5e2c476dab6b` (Waldium hero banner redesign) — the tool was called 3 times, all returning not_found despite the draft branch having valid commits pushed via the GitHub API.

## Root Cause

**Two Vercel projects existed for the same customer**, created at different times:

1. **Original project** (`waldium-lander`, `prj_P6X3YHKGydAVFN3xtml1dxl1Haqo`) — linked to the consolidated repo `AgentWebPro/v0-waldium-lander`, serving production at `start.waldium.com`, receiving all branch push webhooks and creating preview deployments correctly.
2. **Auto-generated project** (`lp-waldium-value-first-landing-pa-0ae94752`, `prj_ZlAxFRUuxfowuTCAsjyiDngVBj0p`) — created by the `createVercelProject()` flow in `v0Service.ts` when a new landing page was generated. Linked to a stale auto-generated repo `AgentWebPro/lp-waldium-value-first-landing-pa-0ae94752`, which had no draft branches and no recent deployments since March 18.

All 5 Waldium landing page records in `AW-LandingPages` had `vercelProjectId` pointing to the **wrong** (auto-generated) project. When `getPreviewDeploymentUrl()` queried Vercel's deployments API for `prj_ZlAxFRUuxfowuTCAsjyiDngVBj0p`, it found no deployments matching the draft branch — because the coding agent pushed code to `v0-waldium-lander`, which only the original project was watching.

## Investigation Steps

1. Retrieved session data from `AW-ChatSessions` — `calledFunctions` showed `get_landing_page_preview_url` called 3x, `coding_agent` called 2x (retried after preview failure).
2. Confirmed draft branch `draft/2db6affe-75f1-45` existed in `AgentWebPro/v0-waldium-lander` with 4 commits.
3. Used Vercel API (token from `dev/AgentWeb/Vercel` in Secrets Manager) to list deployments on the DB-referenced project — found only `main` branch deployments from March 18, zero draft branch deployments.
4. Discovered a second Vercel project (`waldium-lander`) linked to the correct repo, which had READY deployments for all draft branches including `draft/2db6affe-75f1-45`.

## Fix

Updated `vercelProjectId` in `AW-LandingPages` DynamoDB table for all affected records:

**Waldium** (5 pages): `prj_ZlAxFRUuxfowuTCAsjyiDngVBj0p` → `prj_P6X3YHKGydAVFN3xtml1dxl1Haqo`
**Haven** (2 pages): `prj_CRoy9Bt1h23v4az2NrRvRpq5DsRz` → `prj_U38WBYiLKZdjh1IUcfyIBhQTtzaE`

Full prod scan of all 32 landing pages across 6 Vercel projects confirmed only Waldium and Haven were affected. Other customers (xCures, AgentWeb SEO, Your360, AgentWeb Main) had matching repo/project configurations.

## Lesson

When a customer's landing pages are consolidated into a single `v0-*` GitHub repo, the `vercelProjectId` in DynamoDB must be updated to match the Vercel project that is actually linked to that repo. The auto-generated `lp-*` Vercel project (created by `createVercelProject()` during initial page generation) becomes stale after consolidation.

To diagnose similar issues in the future:
- Compare `githubRepoUrl` in `AW-LandingPages` against the Vercel project's `link.repo` via `GET /v9/projects/{id}`
- If they point to different GitHub repos, the preview URL flow is broken

---

# March 26, 2026: Investigation — Recurring S3 DeleteObject Errors on Prod EB

## Problem

EB event notifications for the production environment (`Agentweb-backend-env-prod-3`, `e-ag9bmkfczz`) were reporting S3 permission errors. The `agentweb-test-env-ec2-role` lacked `s3:DeleteObject` on the EB bucket, causing cleanup failures for both tail logs and bundle logs:

**Tail logs** (from cron-based log monitoring):
```
Service:Amazon S3, Message:User: arn:aws:sts::992382574572:assumed-role/agentweb-test-env-ec2-role/i-07d440d734bbbcf55
is not authorized to perform: s3:DeleteObject on resource:
"arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572/resources/environments/logs/tail/..."
```

**Bundle logs** (from manual `request-environment-info --info-type bundle`):
```
Service:Amazon S3, Message:User: arn:aws:sts::992382574572:assumed-role/agentweb-test-env-ec2-role/i-03e403b3c8620a994
is not authorized to perform: s3:DeleteObject on resource:
"arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572/resources/environments/logs/bundle/..."
```

## Root Cause

When any IAM role calls `aws elasticbeanstalk request-environment-info`, EB uploads logs to S3 and later tries to clean up (delete) old log files **using the caller's IAM role**. The `agentweb-test-env-ec2-role` had `elasticbeanstalk:RequestEnvironmentInfo` and `elasticbeanstalk:RetrieveEnvironmentInfo` but **not** `s3:DeleteObject` on the EB bucket. EB successfully collected and returned logs, but cleanup failed every time, generating ERROR events.

## Fix

Added `s3:DeleteObject` permission to `agentweb-test-env-ec2-role`, scoped to the entire EB bucket:

```json
{
  "Sid": "AllowEBLogCleanup",
  "Effect": "Allow",
  "Action": "s3:DeleteObject",
  "Resource": "arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572/*"
}
```

Verified the fix by successfully deleting a bundle log object that previously failed.

## Lesson

When granting EB log retrieval permissions to an IAM role, also grant `s3:DeleteObject` on `elasticbeanstalk-<region>-<account>/*` so EB can clean up temporary log fragments (both tail and bundle types).

---

# March 25, 2026: Investigation — LiteLLM Vulnerability Impact on AgentWeb

## Background

Multiple CVEs have been disclosed against **LiteLLM** (BerriAI's LLM proxy/gateway library):

| CVE | Score | Severity | Description |
|-----|-------|----------|-------------|
| CVE-2024-4888 | 8.1 | High | Arbitrary file deletion via `/audio/transcriptions` endpoint |
| CVE-2024-10188 | 7.5 | High | DoS via `ast.literal_eval` on user input |
| CVE-2025-45809 | 5.4 | Medium | SQL injection via `/key/block` and `/key/unblock` API endpoints |
| CVE-2025-11203 | 3.5 | Low | API key information disclosure via health endpoint |

## Investigation Findings

**AgentWeb is NOT impacted.** LiteLLM is neither a direct nor transitive dependency.

### What we checked

- `agent-engine/requirements.txt` — no litellm
- `agent-engine/environment.yml` — no litellm
- `backend/package.json` — no litellm
- Full codebase grep for "litellm" — zero code references
- Transitive dependency check: browser-use, ag2 (AutoGen), and langchain packages do not pull in litellm

### How AgentWeb integrates with LLMs instead

AgentWeb uses direct SDK integrations, not a proxy layer:
- **AWS Bedrock SDK** — for Claude models (via `@aws-sdk/client-bedrock-runtime`)
- **Azure OpenAI SDK** — for GPT-4o/GPT-4.1
- **Google GenAI SDK** — for Gemini models
- **OpenAI SDK** — direct API access
- **LangChain** — abstraction layer in agent-engine (does not depend on litellm)

### Conclusion

No remediation action required. AgentWeb's direct-SDK approach avoids the proxy-layer attack surface that LiteLLM exposes.

---

# March 24, 2026: Investigation — Meta Pixel / CAPI Detection on Landing Pages

## Problem

Agent mode session `6219e856-e54a-45cb-b82f-2d14598957bc` (Your360.ai) generated a Meta Ads optimization report that flagged "No conversion tracking" as a critical blocker — the "Results" columns in Meta Ads Manager were empty, suggesting the Meta Pixel or Conversions API was not firing on lead form submissions.

## Investigation Findings

Double-checked Facebook Ads Manager directly. The **Event Match Quality score is 8.3** — pixel tracking is actually working correctly. The pixel is implemented through **PixelFlow** (a third-party pixel management tool), which is why it was not detected by our agent during the page inspection. PixelFlow loads the pixel asynchronously/indirectly, making it invisible to standard DOM-based pixel detection methods.

### Root Cause

Our agent's analysis relied on inspecting the landing page source for Meta Pixel base code (`fbq('init', ...)` or `connect.facebook.net/en_US/fbevents.js`). Since PixelFlow injects the pixel through its own loader, the standard detection approach missed it entirely, leading to a false-positive "no pixel installed" finding in the report.

### Next Steps

Enhance the Meta Ads API integration to support loading **Event Match Quality** scores directly from the Facebook Marketing API. This will allow future analyses to verify pixel health programmatically rather than relying solely on page source inspection. Key endpoints to integrate:

- `GET /{pixel-id}?fields=data_use_setting,event_match_quality` — pixel-level match quality
- `GET /{ad-account-id}/customconversions` — custom conversion event health

This will make the agent's pixel/CAPI assessments more accurate and avoid false positives when third-party pixel managers (PixelFlow, Google Tag Manager, Segment, etc.) are used.

---

# March 23, 2026: Investigation — Supporting Vendor Role in the System

## Background

Currently the system has two roles: **admin** (`isAdmin: true`) and **user** (default). We want to add a **vendor** role so external partners (e.g., agencies, consultants) can access the platform with appropriate permissions.

## Investigation

### Current Role Model

- Users table (`AW-Users`) has an `isAdmin` boolean field
- Backend `authenticateToken` middleware sets `req.user.isAdmin` from the JWT
- Admin checks are scattered across routes using `if (!req.user.isAdmin)` guards
- Frontend checks `user.isAdmin` from AuthContext to show/hide admin features

### Options Considered

1. **Add a `role` enum field** (`"admin" | "user" | "vendor"`) — cleaner long-term but requires migrating all `isAdmin` checks across backend and frontend
2. **Add `isVendor` boolean** — minimal change, mirrors `isAdmin` pattern, but doesn't scale if more roles are added
3. **Grant vendor users admin role temporarily** — zero code changes, quickest path

### Decision

For now, we grant vendor user **Harshit** the admin role for simplicity. This avoids any code changes and unblocks vendor access immediately. A proper role system can be implemented later when requirements are clearer and more vendors need distinct permissions.

### Action Taken

- Harshit's user record updated with `isAdmin: true` in the Users table

---

# March 22, 2026: Investigation — Scheduled Chat "Lead Auto-Enrichment" Not Completing

## Problem

User reported that the "Lead Auto-Enrichment" scheduled chat (scheduleId: `35b7c3eb-9cf2-4a61-b259-5b12040a302e`) was "not completing the requested ask" for three days in a row.

## Investigation Findings

The schedule was actually completing successfully — all three runs (March 20 attempt 1, March 20 attempt 2, March 21 attempt 2) had `status: "success"` and `passed: true` with all work plan steps completed.

The user's concern was that lead enrichment "didn't happen." Root cause: **enriched fields were written to custom fields** in the CRM, not the standard fields the user was checking. The enrichment was working correctly, but the results were in a different place than expected.

### Schedule Details

- **Prompt:** Enrich leads from 6 CRM lists, recommend top 10 for LinkedIn outreach, draft 2 post-connection messages
- **Model:** `anthropic.claude-opus-4-6-v1`
- **Validation:** `functionCallMinCalls: { linkedin_outreach: 1 }` — note: this requirement exists but the prompt only asks to "draft" messages, not send them. All runs passed validation regardless.
- **Runs examined:** 3 sessions, all enriching 214-221 leads with 0 failures

### Resolution

No code change needed. User confusion about where enriched data appears in the CRM (custom fields vs standard fields).

---

# March 20, 2026: Investigation — UseHaven.ai Meta Marketing Connected Account Issue

## Problem

Two issues reported by UseHaven.ai (usehaven.ai) when connecting Meta Marketing accounts:

1. **Matt (existing user):** When connecting Meta Marketing, Facebook asks him to reconnect because he previously connected with a different account.
2. **Harsha (new user):** When attempting to connect, sees an "App does not exist" error.

## Investigation Findings

### Architecture Overview

- Meta OAuth flow: `metaAuth.ts` handles init → Facebook Login popup → callback → finalize (token exchange) → connect-ad-accounts
- Credentials stored in AWS Secrets Manager at `prod/AgentWeb/MetaApp` (contains `clientId`, `clientSecret`, `instagramClientId`, `instagramClientSecret`)
- Connected accounts stored in DynamoDB `AW-Users` table under `connected_accounts` array
- Token sessions stored in-memory with 10-minute TTL

### Root Cause: App in Development Mode

The "App does not exist" error for Harsha is caused by the **Meta/Facebook App being in Development Mode**. In Development Mode, only users listed as App Admins, Developers, or Testers in the Facebook App settings can use the OAuth flow. All other users see "App does not exist."

Matt could connect because he was likely added as a tester/developer on the app. The "reconnect" prompt is standard Facebook behavior when a user re-authorizes an app — Facebook remembers the prior authorization and asks to confirm.

### Actions Taken

1. **Made the app Live** — switched from Development to Live mode in Meta Developer Console
2. **Completed Data Use Checkup** — required for Live mode compliance
3. **Harshit submitted for App Review** — required for advanced permissions (ads_management, ads_read, pages_show_list)

### Key Files

- `backend/src/routes/metaAuth.ts` — OAuth init, callback, finalize, connect endpoints
- `backend/src/routes/metaV2.ts` — Ad creation API using connected account tokens
- `backend/src/config/integrations.ts` — OAuth URLs, scopes, redirect URIs
- `backend/src/utils/secretsManager.ts` — `getMetaCredentials()` and `getInstagramCredentials()`
- `backend/src/services/connectedAccountsDb.ts` — Account storage (createAccount, updateAccountTokens)
- `customer-portal/src/pages/MetaOAuthCallback.tsx` — Frontend OAuth callback handler
- `customer-portal/src/pages/Settings.tsx` — `startMetaOAuth()` initiates the flow

### Status

Pending App Review approval from Meta. Will revisit once review is complete. After approval, all users should be able to connect Meta Marketing accounts without the "app does not exist" error.

---

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

# April 5, 2026: Do Parallel Tool Calls Consume More Tokens?

**Question:** When the LLM returns multiple tool calls in a single response (parallel), does that consume more tokens compared to making them one at a time (sequential)?

**Context:** Investigated a production session (`ce0f5737`) — "Daily Slack Check — All Channels". The agent made 1 `slack_list_channels` call followed by **65 `slack_get_recent_messages` calls** that all appeared grouped after Emma's final response in the share UI. This raised the question of whether those parallel calls came from the same LLM response and how they compare to sequential calls in terms of token cost.

**How parallel tool calls work in our backend:**

When a Gemini/Claude/GPT model returns a response with multiple `tool_calls` in one API response (e.g., 30 channel fetch requests at once), `agentModeService.ts` collects all of them in a single iteration and executes them concurrently via `Promise.all()` (see `agentModeService.ts:1502–1571`). This means **all N tool calls come from the same LLM API response** — the model generated all N tool-call JSON blocks in one shot.

**Token breakdown — parallel vs sequential for N tools:**

| | Parallel (what we do) | Sequential (hypothetical) |
|---|---|---|
| LLM API calls | 1 call returns all N requests | N calls, one per tool |
| Input tokens | Sent **once** | Resent + grows each round |
| Output tokens | More per call (N tool JSONs in one response) | Less per call, but N× calls |
| **Total tokens** | **Much lower** | **Much higher** (context accumulates N×) |

**Concrete example (the investigated session):**

The session made 30 `slack_get_recent_messages` calls in parallel from a single LLM response. Compared to doing them one at a time:

- **Parallel (actual):** 1 LLM call × (context + 30 tool-call outputs) + 1 final synthesis call
- **Sequential (hypothetical):** 30 LLM calls where each input = prior context + all prior tool results accumulated

For 30 channels, the sequential approach would have sent the full conversation context ~30 extra times, each iteration slightly larger. Parallel avoids that entirely — the context is sent once and the model generates all 30 requests in a single output.

**Answer:** Yes, the single LLM response that generates N parallel tool calls has **more output tokens** than a response with 1 tool call (it has to emit N tool-call JSON blocks). But the **total token cost across the conversation is dramatically lower** than sequential, because you avoid resending the full growing context N times. For the 30-channel session, parallel saved roughly 29× the input token cost of the mid-conversation context window.

**The 65 tool calls came from 2 LLM responses:**
1. First response: `slack_list_channels` → 1 tool call
2. Second response: all 30 `slack_get_recent_messages` at once → 30+ tool calls in parallel
3. Final response: synthesis/summary (no tool calls)

The share UI groups all tool calls after the final assistant message, which made it look like they all came from one response — they didn't. The sequential `slack_list_channels` was its own round trip.

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

# March 23, 2026: Path Traversal Attack Investigation

## Problem

Production nginx logs showed a high volume of suspicious requests probing for common web vulnerabilities (PHP, Java, .env files, path traversal). Investigation needed to determine if any attacks were successful and whether the codebase is vulnerable.

## Attack Evidence from Production Logs

**1,114 malicious requests** across Mar 19–23 from automated vulnerability scanners. **All returned 404** — no successful exploitation.

### Attack Types (by volume)
| Type | Count | Description |
|------|-------|-------------|
| PHPUnit/eval-stdin | 949 | Probing for exposed PHP test suites (`/vendor/phpunit/.../eval-stdin.php`) |
| .env probe | 67 | Attempting to read environment variables (`GET /.env`) |
| Path traversal (LFI) | 47 | PHP Local File Inclusion via `index.php?lang=../../../../usr/local/lib/php/pearcmd` |
| Spring actuator | 7 | Probing for Java Spring endpoints (`/actuator/health`) |
| Other | 44 | Mixed scanner fingerprinting (`/webui/`, `/developmentserver/metadatauploader`, etc.) |

### Scanner Fingerprints
- `libredtail-http` — automated vulnerability scanner
- `Mozilla/5.0 zgrab/0.x` — zgrab network scanner
- Spoofed Chrome/Firefox user-agents for .env probes

### Key Attacker IPs
`110.35.80.116`, `75.119.137.153`, `82.24.64.32`, `118.196.74.89`, `165.154.232.244`, `34.158.79.105`, `145.223.47.104`, `45.39.7.12`, `20.163.2.150`, `20.64.106.28`, `65.49.1.142`, `48.214.144.34`

## Code Audit Findings

### No Filesystem Path Traversal Vulnerabilities
1. **No `express.static` serving** — backend doesn't serve static files from the filesystem
2. **No `res.sendFile` / `res.download`** — no file download endpoints using filesystem paths
3. **No user-input in `path.join`** — all `fs.readFileSync` calls use hardcoded paths (`docs/AGENT_API.md`, `docs/skill.md`, font files, UUID-generated temp files)
4. **Asset serving via S3** — `/asset/:assetHash` decodes a hash to S3 bucket/key, not filesystem paths
5. **File uploads go to S3** — no local filesystem storage of user uploads

### Landing Page GitHub File Endpoints — Low Risk
4 endpoints in `landingPageGeneration.ts` accept user-supplied file paths passed to GitHub API. They have `..` checks but could be hardened:
- `GET /api/landing-pages/v0/generated/:id/file-content` (line 629)
- `PUT /api/landing-pages/v0/generated/:id/github-edit` (line 415)
- `GET /api/landing-pages/v0/generated/:id/commits` (line 681)
- `GET /api/landing-pages/v0/generated/:id/file-at-commit` (line 726)

Risk is low: paths go to GitHub API (not filesystem), require auth + ownership, and Express's `qs` parser auto-decodes `%2e%2e` preventing URL-encoded bypasses.

## Conclusion

All attacks are **automated internet background noise** targeting PHP/Java/Python stacks. The Node.js/Express backend with no filesystem file serving is not vulnerable. All attack requests correctly return 404. Consider AWS WAF and nginx rate limiting for defense-in-depth.

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

## MAL-2026-2307 (Axios Supply Chain Attack) Security Check

**Date:** 2026-04-02 | **Status:** ✅ Not affected

### Summary

On 2026-03-31, the `axios` npm package was compromised and malicious versions `0.30.4` and `1.14.1` were published to npm. The compromised versions included a malicious dependency called `plain-crypto-js` that installs a **Remote Access Trojan (RAT)**. The RAT phones home to `sfrclak.com:8000/6202033` (IP `142.11.206.73`).

According to the advisory: _"Any computer that has this package installed or running should be considered fully compromised. All secrets and keys stored on that computer should be rotated immediately from a different computer."_

### Affected Versions

- `axios@0.30.4`
- `axios@1.14.1`

### AgentWeb Findings

All three components were checked and are **not affected**:

| Component | Declared | Installed | Status |
|-----------|----------|-----------|--------|
| backend | `^1.9.0` | **1.9.0** | ✅ Safe |
| partner-portal | `^1.7.9` | **1.11.0** | ✅ Safe |
| customer-portal | `^1.9.0` | **1.11.0** | ✅ Safe |

Additional IOC checks (all clean):
- No `plain-crypto-js` found in any `package-lock.json` or `node_modules`
- No references to `sfrclak.com` or `142.11.206.73` anywhere in the codebase

### References

- OSV Advisory: [MAL-2026-2307](https://osv.dev/vulnerability/MAL-2026-2307)
- GitHub Advisory: [GHSA-fw8c-xr5c-95f9](https://github.com/advisories/GHSA-fw8c-xr5c-95f9)
- StepSecurity Blog: https://www.stepsecurity.io/blog/axios-compromised-on-npm-malicious-versions-drop-remote-access-trojan

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

---

## Token Usage Optimization (2026-03-25)

### Investigation Findings (231 tracked prod sessions, March 2026)

| Metric | Value |
|--------|-------|
| Total tokens consumed | 171M |
| Total cost | $1,315 |
| Avg tokens/session | 741K |
| Median cost/session | $0.59 |
| P95 cost/session | $34.96 |
| Prompt:completion ratio | 94:1 (98.5% prompt tokens) |

**Key insight:** prompt tokens dominate because each LLM call in the iteration loop (up to 20 per turn) resends the full conversation context. A 5-iteration turn with growing context pays prompt tokens on every iteration (e.g. 10K+20K+30K+40K+50K = 150K total).

Token growth by session length:
- Short (16 msgs): 1.8x growth per call
- Medium (71 msgs): 7.7x growth
- Long (142 msgs): 7.9x growth
- Heaviest (293 msgs, $51): 2.7x growth (started large from prior scheduled runs)

### Changes Implemented

**1. Anthropic Prompt Caching via Bedrock Converse API**
- Replaced LangChain `ChatBedrockConverse` with direct `ConverseCommand` from `@aws-sdk/client-bedrock-runtime`
- Added `cachePoint` markers: one after system prompt, one before the last message
- Within the tool-call iteration loop, each subsequent call only pays full price for the newest exchange; all prior turns hit the cache (90% discount on cached input tokens)
- Cache metrics logged: `AgentMode: Bedrock cache — read: X, write: Y, uncached input: Z, output: W`
- Cost estimation updated to account for cache read (10% of input price) and write (125% of input price) tokens
- Files: `agentModeService.ts` (getBedrockClient, convertToBedrockConverse, estimateCost)

**2. Aggressive Tool Result Summarization**
- Old tool results (beyond most recent 3) now compressed to ~200-char previews: `[Tool: tool_name — preview...]`
- Previously these were truncated to 8KB each — with 50+ tool results that's still 400KB of context
- New approach reduces old tool context by ~97% while preserving tool name and a content hint
- Files: `agentModeService.ts` (trimToolMessagesForContext)

### Estimated Savings
- Prompt caching: 30-50% on Claude model sessions (system prompt + conversation prefix cached)
- Tool summarization: 20-40% additional reduction on long sessions with many tool calls
- Combined: 50-70% cost reduction expected on typical sessions

### Future Optimization Opportunities
- Context window summarization (compress old turns into a recap instead of dropping them)
- Dynamic tool filtering (only send relevant tools based on conversation context)
- Scheduled session reset (start each run with summary of prior run instead of full history)
- See "Conversation Summarization Design" section above for the summarization design

## Known Limitation: `get_chat_history` Tool Crashes on Large Time Ranges (2026-03-27)

The `get_chat_history` admin tool (used by Emma to analyze usage) crashes when querying large time ranges (e.g. 7 days). Root cause:

1. `chatbotService.getRecentSessionsPage()` with a time range does an **unbounded fetch-all-then-slice** — a `do...while` loop paginates through ALL DynamoDB pages before applying `limit` as a post-fetch `Array.slice()`. For 7 days, this fetches ~1,100+ session records into memory.
2. The admin route (`GET /api/admin/chat-sessions`) then calls `getChatSession()` for each returned session (up to 100) via `Promise.all`, loading full message content — 100 parallel DynamoDB queries.
3. The full response (100 sessions with all messages) is returned as a tool result to the LLM, which can exceed context/memory limits and crash the agent mid-stream.

**Impact:** Session `1e5af232-1164-46cb-bce5-83d76edd6734` crashed when the user asked Emma to "fetch the chat history of last 7 days, then count the total usage and cost per accounts."

**Potential fixes (not yet implemented):**
- Push `Limit` into the DynamoDB query (early termination) instead of fetch-all-then-slice
- Add a `metadata_only` mode to skip loading full messages when only counts/costs are needed
- The tool's `limit` param defaults to 100, but the DynamoDB fetch still retrieves all 1,100+ sessions before slicing

## Usage & Cost Analysis — Week of March 21–27, 2026

### Summary

| Metric | Value |
|--------|-------|
| Total sessions | 987 |
| Sessions with cost tracking | 305 (31%) |
| Sessions without cost tracking | 682 (69%) |
| Total tracked cost | $1,414.14 |
| Projected monthly cost (×4.3) | ~$6,081 |
| Avg cost/session (tracked) | $4.64 |
| Median cost/session | $0.57 |
| Unique users | 62 |

**Note:** 69% of sessions have no cost data. These are likely sessions that either (a) errored out before any LLM call, (b) used models where cost tracking wasn't implemented, or (c) are predefined-work-plan previews from anonymous users that didn't complete.

### By Subscription Tier

| Tier | Users | Sessions | Cost | Avg/User (7d) | Avg/Session |
|------|------:|---------:|-----:|---------------:|------------:|
| Super Premium | 17 | 693 | $1,138.78 | $66.99 | $1.64 |
| Advanced | 4 | 47 | $131.21 | $32.80 | $2.79 |
| Free / Anonymous | 40 | 210 | $138.34 | $3.46 | $0.66 |
| Basic | 1 | 37 | $5.80 | $5.80 | $0.16 |

Super Premium users drive **80.5%** of total cost ($1,139 of $1,414). Advanced users are the most expensive per-session ($2.79 avg) — they tend toward complex research workflows. Free/anonymous users are mostly work-plan previews (single-session anonymous users) plus a few registered Free accounts.

### Cost Distribution (305 tracked sessions)

| Percentile | Cost |
|-----------|-----:|
| Min | $0.01 |
| P25 | $0.17 |
| Median | $0.57 |
| P75 | $3.32 |
| P90 | $11.05 |
| P95 | $23.25 |
| P99 | $56.25 |
| Max | $106.76 |

The distribution is heavily right-skewed: 75% of sessions cost under $3.32, but the top 5% cost $23+ each and drive a disproportionate share of total spend.

### Top Accounts by Cost (7 days)

| Account | Tier | Sessions | Cost | Avg/Sess | Primary Activity |
|---------|------|----------|------|----------|-----------------|
| renata@your360.ai | Super Premium | 112 | $324.64 | $2.90 | Regular chats, some scheduled |
| founders@agentweb.pro (internal) | Super Premium | 199 | $215.30 | $1.08 | Regular + 50 scheduled + testing |
| amrutha@structuredlabs.com | Super Premium | 36 | $204.38 | $5.68 | Regular chats (high complexity) |
| agentwebintegration@xcures.com | Super Premium | 70 | $156.07 | $2.23 | Scheduled + regular |
| juan@usehaven.ai | Advanced | 8 | $92.72 | $11.59 | Complex regular sessions |
| dyllan@rankai.ai | Super Premium | 54 | $57.15 | $1.06 | Regular chats |
| harsha@agentweb.pro (internal) | Super Premium | 71 | $49.35 | $0.70 | Regular + scheduled + work plans |

**Key observation:** The top 5 external users (all Super Premium / Advanced) account for $834.96 (59% of total cost). Since these tiers are not yet billed, this is pure cost with no revenue offset.

### By Session Type

| Type | Sessions | Cost | Avg/Session |
|------|----------|------|------------|
| Regular (live chat) | 752 | $948.06 | $1.26 |
| Scheduled | 180 | $265.27 | $1.47 |
| Predefined work plan | 49 | $188.31 | $3.84 |
| Result endpoint | 1 | $11.95 | $11.95 |
| Video/image gen | 5 | $0.56 | $0.11 |

Predefined work plans cost ~3× more per session than regular chats — they involve multi-step workflows with many tool calls.

### Daily Trend

| Date | Sessions | Cost |
|------|----------|------|
| Mar 21 | 60 | $132.04 |
| Mar 22 | 67 | $102.67 |
| Mar 23 | 82 | $208.82 |
| Mar 24 | 85 | $427.74 |
| Mar 25 | 213 | $92.86 |
| Mar 26 | 317 | $322.91 |
| Mar 27 | 163 | $127.09 |

Session volume is growing (~3× from Mar 21 to Mar 26). Mar 24 was the most expensive day ($427.74) despite having fewer sessions — likely driven by a few high-cost complex sessions. Mar 25 had the most sessions (213) but lowest cost ($92.86), likely due to prompt caching optimizations deployed that day.

### Top 10 Most Expensive Individual Sessions

| Cost | User | Type | Title |
|------|------|------|-------|
| $106.76 | renata@your360.ai | regular | Agent Mode Session |
| $78.05 | xcures.com | scheduled | Weekly Competitor News Researcher |
| $65.14 | renata@your360.ai | regular | Adding Videos to Landing Pages |
| $56.25 | dyllan@rankai.ai | regular | SEO/GEO/AEO Competitor Ad Scraping |
| $51.90 | amrutha@structuredlabs.com | regular | Waldium Hero Banner CSS Analysis |
| $51.35 | juan@usehaven.ai | regular | Competitor Meta Ads Analysis |
| $46.76 | renata@your360.ai | regular | Meta Campaign Overview |
| $43.45 | amrutha@structuredlabs.com | regular | Landing Page Hero Banner Redesign |
| $42.59 | amrutha@structuredlabs.com | regular | Waldium Hero Banner CSS Analysis |
| $37.36 | ruiwangwarm@gmail.com | regular | Ella's Book Sale Poster |

### Revised Token Limits (March 27, 2026)

Based on the usage data above and discussion, the revised token limits are:

| Tier | Current DB Value | Monthly Token Limit | Rationale |
|------|-----------------|--------------------:|-----------|
| **Free** | Free | **1M** | ~10–15 sessions. Enough to see value, caps within first week of active use |
| **Basic** | Basic | **20M** | ~130–200 sessions. Basic users are not yet active so current data is limited; 20M provides comfortable headroom for light-to-moderate daily use |
| **Pro** | Super Premium / Advanced | **100M** | ~650–1000 sessions. Covers most Pro users comfortably (avg Super Premium user projects to ~40-50M/month). Heavy users will approach the limit |
| **Enterprise** | Enterprise (new) | **500M** | Soft cap to prevent abuse. Effectively unlimited for any realistic usage pattern |

**Tier mapping (current DB `subscriptionType` → new tier names):**
- `Free` → Free
- `Basic` → Basic
- `Super Premium` / `Advanced` → Pro
- New: `Enterprise` (not yet in DB)

**How the top users fit under these limits:**

| Account | Current Tier | Monthly Cost (proj.) | Est. Monthly Tokens | Fits in? |
|---------|-------------|---------------------:|--------------------:|----------|
| renata@your360.ai | Super Premium → **Enterprise** | ~$1,396 | ~150–200M | Yes (Enterprise 500M) |
| founders@agentweb.pro (internal) | Super Premium → **Enterprise** | ~$926 | ~100–130M | Yes (Enterprise 500M) |
| amrutha@structuredlabs.com | Super Premium → Pro | ~$879 | ~100–120M | Tight — may hit 100M limit |
| agentwebintegration@xcures.com | Super Premium → Pro | ~$671 | ~80–90M | Yes, with room |
| juan@usehaven.ai | Advanced → Pro | ~$399 | ~50–60M | Yes |
| dyllan@rankai.ai | Super Premium → Pro | ~$246 | ~30–40M | Yes, comfortable |
| harsha@agentweb.pro (internal) | Super Premium → **Enterprise** | ~$49 | ~7M | Yes |

**Key decisions:**
- **renata@your360.ai** should be upgraded to Enterprise tier — her projected ~150–200M tokens/month exceeds the Pro 100M cap.
- **Internal accounts** (founders@, harsha@, ruiw@) should be Enterprise tier to avoid hitting limits during testing/development.
- **Basic users** are not currently active, so their usage data doesn't reflect real-world patterns. The 20M limit is set generously and can be adjusted once Basic users are onboarded and billing is active.
- **Model cost multipliers** (Opus = 7x, see March 20 proposal) are still recommended to protect margins on the Pro tier. Without multipliers, a Pro user running all-Opus sessions could consume $700+ in cost against a ~$499 price point.

**Margin analysis (post-caching, GPT-5 blended ~$2/1M effective):**

| Tier | Price | Limit | Max Cost to Us | Min Gross Margin |
|------|------:|------:|---------------:|-----------------:|
| Free | $0 | 1M | ~$2 | -$2 (acquisition) |
| Basic | $199 | 20M | ~$40 | ~$159 (80%) |
| Pro | $499 | 100M | ~$200 | ~$299 (60%) |
| Enterprise | Custom ($1K+) | 500M | ~$1,000 | Negotiated |

Post-caching margins are healthy across all paid tiers. The risk is Opus-heavy Pro users (effective cost ~$14/1M with caching) — at 100M tokens that's $1,400, well above the $499 price. Model multipliers or tier-restricted model access would mitigate this.

### Prompt Caching Impact (Mar 25 deployment)

The prompt caching optimization was deployed on Mar 25. Comparing per-session costs:
- Pre-caching (Mar 21–24, 294 sessions): $870.27 → $2.96/session avg
- Post-caching (Mar 25–27, 693 sessions): $542.86 → $0.78/session avg

**~74% reduction in avg cost per session.** Even accounting for session mix variation, caching is clearly delivering significant savings. The projected monthly cost of $6,081 already reflects the post-caching rates; without caching it would have been ~$16K+/month

## Meta Ad Spending Limit Investigation (2026-04-08)

### Context

Investigated options for controlling Meta ad spend to prevent overspending when the agent creates/modifies ad campaigns on behalf of users.

### Current State

- **Budget guardrails exist in `agentModeService.ts`** (hardcoded): daily budget max $5,000, lifetime max $50,000 per ad set
- **No user-configurable spending cap** — limits are hardcoded safety rails only
- Meta ad account config stored in `AW-Users` → `connected_accounts[]` (no spending cap field)
- Primary spend control is currently via Ramp virtual credit card with a hard limit set per card

### Options Evaluated

**Option A: App-level advisory cap per connected account**
- Store a `spendingCap` field in DynamoDB alongside each Meta ad account config
- Before creating/updating ad sets, query Meta Insights API for current month spend
- Reject if projected spend would exceed cap; show spend vs cap in Settings UI
- Pros: User-configurable, visible in UI, works alongside card limit
- Cons: Relies on Meta's reported spend (slight lag), doesn't hard-stop if Meta overbills

**Option B: Meta's native Account Spending Limit (ASL)**
- Meta's Marketing API supports `spend_cap` on the ad account (`/act_{id}?fields=spend_cap`)
- Surface this in Settings so users can set/update it via our UI
- Meta natively enforces it — pauses all ads when limit is hit
- Pros: Hard stop enforced by Meta, no lag, most reliable
- Cons: Requires manual reset after billing cycle, another API call surface

**Option C: Combined A + B**
- App-level soft cap (advisory, warns before creating) + Meta-level hard cap (ultimate backstop)

**Option D: Per-session budget envelope**
- User sets a max spend for the current agent session; agent tracks total allocated across ad sets
- Pros: Very simple, no schema changes, no Meta API calls
- Cons: Doesn't account for existing scheduled spend, resets each session

### Decision

**Continue using Ramp virtual card approach for now.** Each Meta ad account is funded via a Ramp virtual credit card with a hard spending limit configured on the card. This provides a reliable, externally-enforced hard stop without any additional code complexity. Revisit in-app controls (Option A or B) if:
- We manage ad accounts for customers where card-per-account isn't practical
- Users request the ability to self-configure limits without admin intervention

## Meta Marketing API Version Upgrade to v24.0 (2026-04-14)

Meta notified that all Marketing API versions prior to v24.0 will be deprecated on June 9, 2026 (v23.0 and below). Updated `META_API_VERSION` to `v24.0` in both staging and production Elastic Beanstalk environment configs.

**Code changes (on branch `rui/upgrade-meta-api-version`):** All hardcoded `v18.0` fallback defaults in source code will be updated to `v24.0` to match the env var. Affected files:
- `backend/src/routes/meta.ts` (3 locations)
- `backend/src/services/agentModeService.ts` (2 locations)
- `backend/src/services/clientHealthService.ts` (1 location)
- `backend/src/services/metaService.ts` (3 locations)
- Test files: `metaAuth.test.ts`, `instagramService.test.ts`, `agentModeService.metaMetrics.test.ts`, `agentModeService.listMetaAdsCampaigns.test.ts`

**Note:** `backend/src/config/integrations.ts` was already at `v24.0`. No customer-portal changes needed.

## Email Verification on Sign-Up — Decision to Postpone (2026-04-16)

### Context

Investigated and implemented email verification for email/password sign-ups (Option B — soft verification with a warning banner, no access gates). The implementation is complete and tested on branch `rui/support-email-verification-in-sign-up`.

### Decision: Postpone

**We are not shipping this now.** The team introduction email already serves a partial verification purpose — every new sign-up receives a personal email from the founders, which organically surfaces invalid/throwaway addresses. Adding a second verification email on top of that would create unnecessary friction for new users at a point where conversion matters most.

**The code is parked on the branch and can be picked up later if needed.** Revisit if:
- Spam/fake account volume becomes a real problem
- A compliance requirement demands explicit email confirmation
- The team introduction email flow changes or is removed

## CRM Enrichment Cost Investigation (2026-04-16)

### Context

Investigated the API cost structure for the lead enrichment feature (`crmEnrichmentService.ts`) to understand per-lead spend across web search, LLM extraction, and LinkedIn lookup.

### APIs and Cost per Lead

| Component | Provider | Calls/Lead | Est. Cost/Lead |
|-----------|----------|-----------|----------------|
| Web Search | Google Custom Search | 1–2 (fallback on empty) | ~$0.005–0.01 |
| LLM Extraction | Gemini 3.1 Flash Lite | 1–2 (retry on parse fail) | ~$0.00015 |
| LinkedIn Lookup | Unipile | 0–3 (if LinkedIn source enabled) | ~$0.03–0.15 |
| **Total** | | **2–7** | **~$0.005–0.16/lead** |

### Key Findings

- **Web search only:** ~$0.005–0.01/lead (dominant cost without LinkedIn)
- **With LinkedIn:** ~$0.04–0.16/lead (Unipile per-profile cost dominates)
- **LLM cost is negligible** (~$0.00015/lead) given Gemini Flash Lite pricing
- Concurrency: 20 parallel workers (no LinkedIn) or 5 (with LinkedIn) — peak burst can hit Google Custom Search quotas (known issue from Feb 2026)
- **No cost tracking or metering exists** for enrichment operations; usage is not counted against user token quotas

### Model Change (2026-04-16)

Switched `SUGGEST_MODEL` from `gemini-2.5-pro` to `gemini-3.1-flash-lite-preview` to match `ENRICH_MODEL`. Field suggestion is a structured extraction task (not complex reasoning), so the cheaper/faster model is sufficient.

### Cost Tracking Decision

**Delaying cost tracking for enrichment until the feature is used more widely.** Current usage volume does not justify the instrumentation overhead. When enrichment adoption grows, add per-enrichment token/API call accounting to `tokenUsageService.ts` and meter it against user subscription allowances. Revisit when:
- Enrichment is a standard part of multiple users' workflows
- Monthly enrichment API cost becomes visible in billing analysis
- Subscription tiers need to differentiate on enrichment volume

## Work Plan Parallel Step Execution — Investigation (2026-04-17)

### Context

Investigated whether work plan steps can be executed in parallel when they don't depend on each other.

### How Work Plans Execute Today

Work plans are **linear LLM-guided checklists**, not an execution engine. Steps are injected into the LLM's prompt context via `buildMarketingContext()` (`agentModeService.ts:2221`). The LLM reads the current pending step, does the work, calls `setWorkPlanStatus()` to mark it complete, then moves to the next. There is no dispatch loop — execution is driven by the single LLM conversation thread, one turn at a time.

`WorkPlanStep` has no dependency or grouping fields today (`stepCount`, `title`, `description`, `requiredFunctionCalls`, `skillIds`).

### Why True Step-Level Parallelism Is Not Well Supported

An Agent Mode session is a **single LLM conversation thread**: one LLM turn at a time, tools execute, then the next turn starts. Parallelizing multi-turn steps (steps that require multiple rounds of tool calls and LLM reasoning) would require each step to run its own independent LLM loop. The only mechanism for that is sub-agents (via the swarm infrastructure, `backend/src/services/swarm/`), but sub-agents have isolated contexts — they can't share session state mid-execution — and add significant spawn overhead. This makes step-level parallelism via sub-agents architecturally complex with limited practical benefit for the typical plan.

### Existing Parallelism: Tool Calls

**Claude already supports parallel tool calls within a single LLM turn.** When the LLM issues multiple tool calls in one response, they execute concurrently. This is the natural and well-supported parallelism primitive in Agent Mode.

### Decision

**We will not add a parallel step execution mechanism.** Instead, steps that could logically run in parallel should be **merged into a single step** with a description that instructs the LLM to accomplish both objectives. The LLM will naturally fire the required tool calls in parallel within that one step's turn, achieving the same concurrency without any infrastructure changes.

This keeps the work plan model simple (linear checklist) and leverages parallelism that already works reliably. Revisit if a future use case genuinely requires independent multi-turn parallel workstreams — at that point, sub-agent orchestration would be the right path.

## LinkedIn Outreach — Email Finding Investigation (2026-04-16)

### Context

Investigated whether the LinkedIn outreach feature can be used to find or retrieve email addresses for prospects.

### Findings

**LinkedIn does not expose email addresses via its API.** The Unipile SDK (used by `linkedInOutreachService.ts`) returns the following fields for a LinkedIn profile: `provider_id`, `public_identifier`, `first_name`, `last_name`, `headline`, `location`, `network_distance`, `is_open_profile`, `work_experience`, `summary`, `profile_picture_url`. Email is not among them — this is a deliberate LinkedIn platform restriction, not a gap in the Unipile integration.

All 10 LinkedIn outreach actions (`search-people`, `get-profile`, `send-invite`, `send-message`, `update-conversation-history`, etc.) operate on profile URLs and provider IDs only. The CRM lead record stores the LinkedIn profile URL in the `linkedin` field but no email derived from it.

### Decision

**Finding email from LinkedIn is not supported and will not be added to the LinkedIn outreach feature.** Email discovery is an enrichment concern, not an outreach concern. If email finding from a LinkedIn profile is needed, it should be implemented as part of the CRM enrichment feature (`crmEnrichmentService.ts`) using a third-party enrichment provider (e.g. Apollo.io, which accepts LinkedIn profile URLs and returns verified business emails). This keeps outreach and enrichment concerns cleanly separated.


## Goalden Hour Meta Ad Account — Ownership Investigation (2026-04-20)

### Context

Investigated who owns the Goalden Hour ad account in Meta (Facebook) Business Manager, and what steps are needed to transfer or grant access.

### Findings

The Goalden Hour Meta ad account is currently **owned by individual people**, not by a Business Manager. Only the AgentWeb team has full (Admin) control at this time.

### Short-Term Action: Grant Goalden Hour Admin Access

To give the Goalden Hour team full operational control without transferring ownership:

1. Go to [business.facebook.com](https://business.facebook.com) → **Business Settings**
2. Click **Accounts** → **Ad Accounts** → select the Goalden Hour ad account
3. Click **Add People** → search for the Goalden Hour contact by name or email
4. Set their role to **Admin** (full control: manage people, billing, settings, run ads)
5. Click **Confirm**

This gives them full operational access while ownership stays with the current individual.

### Future Action: Transfer Ownership to Business Manager

When ready to transfer formal ownership to the Goalden Hour Business Manager:

1. The current individual owner must be cooperative
2. **Option A (preferred):** In Meta Business Manager → Business Settings → Ad Accounts → Add → **Claim an Ad Account** → enter the account ID. The individual owner approves the claim.
3. **Option B:** The individual goes to their Ad Account Settings → Ad Account Roles → adds the Goalden Hour Business Manager as Admin, then initiates a transfer.
4. **Option C (last resort):** Contact Meta Support with proof of business ownership if the individual is unreachable.

> **Caveat:** Once an ad account is claimed by a Business Manager, it cannot be moved to another Business. Confirm the correct Business Manager before claiming.

### Decision

**Short term:** Grant the Goalden Hour contact Admin access so they have full operational control immediately. **Long term:** Initiate a formal ownership transfer/claim into their Business Manager when they are ready to do so.

## Security Breach Investigation — Lovable & Vercel (2026-04-21)

### Context

Investigated whether AgentWeb is impacted by two security incidents:
1. **Lovable security breach** — Lovable (vibe coding platform) disclosed a broken object-level authorization flaw in their API that allowed unauthorized access to user projects, source code, database credentials, and AI chat histories. The vulnerability was unpatched for 48 days after discovery on March 3, 2026.
2. **Vercel security breach** — Vercel disclosed a security incident. Vercel sent official email communication confirming: *"At this time, we do not have reason to believe that your Vercel credentials or personal data have been compromised."* **Status: Safe, no action required.**

### Lovable Exposure Analysis

The customer-portal repo originated as a Lovable project and remains connected to it. Artifacts found:

**1. External CDN script in `index.html:70`**
```html
<script src="https://cdn.gpteng.co/gptengineer.js" type="module"></script>
```
Loaded on every page, runs with full browser context. If Lovable's infrastructure is compromised this is a vector for client-side code execution. **Highest priority to remove.**

**2. `lovable-tagger` npm package (`package.json:112`, `vite.config.ts:4,38`)**
Sends component metadata to Lovable during dev builds. Not evidence of npm compromise, but is telemetry going to a breached vendor. Remove as hygiene.

**3. Fallback URL in `src/config.ts:9`** pointing to `https://preview--agentweb-customer-portal.lovable.app` — cosmetic, but should be cleaned up.

**Key clarification:** The Lovable breach is a **platform data leak** (their API exposed stored project data), not a CDN/supply chain attack. The primary risk to us is: if any real credentials (API keys, env vars, secrets) were ever entered into the Lovable project editor, those may have been exfiltrated.

### Status & Next Steps

- **Vercel:** Confirmed safe per official Vercel email. No action required.
- **Lovable:** Awaiting Lovable's official email notification to determine whether our specific project was accessed during the breach. Once received, assess whether any credentials need rotation.
- **Code cleanup (planned):** Remove CDN script, lovable-tagger, and Lovable URL fallback from customer-portal regardless of breach outcome — these are unnecessary Lovable dependencies.

## Meta Account Connection Failure — karthy@goaldenhour.com (2026-04-20)

### Context

karthy@goaldenhour.com (userId: `4027bc5c-0f89-4236-b63e-b0186c634a1c`) reported that connecting their Meta ad account failed.

### Root Cause

Production logs at `Apr 19 00:55:35` showed:

```
[Meta Finalize] getAdAccounts failed — code=n/a classification=n/a
message=Meta API Error: (#200) Requires business_management permission to manage the object
```

The OAuth flow (`flow=marketing`) exchanges the code and gets a valid access token, but the subsequent `/me/adaccounts` API call requires the `business_management` permission. Our current `marketingScopes` in `backend/src/config/integrations.ts` only requests `ads_management`, `ads_read`, and `pages_show_list`. The error is silently caught (`metaAuth.ts:248`) and returns 0 ad accounts, leaving the user unable to connect.

### Why `business_management` Was Not Added

Adding `business_management` to `marketingScopes` would fix the API error, but Meta only allows this permission under **Advanced Access** for customer-facing apps. Standard Access (which we currently have, status Active with 561 users) restricts the permission to users who have a developer/admin/tester role on the Facebook App — it does not work for general customers. Obtaining Advanced Access requires a Meta App Review with a detailed use-case submission and is slow/difficult to get. Decision made after discussion with Harshit@Argusoft.

### Short-Term Fix (Implemented)

The Goaldenhour ad account is now under our (AgentWeb's) control. **We granted karthy@goaldenhour.com full access to the ad account directly through Facebook Business Manager.** This means their user token already has access to the account without needing `business_management` — they can connect successfully today.

### Long-Term Fix

Pursue **transfer of ownership** of the Goaldenhour ad account to Goaldenhour itself via Facebook Business Manager. Once Goaldenhour owns the account, karthy (as an admin of that business) will be able to grant `ads_management` and `ads_read` access through normal OAuth without needing `business_management`. No code changes required for this path either.

## Google OAuth App Review — Gmail Connected Accounts (2026-04-24)

### Status

**App review submitted / in progress.** Review typically takes 4–6 weeks for restricted scopes.

### Google Cloud Project

- **Project Name:** AgentWeb
- **Project ID:** `gen-lang-client-0725723168`
- **Project Number:** `606140610214`
- **OAuth Client ID:** `606140610214-tqm4fkgp6o7m4e5aq4n13n09ijqfhaij.apps.googleusercontent.com`
- **Credentials stored in:** AWS Secrets Manager at `prod/AgentWeb/Google/Gmail`

### Scopes Under Review

| Scope | Classification | Purpose |
|---|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | **Restricted** | Read user's Gmail inbox for AI-assisted email management |
| `https://www.googleapis.com/auth/gmail.send` | **Restricted** | Send emails on the user's behalf in AI outreach workflows |
| `https://www.googleapis.com/auth/calendar.readonly` | **Sensitive** | Read calendar to avoid scheduling conflicts |

`userinfo.email` and `userinfo.profile` are non-sensitive and do not require review.

### How to Submit / Re-Submit

1. Go to [Google Cloud Console](https://console.cloud.google.com) → project **AgentWeb** (`gen-lang-client-0725723168`)
2. Navigate to **APIs & Services → OAuth consent screen**
3. Ensure app name, support email, homepage (`https://app.agentweb.pro`), privacy policy, and ToS URLs are filled in
4. Click **"Submit for Verification"**
5. Provide scope justifications:
   - **`gmail.readonly`**: Read inbox to surface relevant emails in the AgentWeb AI assistant for outreach management
   - **`gmail.send`**: Send emails on behalf of users as part of AI-assisted outreach workflows (user reviews before sending)
   - **`calendar.readonly`**: Read calendar to help schedule meetings and avoid conflicts
6. Record a **demo video** (required for restricted scopes): show the OAuth flow and how each scope is used in the UI
7. Submit. Review takes **4–6 weeks** for restricted scopes.

### Notes

- While pending review, only users listed under **Test users** on the consent screen can authorize the Gmail connection
- The privacy policy must explicitly state Gmail data is not shared or sold
- Redirect URI registered in the OAuth client: `https://api.agentweb.pro/api/oauth/gmail/callback`
- YouTube connected accounts reuse the same Google Cloud project and OAuth client (`prod/AgentWeb/Google/Gmail`)

## Emma Self-Improvement — Investigation (2026-04-25)

### Context

Investigated how to get Emma to self-improve over time, inspired by agent self-improvement patterns like Reflexion.

### What Already Exists

The memory system (`AW-AccountMemory`) already covers the core use case:

- Categories: `preference`, `history`, `insight`, `workflow`
- Emma tools: `save_memory` (save a fact mid-session), `delete_memory` (remove by ID)
- Full CRUD API at `/api/memory` for user management
- All active memories are injected into every new session's system prompt (up to 20, most recent)

Emma already self-improves incrementally **within** a session: she can detect corrections or "remember that…" instructions and save them immediately via `save_memory`. Users can manage their memories via the customer portal settings UI.

### Gap Considered: Post-Session Auto-Extraction

The one missing piece is a post-session job that sends the full conversation transcript to an LLM and asks it to extract net-new learnings, then writes them to `AW-AccountMemory` automatically.

### Why We're Not Building It Now

Post-session auto-extraction risks being **overly aggressive**: the LLM may extract low-quality, redundant, or incorrect facts from routine exchanges (e.g., "user asked about SEO" → saves "user is interested in SEO" every session). This would pollute the memory store with noise and degrade Emma's quality over time rather than improving it.

The existing in-session `save_memory` mechanism is more precise because it only fires when there is a clear signal (explicit user instruction or detected correction). Auto-extraction has no such signal — it runs on every session regardless of whether anything new was learned.

### Decision

No action. The current memory system is sufficient. Revisit post-session extraction if we add a quality-scoring or deduplication layer that can filter out noise before writing.

## Thunderbird Connected Account — Investigation (2026-04-27)

### Context

Investigated whether Thunderbird.net could be supported as a connected account (similar to Gmail, LinkedIn, etc.).

### What Thunderbird Actually Is

**Thunderbird is a local desktop email client, not a platform.** There is no "Thunderbird account" to OAuth into, no REST API, and no webhooks. It is analogous to Outlook the desktop app, not Outlook.com. The mail data lives on whatever IMAP/SMTP server the user configured (Gmail, Yahoo, a custom domain, etc.) — Thunderbird is just the local interface to it.

Mozilla launched **Thundermail** (tb.pro, 2024) as a paid cloud email hosting service, but it is a standard IMAP/SMTP provider with no published developer API or OAuth flow.

### Why Thunderbird as a Connected Account Is Not Practical

- No OAuth authorization server exists — there is nothing to redirect users to
- No REST API — no way for our backend to read or send email via Thunderbird
- No webhooks or event system accessible outside the local process
- The only programmatic access to Thunderbird is via a WebExtension Add-on running *inside* the local Thunderbird process — a fundamentally different architecture that requires users to install an extension and only works while Thunderbird is open on their machine

### What We Can Support Instead

The email accounts that Thunderbird users configure are standard providers that we can already support or could support through existing mechanisms:

- **Gmail accounts** — already fully supported as a connected account via Gmail OAuth
- **Outlook / Microsoft 365** — could be added via Microsoft OAuth (same pattern as Gmail)
- **Thundermail and other IMAP providers** — could be added as a generic IMAP/SMTP connected account using credential-based auth (not OAuth)

### Decision

Do not build a Thunderbird-specific connected account — it is not architecturally feasible without requiring users to install a local extension. Instead, direct Thunderbird users to connect the underlying email account they use in Thunderbird (e.g., Gmail via the existing Gmail connected account flow).
