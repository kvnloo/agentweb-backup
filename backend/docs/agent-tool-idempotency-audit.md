# Agent Mode tool side-effect idempotency audit (ENG-2798 / ENG-771 lever 4)

Design doc only. No runtime change. Snapshot of `origin/main` on 2026-11-04.

## Scope and method

- Universe: every tool name declared under `backend/src/emma/` (the Agent Mode registry, `emmaToolRegistry`) that `isReadOnlyToolName` (`backend/src/utils/toolWriteClassification.ts`) does NOT classify as read-only. That classifier is fail-safe (anything not proven read counts as a write), so a few tools whose names merely don't lead with a read verb (`google_calendar_list_events`, `slack_get_*`, `fathom_get_*`, ...) appear here and are marked READ.
- The public MCP surface (`backend/src/mcp/server/*.ts`, classified separately in `toolAnnotationPolicy.ts`) proxies into the same services and is listed in the appendix only; it is not an Agent Mode scheduled-run tool.
- Classification is per tool family from the implementation file and the tool's own contract text. Where a row says "not wired", no idempotency key exists in code today (grep for `idempoten|Idempotency-Key|clientRequestId` across `backend/src/emma` finds none on these paths).

## Classes

- KEY-OWN: write lands only in our own DynamoDB/S3. Closeable by key: either already replay-safe (set/delete/dedupe) or closeable by persisting a `toolCallId`-keyed record before the write.
- KEY-PROVIDER: downstream provider exposes a client-supplied idempotency/identity key; closeable once wired.
- RACE: provider has no idempotency API for this call (send, post, publish, purchase, paid generation). The duplicate window can only be narrowed (write-ahead intent record + post-hoc reconcile), never closed.
- READ: no side effect in practice.

## Inventory (139 Agent Mode tools)

