## ENG-2110: remove the backend-local Claude sign-in routes (2026-10-27)

- **What changed.** `/api/llm-connections/claude-subscription/*` (start, complete, cancel) is no longer mounted, and its router and test are deleted. Connecting a Claude plan goes only through `/api/llm-connections/subscriptions/claude/*`, where the sign-in runs on the login host.
- **Why.** The old routes ran the sign-in on the backend and sealed the customer's token (KMS) onto the connection record. The program rule is that AgentWeb never holds a customer token; the hosted routes keep it on the worker. The old routes were still reachable for any user on the allow-list, which defeated that rule.
- **Not touched.** `claudeSubscriptionService` stays: the expiry cron, boot-time orphan recovery and connection revoke still use it for records created earlier. No client calls the removed paths (the portal uses the hosted ones). Existing connections are unaffected.
