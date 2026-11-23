## ENG-3170: a share-link visitor runs sensitive tools only on a link whose owner allowed it (2026-11-23)

A share-link visitor runs under the owner's userId. A set of tools was guarded only by a sentence in the tool description or a `confirm`
flag the model sets itself, so the visitor was the "user" who confirmed: delete leads / a lead list, send email or Slack, post to
LinkedIn / X / Instagram / YouTube, publish a blog or landing page, change Google / LinkedIn / Meta-audience ad spend, disconnect LinkedIn.
(`call_meta_marketing_api` writes are not in this set: they already halt into an approval deck a visitor cannot answer.)

**What changed.**
- `interactiveShareMetadata.allowSensitiveActions` (the owner's per-link choice). `utils/interactiveShare.interactiveShareAllowsSensitiveActions`
  is the one place that reads it. An explicit boolean wins. A link made before the setting existed with an `expiresAt` (made on purpose in
  the share dialog) reads as ON; one with no `expiresAt` (auto-made: plan launches, emailed or Slack-posted links) reads as OFF. Nothing
  readable reads as OFF.
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
rule's argument is not in the tool's schema, when a schema enum value is classified unexpectedly, and when a tool whose name looks outward
facing is neither sensitive nor written into its reviewed-not-sensitive list. A new tool has to be classified by whoever adds it.

**Not covered (owner decision pending, listed in the test with the reason):** in-account overwrites; creating or deploying a new landing page;
public lead-list access; coding_agent; ClickUp / Notion task creation; test_scheduled_chat; reads of saved passwords (`get_login_credentials`,
`get_test_account`) and of the owner's mailbox or Slack. Passwords are the serious one and are raised separately.

**Gotcha.** `executeTool`'s `validateAndRepairToolArgs` can hoist a nested wrapper or rename an alias, so the sensitive check is done on the raw
arguments AND again on the prepared ones (the ENG-803 publish-approval check reads prepared arguments for the same reason).