| Tool | Downstream system | Class | Safe to re-execute on resume | Source |
|---|---|---|---|---|
| `add_characters` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `add_gtm_common_items` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `add_gtm_phase` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `add_gtm_work_items` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `add_lead_engagement` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `add_leads_to_list` | Own DynamoDB leads (dedupe on email/linkedin/name+company) | KEY-OWN (already replay-safe per tool contract) | yes | `backend/src/emma/tools.ts` |
| `assign_lead` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `attach_knowledge_base_files` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `call_attio_api` | Raw provider passthrough (Google Ads / LinkedIn Ads / HubSpot / Attio) | RACE (method-dependent; Google Ads offline conversions dedupe on order_id) | no | `backend/src/emma/tools.ts` |
| `call_google_ads_api` | Raw provider passthrough (Google Ads / LinkedIn Ads / HubSpot / Attio) | RACE (method-dependent; Google Ads offline conversions dedupe on order_id) | no | `backend/src/emma/tools.ts` |
| `call_google_ads_reporting_api` | Provider reporting (read in practice) | READ | yes | `backend/src/emma/tools.ts` |
| `call_hubspot_api` | Raw provider passthrough (Google Ads / LinkedIn Ads / HubSpot / Attio) | RACE (method-dependent; Google Ads offline conversions dedupe on order_id) | no | `backend/src/emma/tools.ts` |
| `call_linkedin_ads_insights_api` | Provider reporting (read in practice) | READ | yes | `backend/src/emma/tools.ts` |
| `call_linkedin_marketing_api` | Raw provider passthrough (Google Ads / LinkedIn Ads / HubSpot / Attio) | RACE (method-dependent; Google Ads offline conversions dedupe on order_id) | no | `backend/src/emma/tools.ts` |
| `check_local_agent_status` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/localAgentTools.ts` |
| `check_temp_inbox` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/tempEmailTools.ts` |
| `clear_browser_cookies` | Own DB / S3 delete | KEY-OWN (delete is idempotent) | yes | `backend/src/emma/browserCookieTools.ts` |
| `coding_agent` | External agent/browser/research runtime | RACE | no | `backend/src/emma/tools.ts` |
| `compose_video` | Paid media/LLM generation + own S3 | RACE (cost; replay duplicates asset and spend) | no | `backend/src/emma/tools.ts` |
| `configure_lead_statuses` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `confirm_hot_lead_call_verification` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/hotLeadCallSetupTools.ts` |
| `connect_account` | Unipile / OAuth account binding | KEY-OWN (state converges; revoke is idempotent) | no | `backend/src/emma/connectAccountTool.ts` |
| `convert_to_pdf` | Paid media/LLM generation + own S3 | RACE (cost; replay duplicates asset and spend) | no | `backend/src/emma/tools.ts` |
| `create_blog_article` | Blog CMS / own S3+DB | RACE | no | `backend/src/emma/tools.ts` |
| `create_book` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_book_outline` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_character` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_clickup_task` | ClickUp API | RACE | no | `backend/src/emma/tools.ts` |
| `create_google_doc` | Google Drive/Docs/Sheets | RACE | no | `backend/src/emma/tools.ts` |
| `create_google_sheet` | Google Drive/Docs/Sheets | RACE | no | `backend/src/emma/tools.ts` |
| `create_gtm_plan` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_html_from_template` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_image_task_from_prompt` | Paid media/LLM generation + own S3 | RACE (cost; replay duplicates asset and spend) | no | `backend/src/emma/tools.ts` |
| `create_knowledge_base` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_lead_list` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_revision` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_skill` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_social_media_posts` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_task_from_prompt` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_task_from_template` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `create_work_plan` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `delete_character` | Own DB / S3 delete | KEY-OWN (delete is idempotent) | yes | `backend/src/emma/tools.ts` |
| `delete_gtm_items` | Own DB / S3 delete | KEY-OWN (delete is idempotent) | yes | `backend/src/emma/tools.ts` |
| `delete_lead_list` | Own DB / S3 delete | KEY-OWN (delete is idempotent) | yes | `backend/src/emma/tools.ts` |
| `delete_leads` | Own DB / S3 delete | KEY-OWN (delete is idempotent) | yes | `backend/src/emma/tools.ts` |
| `delete_leads_by_filter` | Own DB / S3 delete | KEY-OWN (delete is idempotent) | yes | `backend/src/emma/tools.ts` |
| `delete_memory` | Own DB / S3 delete | KEY-OWN (delete is idempotent) | yes | `backend/src/emma/tools.ts` |
| `delete_org_memory` | Own DB / S3 delete | KEY-OWN (delete is idempotent) | yes | `backend/src/emma/tools.ts` |
| `enqueue_human_eval` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `enrich_lead_custom` | Paid enrichment providers + own lead DB | RACE (credit spend); own-DB write closeable | no | `backend/src/emma/tools.ts` |
| `enrich_leads_execute` | Paid enrichment providers + own lead DB | RACE (credit spend); own-DB write closeable | no | `backend/src/emma/tools.ts` |
| `enrich_leads_preview` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/tools.ts` |
| `fathom_get_meetings` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/fathomTools.ts` |
| `fathom_get_onboarding_context` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/fathomTools.ts` |
| `fathom_get_transcript` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/fathomTools.ts` |
| `fathom_route_action_items` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/meetingActionRouter.ts` |
| `find_or_lookup_email` | Paid enrichment providers + own lead DB | RACE (credit spend); own-DB write closeable | no | `backend/src/emma/emailLookupTool.ts` |
| `generate_book_content` | Paid media/LLM generation + own S3 | RACE (cost; replay duplicates asset and spend) | no | `backend/src/emma/tools.ts` |
| `generate_image` | Paid media/LLM generation + own S3 | RACE (cost; replay duplicates asset and spend) | no | `backend/src/emma/tools.ts` |
| `generate_video` | Paid media/LLM generation + own S3 | RACE (cost; replay duplicates asset and spend) | no | `backend/src/emma/tools.ts` |
| `generate_voiceover` | Paid media/LLM generation + own S3 | RACE (cost; replay duplicates asset and spend) | no | `backend/src/emma/tools.ts` |
| `google_calendar_create_event` | Google Calendar | KEY-PROVIDER (client event id supported by Calendar API; not wired) | delete/update only | `backend/src/emma/calendarTools.ts` |
| `google_calendar_delete_event` | Google Calendar | KEY-PROVIDER (client event id supported by Calendar API; not wired) | delete/update only | `backend/src/emma/calendarTools.ts` |
| `google_calendar_get_event` | Google Calendar (read; name not verb-first) | READ | yes | `backend/src/emma/calendarTools.ts` |
| `google_calendar_list_calendars` | Google Calendar (read; name not verb-first) | READ | yes | `backend/src/emma/calendarTools.ts` |
| `google_calendar_list_events` | Google Calendar (read; name not verb-first) | READ | yes | `backend/src/emma/calendarTools.ts` |
| `google_calendar_update_event` | Google Calendar | KEY-PROVIDER (client event id supported by Calendar API; not wired) | delete/update only | `backend/src/emma/calendarTools.ts` |
| `google_drive` | Google Drive/Docs/Sheets | RACE | no | `backend/src/emma/tools.ts` |
| `import_leads_from_search` | Own DynamoDB leads (dedupe on email/linkedin/name+company) | KEY-OWN (already replay-safe per tool contract) | yes | `backend/src/emma/tools.ts` |
| `install_skills` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `launch_predefined_work_plan` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `linkedin_manage_post` | LinkedIn/X via Unipile / social APIs | RACE | no | `backend/src/emma/tools.ts` |
| `linkedin_outreach` | LinkedIn/X via Unipile / social APIs | RACE | no | `backend/src/emma/tools.ts` |
| `load_browser_cookies` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/browserCookieTools.ts` |
| `log_contact_event` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `luma_get_guests` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/lumaTools.ts` |
| `luma_list_events` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/lumaTools.ts` |
| `manage_linear_governance_label` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `manage_user_funnel_status` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `mark_browser_session_failed` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/browserCookieTools.ts` |
| `modify_work_plan` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `mux_video_with_audio` | Paid media/LLM generation + own S3 | RACE (cost; replay duplicates asset and spend) | no | `backend/src/emma/tools.ts` |
| `navigate_to` | External agent/browser/research runtime | RACE | no | `backend/src/emma/navigateTools.ts` |
| `open_site_signin` | External agent/browser/research runtime | RACE | no | `backend/src/emma/siteSigninTools.ts` |
| `perform_deep_research` | External agent/browser/research runtime | RACE | no | `backend/src/emma/tools.ts` |
| `post_on_connected_account` | LinkedIn/X via Unipile / social APIs | RACE | no | `backend/src/emma/tools.ts` |
| `present_question_deck` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `preview_smartlead_push` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/smartleadPushTools.ts` |
| `promote_to_deal` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `provision_hot_lead_call_number` | Telephony provider (number purchase/call) | RACE (money) | no | `backend/src/emma/hotLeadCallSetupTools.ts` |
| `publish_blog_article` | Blog CMS / own S3+DB | RACE | no | `backend/src/emma/tools.ts` |
| `recommend_predefined_work_plan` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `regenerate_market_strategy` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `release_hot_lead_call_number` | Telephony provider (number purchase/call) | RACE (money) | no | `backend/src/emma/hotLeadCallSetupTools.ts` |
| `release_leads_from_smartlead` | Smartlead API | RACE | no | `backend/src/emma/smartleadPushTools.ts` |
| `repair_blog_article` | Blog CMS / own S3+DB | RACE | no | `backend/src/emma/tools.ts` |
| `report_product_issues` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `request_user_captcha_solution` | External agent/browser/research runtime | RACE | no | `backend/src/emma/solveRecaptchaTool.ts` |
| `revoke_linkedin_account` | Unipile / OAuth account binding | KEY-OWN (state converges; revoke is idempotent) | no | `backend/src/emma/linkedInAccountRevokeTools.ts` |
| `rotate_primary` | Unipile / OAuth account binding | KEY-OWN (state converges; revoke is idempotent) | no | `backend/src/emma/tools.ts` |
| `run_local_agent_task` | External agent/browser/research runtime | RACE | no | `backend/src/emma/localAgentTools.ts` |
| `save_browser_cookies` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/browserCookieTools.ts` |
| `save_memory` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `save_org_memory` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `save_test_account` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/testAccountTools.ts` |
| `save_work_plan` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `send_email_from_sender` | Email provider (SES/Gmail/connected sender) | RACE | no | `backend/src/emma/tools.ts` |
| `send_email_to_lead` | Email provider (SES/Gmail/connected sender) | RACE | no | `backend/src/emma/tools.ts` |
| `send_for_review` | Email provider (SES/Gmail/connected sender) | RACE | no | `backend/src/emma/tools.ts` |
| `send_gtm_status_report` | Email provider (SES/Gmail/connected sender) | RACE | no | `backend/src/emma/tools.ts` |
| `set_lead_contact_status` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `set_work_plan_status` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `slack_get_recent_messages` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/slackMessageTools.ts` |
| `slack_get_thread_replies` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/slackMessageTools.ts` |
| `slack_list_channels` | Provider read (name not verb-first) | READ | yes | `backend/src/emma/slackMessageTools.ts` |
| `slack_send_message` | Slack API | RACE | no | `backend/src/emma/slackMessageTools.ts` |
| `solve_captcha` | External agent/browser/research runtime | RACE | no | `backend/src/emma/solveRecaptchaTool.ts` |
| `stage_pending_decision` | Own DynamoDB (insert / enqueue) | KEY-OWN (needs toolCallId-keyed insert; not wired) | no | `backend/src/emma/tools.ts` |
| `start_hot_lead_call_verification` | Telephony provider (number purchase/call) | RACE (money) | no | `backend/src/emma/hotLeadCallSetupTools.ts` |
| `start_smartlead_push` | Smartlead API | RACE | no | `backend/src/emma/smartleadPushTools.ts` |
| `twitter_manage_post` | LinkedIn/X via Unipile / social APIs | RACE | no | `backend/src/emma/tools.ts` |
| `twitter_outreach` | LinkedIn/X via Unipile / social APIs | RACE | no | `backend/src/emma/tools.ts` |
| `update_book_content` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_brand_guidelines` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_email_draft_for_lead` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_google_doc` | Google Docs/Sheets | RACE | no | `backend/src/emma/tools.ts` |
| `update_google_sheet` | Google Docs/Sheets | RACE | no | `backend/src/emma/tools.ts` |
| `update_gtm_phase` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_gtm_plan` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_gtm_work_item` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_hot_lead_call_settings` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/hotLeadCallTools.ts` |
| `update_html_file` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_knowledge_base_file` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_lead` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_lead_list` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_lead_notification_settings` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/leadNotificationTools.ts` |
| `update_lead_status` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `update_market_strategy` | Own DynamoDB/S3 (set-style write) | KEY-OWN (last-write-wins set; replay converges) | yes* | `backend/src/emma/tools.ts` |
| `write_clickup_doc` | ClickUp API | RACE | no | `backend/src/emma/tools.ts` |

