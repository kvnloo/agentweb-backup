# <Integration Name> Contract

Last derived from code: YYYY-MM-DD

Owner area: `<team/person if known>`

Primary risk: `<one sentence>`

## Agent Summary

Write the short version first. A future coding agent should understand the main
danger in under one minute.

## What AgentWeb Uses This For

| Capability | Supported? | Entry point | Notes |
| --- | --- | --- | --- |
| OAuth/connect | Yes/No | `<path>` |  |
| List accounts/entities | Yes/No | `<path>` |  |
| Create/update/delete | Yes/No | `<path>` |  |
| Reporting/insights | Yes/No | `<path>` |  |
| Webhooks | Yes/No | `<path>` |  |

## Code Pointers

| Area | Path | Purpose |
| --- | --- | --- |
| Config | `<path>` |  |
| Auth route | `<path>` |  |
| Service | `<path>` |  |
| Agent tool schema | `<path>` |  |
| Tests | `<path>` |  |

## Stored Internal Shape

Document the shape stored in `connected_accounts`, user fields, or other DB
records. Include IDs, token fields, token expiry fields, scopes, and any legacy
fields still in use.

```ts
// Example only
{
  platform: "vendor",
  account_id: "...",
  account_name: "...",
  config: {
    account_type: "...",
    access_token: "...",
    token_expires_at: 0
  }
}
```

## External Payload Contract

Document the payloads AgentWeb sends to the vendor. Include:

- Required fields.
- Optional fields.
- Enum values accepted by AgentWeb.
- Mutually exclusive fields.
- Unit conversions.
- IDs that must include or omit prefixes.
- Nested object shapes that must not be flattened.

## Agent Tool Contract

List the tool names, supported actions, required IDs, and the exact workflow
agents should follow.

## Known Failure Modes

| Failure | Symptom | Guard/test | What not to do |
| --- | --- | --- | --- |
|  |  |  |  |

## Tests To Check

List focused tests first. Then list broader route/service tests.

## Recent PR/Commit Evidence

List PRs or commits that encode important assumptions. This is where bug-fix
scar tissue becomes reusable memory.

## Open Gaps

List assumptions that are not fully proven yet. Do not hide uncertainty.

## Update Checklist

- [ ] Vendor docs checked if external API shape changed.
- [ ] Code pointer list still accurate.
- [ ] Tests cover new or changed contract behavior.
- [ ] Failure modes updated if this change fixes a bug.
- [ ] Agent tool descriptions updated if users/agents call this integration.

