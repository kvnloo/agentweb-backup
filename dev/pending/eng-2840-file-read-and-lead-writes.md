## ENG-2840: File read, lead event and status note for outside agents over MCP (2026-11-26)

- `read_file_content` (`mcp/server/fileReadTool.ts`): the text of ONE file in the caller's own AgentWeb storage (chat attachments, files
  saved with `save_file`, Emma's outputs), through `POST /api/emma/read-file`. Emma's reader also fetches any public web URL from AgentWeb's
  servers with no size limit; over MCP that would be an open fetch proxy, so the tool always sends `own_storage_only: true` (any URL that
  `extractS3KeyFromUrl` does not claim is refused before anything else is answered or fetched) and `max_bytes` 10 MB (`readFileContent`
  refuses a larger stored file from its stored size before reading, and stops the stream past the limit, aborting the S3 request so its
  connection is freed). Both are new optional route fields (`max_bytes` only together with `own_storage_only`: it limits stored files only);
  without them the route and Emma's tool behave as before. "Own" is `readFileContent`'s rule: `users/<caller>/` or `sandbox/<caller>/`
  of the bucket; task results and knowledge-base files are not readable here. One read per caller at a time, 4 per process. The answer is
  built from fixed fields (content, truncated, file_type, file_size, content_length, content_hash; never the URL echo, the route message or a
  raw error), so it is exempt from the public sanitizer like the memory tools (`OWN_CONTENT_TOOL_NAMES`): a JSON file comes back as stored.
  Read-only (a `tools:read` key may call it; it is in the inventory gate's proven-read-only list, the name contains "file"). Emma's image and
  video refusals name her own describe tools, which outside agents lack, and are reworded; Emma's truncation message (which offers a
  byte range her tool does not take) is unchanged and not relayed: the tool writes its own note. Known limits, as in Emma: the 10 MB counts
  stored (compressed) bytes, so a crafted Office file can unpack much larger in the parser; the 4-reads-per-process pool is shared by all
  callers (one each).
- `add_lead_engagement` (`mcp/server/leadEngagementTool.ts`): one event on a lead, through a new thin route `POST /api/emma/add-lead-engagement`
  (metered) over Emma's own handler and list check (list owner, organization owner, listed CRM editors; not the CRM route, which alerts the
  list owner by email/Slack/WhatsApp). Checked in the tool: `custom.` + 1 to 53 of [a-z0-9_.-]; `event_data` at most 20 keys of simple values
  (text up to 500 characters, numbers, true/false, null), 2 KB, keys other code reads (`smartleadEventKey`, `from`, `to`, `subject`, `message`,
  `content`, `platform`, `reason`, `source`, `linkedin`, `campaignId`, `accountId`, `invitationId`) and the server's own (`channel`,
  `idempotencyKey`, `eventId`, `eventType`, `createdAt`) refused, as are the public-schema privacy names (transcripts, locations, IP); `event_date`
  ISO with a zone, at most 5 minutes ahead and a year back; `idempotency_key` without the words clicked, replied or received (it is stored in
  the event's data, which the engaged rule scans); 120 events an hour per caller (in-process). In Emma's handler, only for this route
  (`AgentEngagementLimits`): the event is stamped `channel: 'mcp'` (a caller's own `channel`/`idempotencyKey` data is dropped), a lead takes at
  most 50 such events and none when its stored record is 300 KB or more (`utils/agentEngagementLimits.ts`; the item limit is 400 KB and a full
  lead breaks every other writer on it), an `idempotency_key` already on the lead records nothing (`recorded: false, duplicate: true`), and the
  append is conditional on the lead's `updatedAt` (re-read and re-decided up to 3 times). A lead without `updatedAt` is appended without the
  condition, so two simultaneous calls with the same key could both record there. A 5xx or no answer says the event may or may not have been
  recorded and how to check. Events containing "clicked", "replied" or "received" mark the lead engaged (Emma's rule). No CRM sync, no alert,
  no conversion relay; the portal's live CRM view is not refreshed.
- `manage_leads update` takes `status_note` (with `updates.status` only, refused on every other action; 1 to 500 characters, checked
  before trimming): sent as `statusNote` to
  the lead update route, which takes it out of the body before anything else reads it, stores it as `notes` in the `status.changed` event only
  when the status really changes, and answers `statusNoteRecorded` (absent when no note was sent). It never touches the lead's own `notes`.
  Same shape as Emma's `update_lead_status` note. The route still writes that event before the lead update (unchanged), so a failed update can
  leave the event and its note.
- Not exposed, and why: see brain `eng-2840-w27-scope-and-findings-2026-11-25.md` (`search_user_assets`, `materialize_knowledge_base_asset`,
  `attach_knowledge_base_files`, the follow-up and conversation-status reads, `update_email_draft_for_lead`, `ask_crm`, `analyze_crm_data`).
- Proof: unit tests of both tools (`mcp/server/__tests__/fileReadTool.test.ts`, `leadEngagementTool.test.ts`), the reader's limits
  (`readFileContent.ownStorageLimits.test.ts`), both routes (`emmaApi.readFileAndEngagement.test.ts`), the handler's limits
  (`leads.addLeadEngagement.agentLimits.test.ts`), the status note on the route and in the MCP update (`crm.statusNote.test.ts`,
  `mcp.manageLeads.statusNote.test.ts`), and two tenants end to end through the real MCP server, routes and handlers on the in-memory
  database (`mcp.leadEngagement.twoTenant.test.ts`): another tenant's list is refused and its lead unchanged, the stamp, the duplicate key, the
  per-lead cap, and the status note stored in the event and not on the lead.