`yes*` = converges on replay only if the args are absolute values; a set built from a value read earlier in the run can overwrite a concurrent human edit. Acceptable for resume because the original call already wrote the same value.

## Resume safety under `planScheduledRunResume` (AC3)

`backend/src/services/agentMode/core/resumePlan.ts` returns `dangling_tool_call` (not resumable) whenever an assistant `tool_use` has no persisted result. That is correct for every RACE and insert-style KEY-OWN tool above.

A dangling call could be made resumable (re-execute the call, then continue) ONLY when every dangling call in the trailing assistant turn is in the set marked `yes` / `yes*`:

`add_leads_to_list`, `assign_lead`, `attach_knowledge_base_files`, `call_google_ads_reporting_api`, `call_linkedin_ads_insights_api`, `check_local_agent_status`, `check_temp_inbox`, `clear_browser_cookies`, `configure_lead_statuses`, `confirm_hot_lead_call_verification`, `delete_character`, `delete_gtm_items`, `delete_lead_list`, `delete_leads`, `delete_leads_by_filter`, `delete_memory`, `delete_org_memory`, `enrich_leads_preview`, `fathom_get_meetings`, `fathom_get_onboarding_context`, `fathom_get_transcript`, `google_calendar_get_event`, `google_calendar_list_calendars`, `google_calendar_list_events`, `import_leads_from_search`, `load_browser_cookies`, `luma_get_guests`, `luma_list_events`, `manage_linear_governance_label`, `manage_user_funnel_status`, `mark_browser_session_failed`, `modify_work_plan`, `preview_smartlead_push`, `promote_to_deal`, `regenerate_market_strategy`, `save_browser_cookies`, `save_memory`, `save_org_memory`, `save_test_account`, `save_work_plan`, `set_lead_contact_status`, `set_work_plan_status`, `slack_get_recent_messages`, `slack_get_thread_replies`, `slack_list_channels`, `update_book_content`, `update_brand_guidelines`, `update_email_draft_for_lead`, `update_gtm_phase`, `update_gtm_plan`, `update_gtm_work_item`, `update_hot_lead_call_settings`, `update_html_file`, `update_knowledge_base_file`, `update_lead`, `update_lead_list`, `update_lead_notification_settings`, `update_lead_status`, `update_market_strategy`

