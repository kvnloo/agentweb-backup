## ENG-2840: Calendar reads, asset search, LinkedIn outreach account, lead email drafts and a safer knowledge-base file read over MCP (2026-11-27)

- Six more of Emma's tools on the MCP server for outside agents, on their own account and under Emma's names:
  - `google_calendar_list_events`, `google_calendar_get_event`, `google_calendar_list_calendars`:
    - Only the caller's own Google sign-in is used; there is no fallback to a shared account.
    - Dates must carry a zone, ranges are at most 92 days, and `calendar_id` and `event_id` are checked by charset.
    - Google's raw error text is never passed on.
  - `search_user_assets`: a pure read. The new `warm: false` option on `getExecutionsWithAssets` skips every session cache write, and
    `backfill: false` skips the report fetch and the classifier. Answers carry no session ids. The URLs open for anyone holding them.
  - `inspect_linkedin_account`: the caller's connected LinkedIn outreach accounts and their queued actions. A refusal does not echo the id.
  - `update_email_draft_for_lead`: writes and saves a draft and sends nothing.
    - Access is checked first: another account's list answers like a missing one.
    - It never runs with a session, and spends up to four model calls on the caller.
- `read_knowledge_base_files` reshaped:
  - New route `POST /api/emma/kb-file-read`; the old route is unchanged.
  - It refuses `gdoc:` and `gsheet:` ids, which fall back to a shared Google service account for any file id, until the shared-Google
    fix's step 2.
  - 1 to 5 files, text only, at most 100,000 characters per file and 200,000 per call.
  - Fixed per-file errors; answers are fixed fields only.
  - It is now exempt from the public-response sanitizer, like `read_file_content`.
  - Annotated `read`: no path stores a token or writes.
- Same pattern as the other wave-2 tools:
  - New metered `/api/emma/*` routes (`/google-calendar-read`, `/user-assets`, `/linkedin-outreach-account`, `/lead-email-draft`,
    `/kb-file-read`) that check the arguments again and run Emma's code as `req.user.userId` only.
  - A 4xx passes through; a 5xx gets a fixed text.
  - A `CallGuard` per tool.
- The MCP inventory goes from 150 to 156 tools.
- Fixes in Emma's own code:
  - `enrich_leads_preview` read the leads of any list id before its access check. "No leads to preview" versus the access refusal told a
    caller whether another account's list existed. Access is now checked first, and a list the caller cannot read answers like a missing one.
  - Portal `PUT /api/crm/lists/:listId/leads/bulk-contact-status`: `updateLead` is an upsert, so an unknown id created a stub lead. A
    missing lead now counts as failed. The ids are capped at 500 (the portal sends at most one page of 200).
  - `materialize_knowledge_base_asset` buffered the whole Drive file before measuring it, so bad size metadata (0 during a virus scan)
    meant a large file was held in memory. The download is now streamed and stops at the 200 MB ceiling.
  - A teammate's read of the shared workspace asset library no longer writes the other member's session caches (it already skipped the
    backfill, ENG-2874).
  - Emma's Google Calendar reads give up after 30 s; they had no limit.
- Not exposed:
  - `log_contact_event`: it writes a shared contact-events table with no tenant, a data-plane change for the owner.
  - `set_lead_contact_status` and `attach_knowledge_base_files`: already covered.
  - `enrich_leads_preview` (it spends provider credits), `materialize_knowledge_base_asset`, `convert_to_pdf`, `create_html_template`.
- Known, not changed (Emma, pre-existing):
  - Other accounts' "public" knowledge bases are readable, by design pending an owner decision.
  - Emma's own `search_user_assets` still backfills and classifies. Its fetch is guarded by the separate SSRF PR.
  - Emma's calendar tools pass Google's raw error text to her own chat.
- Proof:
  - New tests: 61 Calendar, 62 asset and outreach, 78 knowledge-base read, 35 lead draft, plus tests for each Emma fix.
  - A sweep of 146 suites (3,140 tests) in the MCP, emma-route, tasks, CRM, enrichment, Drive and Calendar areas: green.
  - `npm run typecheck`: exit 0.
