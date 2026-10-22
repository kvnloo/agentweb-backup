## ENG-752: Emma admin tool to inspect/update user funnelStatus (2026-10-20)

- New admin-only `manage_user_funnel_status` tool (read/preview/apply, max 50 rows) over the same `userDb.updateUser({ funnelStatus })` write as `PUT /api/admin/users/:userId/funnel-status`.
- Values limited to `USER_FUNNEL_STATUS_VALUES` or null; apply is idempotent and emits `[admin-audit]` with actor, accountable owner, before/after, timestamp.
- Fails closed for non-admins, customer delegated access, and external MCP.