Everything else must keep falling back to restart-from-scratch (or, better, be fixed by a write-ahead intent record). Highest-value follow-ups, by blast radius of a duplicate:

1. Email/social/Slack sends (`send_email*`, `slack_send_message`, `linkedin_outreach`, `twitter_outreach`, `post_on_connected_account`): RACE. Write a `toolCallId` intent row before sending and refuse a second send for the same id; a crash between provider ack and result-persist still leaves an unknown-outcome window that needs human or provider-log reconcile.
2. Money paths (`provision_hot_lead_call_number`, `enrich_leads_execute`, paid generation): RACE on spend; never auto-resume.
3. Own-DB inserts (`create_*`, `add_*` other than leads, `enqueue_human_eval`, `log_contact_event`): closeable by a `toolCallId`-keyed conditional put; cheapest to convert to resume-safe.
4. `google_calendar_create_event`: Calendar API accepts a client event id; deriving it from `toolCallId` closes the duplicate.

Any allowlist change in `resumePlan.ts` is a separate, tested change; this doc does not alter behavior.

## Appendix: public MCP write tools (64), not Agent Mode

`assess_client_health`, `check_account_tracking_health`, `configure_landing_page_subdomain`, `create_schedule_from_template`, `delete_landing_page`, `deploy_landing_page`, `diagnose_leads_at_zero`, `duplicate_landing_page`, `edit_landing_page_file`, `emma_answer_question_deck`, `emma_answer_work_plan_input`, `emma_create_gtm_plan`, `emma_create_landing_page`, `emma_create_session`, `emma_edit_landing_page`, `emma_find_leads`, `emma_get_account_status`, `emma_get_brand_profile`, `emma_get_session`, `emma_launch_work_plan`, `emma_list_models`, `emma_list_sessions`, `emma_publish_blog_post`, `emma_publish_social_post`, `emma_research`, `emma_run_marketing_task`, `emma_schedule_recurring_work`, `emma_send_message`, `enable_lead_list_public_access`, `enable_session_tracking`, `evaluation_workspace`, `execute_task`, `freeze_user_account`, `generate_landing_page`, `google_search_web`, `iterate_landing_page`, `manage_brand`, `manage_crm_sequence`, `manage_gtm_items`, `manage_gtm_plan`, `manage_leads`, `manage_market_strategy`, `manage_predefined_work_plan`, `manage_schedule`, `manage_schedule_template`, `manage_scheduled_chat`, `manage_scoring_judges`, `manage_skill`, `manage_task`, `manage_user_notes`, `monitor_lead_volume`, `post_on_account`, `publish_landing_page_changes`, `resolve_landing_page_by_url`, `resolve_skill`, `revert_landing_page_publish`, `save_file`, `send_email`, `set_landing_page_lead_list`, `share_landing_page_with_org`, `submit_scheduled_chat_variables`, `test_scheduled_chat`, `update_landing_page_context`, `you_search_news` (all in `backend/src/mcp/server/`).
