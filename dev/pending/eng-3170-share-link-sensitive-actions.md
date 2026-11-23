## ENG-3170: a share-link visitor runs sensitive tools only on a link whose owner allowed it (2026-11-23)

A share-link visitor runs under the owner's userId. A set of tools was guarded only by a sentence in the tool description or a `confirm`
flag the model sets itself, so the visitor was the "user" who confirmed: delete leads / a lead list, send email or Slack, post to
LinkedIn / X / Instagram / YouTube, publish a blog or landing page, change Google / LinkedIn / Meta-audience ad spend, disconnect LinkedIn.
(`call_meta_marketing_api` writes are not in this set: they already halt into an approval deck a visitor cannot answer.)

**What changed.**
- `interactiveShareMetadata.allowSensitiveActions` (the owner's per-link choice). `utils/interactiveShare.interactiveShareAllowsSensitiveActions`
  is the one place that reads it. An explicit boolean wins. A link made before the setting existed (no choice stored) reads as ON only
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
(not reachable by a visitor today as far as read; not changed here).

**Not covered (owner decision pending, listed in the test with the reason):** in-account overwrites; creating or deploying a new landing page;
public lead-list access; coding_agent; ClickUp / Notion task creation; test_scheduled_chat; reads of saved passwords (`get_login_credentials`,
`get_test_account`) and of the owner's mailbox or Slack. Passwords are the serious one and are raised separately.

**Gotcha.** `executeTool`'s `validateAndRepairToolArgs` can hoist a nested wrapper or rename an alias, so the sensitive check is done on the raw
arguments AND again on the prepared ones (the ENG-803 publish-approval check reads prepared arguments for the same reason).
