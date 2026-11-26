## ENG-2840: Content tools for outside agents over MCP, and five security fixes (2026-11-26)

- Six of Emma's content tools on the MCP server (`mcp/server/contentTools.ts`), chosen by 30-day Emma usage among tools with no MCP twin:
  `list_html_templates` (read), `create_html_file`, `create_html_from_template`, `update_html_file`, `describe_image` (read),
  `perform_data_analysis`. Same pattern as the other wave-2 tools (arguments by name and value, the portal's own `/api/emma/*` route as
  the key's own user, refusals as errors with the route's short message only, fixed text for a 5xx or a timeout, answers built from fixed
  fields). Bounds Emma does not have: one call at a time per caller, a few per process and a number an hour per caller for each tool
  (`GUARDS`), self-call timeouts as long as the work (`TIMEOUTS_MS`: up to 16 minutes for create_html_file, 21 for analysis); the model is
  never the caller's choice and no session is attached; `update_html_file`, `describe_image` and `perform_data_analysis` take only files
  of the caller's own AgentWeb storage (an https URL of the bucket), because Emma's versions fetch any public URL (an open fetch proxy over
  MCP). Not exposed: Slack reads (one AgentWeb bot token for every tenant, privacy question open), `convert_to_pdf` (renders any URL in a
  browser), `create_html_template` (overwrites by name, fetches URLs; later). Known: files these tools create sit in the caller's folder of
  a bucket that serves an object to anyone holding its URL (the descriptions say so); `update_html_file`'s `_v2` name is deterministic, so
  editing the same original twice writes the same name (said in the description, unchanged in Emma).
- Fix: custom domains. `addCustomDomain` refuses AgentWeb's own domains and their subdomains (`RESERVED_PLATFORM_DOMAINS`: agentweb.pro,
  agentwebforms.com, hireemma.ai) before any Vercel call (400 from `POST /api/domains/custom`), and the reconcile cron skips them. Every
  customer project is in AgentWeb's own Vercel team, so Vercel reported such a host verified with no proof from the customer, and the
  API's CORS list trusts those domains. Managed subdomains (`addSubdomain`) and page subdomains are unaffected. Re-attaching one of these
  domains is done by hand in Vercel.
- Fix: Slack. Emma's `slack_get_thread_replies` had no user check (any session could read any thread in any channel the bot is in); it is
  now scoped like `slack_get_recent_messages`. A non-admin naming a channel that does not exist and one that is not theirs now gets the
  same answer (the name lookup covers every bot channel: it was a list of which clients' channels exist). `GET /api/slack/channels` gave a
  user with no personal channel every bot channel (other clients' names); it now lists, for anyone but a real (non-delegated) admin, only
  the channels `POST /send-approval` would accept for them (own, else the organization's, none on WhatsApp).
- Fix: knowledge-base links. MCP answers no longer carry Google Cloud Storage signed links (minted to expire in 2500, stored in task
  records, unrevocable): `withoutSignedStorageLinks` (`mcp/server/knowledgeBaseParams.ts`) removes them from `list_knowledge_bases`,
  `emma_get_brand_profile`, `list_tasks` and `manage_task`. Files are read with `read_knowledge_base_files` (by id and name).
- Fix: `describe_image` read any object of our bucket with the server's credentials (presigned) for any caller. It now asks the same
  owner rule as the file routes and storage tools (`checkOurBucketKeyRead`) first, for every model and before any read (harmless today only
  because the bucket still serves objects by URL). `POST /api/emma/describe-media` without a model now uses the vision model, as Emma
  does (it defaulted to `gpt-4o`, not a registered model, which also skipped the image download).
- Proof: `mcp/server/__tests__/contentTools.test.ts` (requests, refusals, answers, errors, guards), tests of the domain refusal and cron
  skip, the Slack scoping and channel list, the signed-link stripping through the four tools, and the describe_image owner check; the
  inventory, classification, route-budget and plan-route limit gates.
