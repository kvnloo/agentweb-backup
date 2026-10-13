## ENG-2303: Zoma Meta Toolkit — OAuth discovery, onboarding, guarded writes (2026-10-12)

- `/api/meta-toolkit/mcp` now answers unauthenticated `initialize` with 401 + RFC 9728
  `resource_metadata` pointing at `/.well-known/oauth-protected-resource/api/meta-toolkit/mcp`.
  MCP clients reject protected-resource metadata whose `resource` differs from the URL they
  connected to, which is why the old `/mcp`-only document never started OAuth.
- A setup-mode Stripe Checkout completion used to be handled as a subscription purchase
  (`handleCheckoutSessionCompleted` defaults `subscription_status: 'active'`). It is now
  acknowledged with no side effects; `zoma_status` uses setup mode for "add a payment method".
- The ENG-400 objective gate needs an Emma transcript or approval deck; the toolkit has
  neither, and a sessionless call used to auto-provision a chat session. The toolkit preview
  (`previewToolkitMetaWrite`) swaps in an explicit-objective gate and never creates sessions.
- Guarded-write replay protection is per-process (no durable claim store — that would be new
  persistence). Worst case cross-instance within 15 min: a duplicate PAUSED create.
- `evaluateMetaSpendCeiling` had no caller; the toolkit write path now calls it with an
  optional env policy (`META_TOOLKIT_SPEND_CEILING`). Per-account ceilings need a policy store.
