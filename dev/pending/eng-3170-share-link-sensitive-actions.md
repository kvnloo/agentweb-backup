## ENG-3170: a share-link visitor runs sensitive tools only on a link whose owner turned on Full control (2026-11-23)

A share-link visitor runs under the owner's userId. A set of tools was guarded only by a sentence in the tool description or a `confirm`
flag the model sets itself, so the visitor was the "user" who confirmed: delete leads / a lead list, send email or Slack, post to
LinkedIn / X / Instagram / YouTube, publish a blog or landing page, change Google / LinkedIn / Meta-audience ad spend, disconnect LinkedIn.
(`call_meta_marketing_api` writes are not in this set: they already halt into an approval deck; a visitor can answer it only on a link whose owner turned on Full control, the share route answers 403 otherwise.)

**Full control (owner decision, 2026-11-23).** Customers see the switch as "Full control": "everything that the customer can do, like it used to be
before any of our changes/restrictions". When ON for a link, a visitor on it also gets what ENG-2816 took away (owner settings, hot-lead calls,
Smartlead, Luma, memory, `connect_account`) and the saved-login tools (`get_login_credentials`, `get_test_account`), on top of the sensitive set.
ADMIN tools are never lifted (a link holder must not get staff powers). A visitor-made schedule keeps the whole block list (no link to ask).
The visitor refusal for the ENG-2816 block list keeps its wording byte for byte (a share-session eval depends on it). The early, model-facing
refusal in `toolDispatch` asks the link through the optional port `shareLinkFullControl`; `executeTool` decides again from a consistent read.
Added with it, on the owner's yes: `enable_lead_list_public_access`, `set_landing_page_lead_list`, `deploy_landing_page`, `test_scheduled_chat`,
and `set_lead_contact_status` (only `active`, which re-enables contact with a lead who opted out, is sensitive).

**Also under Full control (owner, 2026-11-23: "the full capability of the end user themselves").** A link with it ON may answer an approval card that
carries a write or a locked decision: the share route used to refuse those with 403 for every visitor (ENG-1635/1644) and still does unless a
consistent read of the link says Full control is ON (unreadable, missing or off keeps the 403). Still different from the customer, on purpose or
pending the owner's call: admin tools (never lifted), schedules a visitor creates (marked, wait for the owner to adopt them), schedule-template
writes (refused for a visitor), and a visitor cannot stop the owner's running turn. The dialog shows the Off explanation only when the switch is off
and the On text (every power listed) only when it is on.

