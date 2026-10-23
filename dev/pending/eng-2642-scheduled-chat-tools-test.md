## ENG-2642: Fix stale list_scheduled_chats assertion (2026-10-23)

- `mcp.scheduledChatTools.test.ts` expected the pre-ENG-1611 unbounded GET; it now asserts the bounded page (`queryParams: { limit: "50" }`). Test-only.
