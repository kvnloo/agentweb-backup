# Coding Agent Reliability Acceptance Criteria

These are the human-level behavioral criteria for the coding-agent reliability layer. Implementation tests may evolve, but these criteria should not be weakened by the implementing agent without human approval.

1. A landing-page edit produces either a verified preview or a clear terminal failure state with `runId`, branch, preview URL if available, failing checks, and recovery status.
2. The system does not report a successful coding-agent edit unless deployment and typed verification pass.
3. A timed-out run remains terminal. Late model/tool work cannot overwrite it as passed or mutate the published terminal result.
4. A broken build or deploy gets bounded repair attempts and then a rollback to the captured base commit when rollback data is available.
5. Ordinary acceptance failures preserve the draft preview as recoverable state instead of rolling back useful work.
6. Verifier/tool unavailability, stale preview refresh, or schema drift returns `blocked`, not fake success or vague failure.
7. Public coding-agent acceptance checks are limited to `http_status`, `text_present`, `selector_exists`, `no_console_errors`, and `no_external_hosts`.
8. Coding-agent edit flows do not call v0.
9. v0 generation flows are idempotent and capped: one chat create per stable generation key and one correction message per chat.
10. Product behavior does not depend on hard-coded human-looking benchmark phrases, company names, or copy strings.
11. Staging smoke must run against a seeded disposable account/page before production deploy, use an opaque token, verify preview behavior, and assert zero v0 usage attempts for that run.