**Review round 2 (two independent reviews of the final code, 2026-11-23).** Fixed in this PR:
- A link made before the setting existed keeps exactly what it had (the sensitive tools) and gains nothing that was refused to every visitor until now: the owner-only block list, `connect_account` and answering approval cards need an EXPLICIT stored `true` (`interactiveShareControl(...).full`). The dialog still shows such a link as ON; turning the switch off and on once makes it full control.
- A link that is no longer live (stopped, expired) reads OFF for the rest of a turn already running. A stored choice that is not a boolean reads OFF (it no longer falls to the lifetime rule).
- `stage_pending_decision` was first made sensitive for `audience` other than `team` (it emails the named address from AgentWeb with the caller's own text and link); the final review made it sensitive whatever the audience, see the last section.
- The owner's saved browser sessions are saved logins: `load_/save_/clear_browser_cookies` and `mark_browser_session_failed` are sensitive tools, and a browser tool run for a visitor no longer loads the owner's cookies (or writes the visitor's back over them) unless the link allows the sensitive tools.
- Third review round (two more independent reviews, of the fixes): both found that tools which drive the browser for the model (`open_site_signin`, `solve_captcha`, `coding_agent`) call `executeTool` WITHOUT the visitor claim, so the browser branch's "is this a visitor" test never saw one. A first fix asked the in-process visitor-turn marker (`isShareVisitorTurn`), but chat turns run in a FORKED WORKER, where that marker is never set (both reviewers of that fix found it; the unit tests could not, as they run in one process). The real fix is call-scoped: `executeTool` runs a call that carries a restriction inside a Node `AsyncLocalStorage` scope, and a nested call with no restriction of its own inherits it (so it also gets the block list and the sensitive rule, not only the cookie rule). It works in any process and for voice. The marker stays as a second signal in the main process. `read_verification_code` (a one-time login code or magic link read from the owner's mailbox: with a browser, a log-in as the owner) is a sensitive tool. A link whose owner turned on Full control keeps the expiry the owner chose when an alert or email reuses it (it used to be stripped, turning "full control for 7 days" into "for ever"); an old link and an OFF link are still made permanent by a mailed reuse. An empty `expiresAt` reads as "never expires" in the liveness check, as in the route. The stop (DELETE) route refuses a visitor claim like POST and PATCH. Portal: create and stop handlers are guarded against the owner switching chats mid-request.
- The share route gives the same "a write failed: read the error, do not re-propose it" instruction the owner's route gives, from one shared helper.
- The owner-only settings routes refuse a request carrying a visitor's restriction claim. The explicit choice is written to an existing link unconditionally (the copy it read may be stale). The guard test's name pattern now includes the neutral verbs (clear, load, save, update, configure, manage, mark, stage); every tool it caught is classified with a reason.
A legacy link's schedule behaviour differs from main in one more place: a schedule a visitor creates on any link now loses the sensitive tools too (on main only the block list was refused until the owner adopts it).
Known limits left on purpose (disclosed to the owner): the dialog shows a link made before the setting existed as ON although only the sensitive tools work on it (the block list, connect_account and approval cards need an explicit choice: turn the switch off and on once); the `email` actions get and search, and Slack and X message reads, still read the owner's mailbox and messages on an OFF link (raised separately); a browser the owner already used in the SAME chat keeps its logins; visitor-made schedules (marked) still run browser tools with the owner's cookies; per-user MCP tools register in the same registry and are not on the list; `set_lead_contact_status` to do-not-contact stays allowed on an OFF link (it only restricts outreach, the owner can undo it); `post_on_connected_account` is refused whole, so `save_as_draft` is refused on an OFF link; in-account overwrites (brand guidelines, market strategy, knowledge base, statuses, test accounts) are not refused (owner decision pending); a link has one token per session, so ON also covers anyone a system email or Slack message sends the same link to (such a send no longer strips the expiry of an explicit-ON link; an explicit-ON link past its expiry is replaced by a new OFF link the next time a system message needs a link, instead of the dead address being sent again; old and OFF links are still made permanent by such a send, the outage fix); an owner's own unattended run of a sensitive tool (now also `read_verification_code`, the login-recovery step of a scheduled report) is refused if the session or schedule reads fail twice; a visitor-written schedule (marked) still loads the owner's cookies for browser tools, because its browser calls carry no restriction and checking would cost a provenance read on every browser call; a browser the owner (or an earlier ON-link turn) already logged in keeps those logins for the rest of that chat's browser session.

**A separate fix that rides in this PR, as its own commit (owner: "if it's a tiny fix, do it").** `set_lead_contact_status` used `crmDb.updateLead`,
an upsert, so an id that was already deleted (or mistyped) came back as an empty stub lead. It now reads the lead first (consistent read) and reports a
missing one as failed, writing nothing.

**What changed.**
- `interactiveShareMetadata.allowSensitiveActions` (the owner's per-link choice). `utils/interactiveShare.interactiveShareAllowsSensitiveActions`
  reads it for the sensitive tools; `interactiveShareControl` returns both answers (`sensitive`, and `full` = an explicit stored `true`, on a live link) and is
  what `executeTool`, the dispatcher and the share route use. An explicit boolean wins. A link made before the setting existed (no choice stored) reads as ON only
  when its lifetime (`expiresAt` minus `sharedAt`, rounded to days) is one the share dialog offers (1, 3, 7, 14, 30, 90, 365): it was made on
  purpose by the owner. Every other link reads OFF: no expiry (plan launches, emailed or Slack-posted links, very old links), the 45-day links
  the admin Chat History tab mints on every conversation staff list (`routes/admin.ts` `ensureIshareLinkForReview`; 890 of the 921 live timed
  links on 2026-11-23, only 31 were dialog-made), and any lifetime nobody can account for. Nothing readable reads as OFF.
- `chatbotDb.createOrReuseInteractiveShare(sessionId, days, { allowSensitiveActions })` stores an explicit choice on every NEW link (off unless
  the share dialog says on). An explicit choice is also applied to a link that already exists (one token per session); a caller with no
  choice (email, Slack, alerts) never touches it. The work-plan launch path writes `allowSensitiveActions: false` itself.
- `GET` / `PATCH /api/agent-mode/session/:sessionId/conversable-share` read and change it (owner only).
- `services/toolRestrictionProfiles.ts`: `SHARE_VISITOR_SENSITIVE_TOOLS` (whole tools) and `SHARE_VISITOR_SENSITIVE_BY_ARGUMENT` (tools judged by one
  argument; unknown or missing values are sensitive). `isSensitiveToolCall(tool, args)` is pure.
- `agentModeService.executeTool` is the sink every path ends in (typed chat, voice, nested): a call under the `share_visitor` profile to a
  sensitive tool reads the session (consistent read, one retry) and refuses unless the link allows it; unreadable or missing = refuse. The
  check runs again on the arguments after repair. The owner is never affected.
- A schedule a visitor set up (`share_visitor_schedule`) has no link to ask, so it is refused these until the owner adopts it. Its required
  calls are dropped by tool NAME only (`restrictionRefusal(..., { nameOnly: true })`), so a Google Ads report schedule is still held to calling
  `call_google_ads_api`.

**Pinned.** `__tests__/shareVisitorSensitiveTools.test.ts` loads the real tool registry and fails when a name in the list no longer exists, when a
rule's argument is not in the tool's schema, when a schema enum value is classified unexpectedly, and when a tool whose NAME looks outward
facing (send, post, publish, delete, remove, launch, revoke, deploy, email, notify, share, ...) is neither sensitive nor written into its
reviewed-not-sensitive list. A tool with a neutral name is not forced into review by this test, so classify a new write tool on purpose.

**Writes to the link are attribute level.** `setInteractiveShareAllowSensitiveActions` and `removeInteractiveShareExpiry` update one attribute each.
`updateSessionInteractiveShareMetadata` writes back a whole copy, so an email or alert that reuses a link (and strips its expiry) could otherwise
write an older copy over the owner's change a moment after they made it.

**Judged after repair.** A tool judged by an argument is judged on the arguments it will run with (`validateAndRepairToolArgs` turns a GET-shaped
HubSpot call into LIST, an Attio FIND into SEARCH), so a read in a shape the model often uses is not refused for looking like a write. A tool that
is sensitive whatever its arguments is settled before repair.

**Known limits.** One token per session: turning the switch on also covers anyone who gets that link in a mailed or posted report (the dialog says
"applies to everyone who has this link"). A link made in the share dialog before the setting existed reads ON until a mailed or posted reuse removes
the expiry, then OFF. The admin review links (45 days) read OFF; new ones are minted with an explicit OFF. An owner's own unattended run of a
sensitive tool now reads its session once (is it a visitor-made schedule?), and refuses when that read keeps failing, as ENG-2816 already does for
the block-listed tools. `generateConversableResponse`, `scheduleAutoWorkPlanContinuation` and `approvalInboxExecution` start turns with no profile
(not reachable by a visitor directly as far as read; not changed here). They are reachable INDIRECTLY through a decision a visitor stages: see "Final review" below, which closes that.

**Not covered (listed in the test with the reason):** creating a new landing page (`generate_landing_page`, `duplicate_landing_page`);
`coding_agent`; ClickUp / Notion task creation; lead field edits (`update_lead`, `update_lead_status`); reads of the owner's mailbox, Slack and X messages.
(In-account overwrites of brand guidelines, market strategy, the knowledge base, status stages, list settings and a saved test login ARE covered since the
final review below.)

**Gotcha.** `executeTool`'s `validateAndRepairToolArgs` can hoist a nested wrapper or rename an alias, so a tool judged by an argument is judged on the
PREPARED arguments (a tool judged by name is settled before repair; the ENG-803 publish-approval check reads prepared arguments for the same reason).

## Final review (2026-11-24, on the rebased head; one full-context and one blind reviewer, read-only)
Two reviewers found these; each was verified in the code by reading it, and all are fixed in this PR with tests:
- **Resuming a schedule.** `manage_scheduled_chat` with action `toggle` was allowed on an OFF link, and the toggle route (`toggleScheduledChatStatus`) neither
  checks nor writes a visitor mark, so a visitor could resume one of the owner's PAUSED schedules, which then ran, unrestricted, as the owner (it can email or
  post). Now a toggle is allowed only with `status: 'paused'` (a new `alsoRequire` on the by-argument rule); resuming, an unknown, a missing or a non-text status
  is sensitive. Judged after argument repair like the other rules.
- **The old agent-engine task tools** (`create_task_from_prompt`, `create_task_from_template`, `create_revision`) create a task under the owner's account with
  `useSharedBrowser: false`; the agent engine then fetches the owner's own saved logins and loads the owner's cookies. Their names carry no outward verb, so the
  guard test never forced a decision. Now sensitive.
- **`stage_pending_decision` is sensitive whatever the audience.** When a team approver settles a decision, `approvalInboxExecution.resumeOriginSession`
  resumes the ORIGIN session as a full owner turn (no restriction), with the visitor's messages still in view. (The earlier note that this was "not reachable
  by a visitor" was wrong.)
- **The create-link reply tells the truth about the expiry.** `createConversableShare` answered with the REQUESTED expiry although `createOrReuseInteractiveShare`
  reuses an existing live link. A link first made by an email or alert path never expires, so an owner who chose "7 days + Full control" from a dialog that had
  not seen it was shown "Expires ..." on a permanent link that now had full control. The reply now carries the STORED `expiresAt`, and none when the link has none
  (the dialog only shows an expiry when there is one). The PATCH route still turns the switch on for a link that never expires: the dialog then shows no expiry.
- **What the approved wording promises.** The OFF text says Emma "won't ... change your settings or Emma's memory". Seven tools overwrite what the owner set up
  inside the account and were left allowed "pending the owner's decision": `update_brand_guidelines`, `update_market_strategy`, `manage_market_strategy` (its
  `update` action; `read` stays allowed), `update_knowledge_base_file`, `configure_lead_statuses`, `update_lead_list`, `save_test_account`. They are sensitive now,
  so the wording is true for them (reads such as `read_market_strategy` and `read_brand_guidelines` are unchanged; lead field edits stay allowed). To allow them
  again on OFF links, move those names back to the reviewed-not-sensitive list in `shareVisitorSensitiveTools.test.ts` and out of `SHARE_VISITOR_SENSITIVE_TOOLS`.

Known limits added by this review (not fixed here, disclosed):
- **A running turn is not tied to the link it started on.** `readShareLinkControl` and the approval-card gate read the session's CURRENT link. If the owner stops
  link A and, while a visitor's turn on A is still running, creates link B with Full control, that turn's next tool call sees B's setting. Closing it means
  carrying the admitted link's token in the tool context (through the forked chat worker and voice) and requiring a match; it needs an owner to stop one link and
  start a Full-control one inside one turn.
- A link made in the share dialog before the setting existed, whose expiry a later email or alert removed, now reads OFF (the release note says dialog links keep
  working "as they did").
- The system's own result emails of a schedule a visitor created go to the recipients on that schedule (reported by the blind reviewer, not verified here; the
  schedule-recipient guard is ENG-1904's, not this change's).
- The setting is written to the link that is current when the write happens (a background job minting a new link in between could be switched on); conditioning the
  write on the token that was read would close it.

