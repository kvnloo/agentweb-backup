## ENG-1005: Publish, plan, and schedule workflow tools (2026-10-06)

- Add four externally listed MCP workflows: `emma_publish_social_post`, `emma_publish_blog_post`, `emma_create_gtm_plan`, and `emma_schedule_recurring_work`.
- Publishing defaults to local draft previews; only boolean `publish: true` permits publication. Social calls without an account return connected accounts. Granular publish tools remain internal-only (already enforced in this checkout).
- Blog creation/publication had no matching REST adapters; add authenticated, quota-metered adapters around the existing service methods, carrying scheduled consent through to the CMS write. Successful publishers lacking a URL are reported explicitly without suggesting a duplicate publish.
- GTM orchestration uses the actual route contracts (title, whole-plan responses, one work item per request). Schedules need no template; missing prompt variables are named before creation.
- Complexity: four thin workflows, two required REST adapters, no dependencies or persistence changes. Rollback: remove the new workflow imports/list entries and adapters.
- TDD: initial ENG-1005 run was 32 failed / 3 passed before implementation. Verification is scoped Jest only; no servers, browsers, full-repo typecheck, commit, or push.
- Final verification: 311 tests in 13 suites passed (including 47 ENG-1005 tests), plus 3 static quota-classification tests. CodeRabbit's completion-credit finding was reproduced and fixed; its remaining title-normalization suggestion does not apply because the phase route stores titles verbatim.
