## ENG-1656: manage_scheduled_chat field-named preflight validation (2026-10-13)

- `manage_scheduled_chat` now validates before any API call: create's three required fields, `schedule_id` for update/toggle/delete (previously hit `/scheduled-chats/undefined` and returned a misleading "not found"), toggle `status`, non-empty `email_notifications`, ISO `next_run_time`. Errors name the field.
- `timezone` added to the tool schema and forwarded on create/update (the route already accepted it).
- Agent Mode error guidance covers the preflight message plus nextRunTime/timezone/status rejections.
- Tests: `mcp.manageScheduledChatPreflight.test.ts` (mocked; no live schedules).
