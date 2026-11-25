## ENG-2964: permanent sent-message ledger foundation, dark draft (2026-11-24)

- Adds an explicitly constructed (not activated) DynamoDB ledger with org partition, permanent
  recipient/campaign/step conditional claims and atomic sent-history finalization.
- Unknown provider outcomes never auto-retry; permanent claims have no TTL or lease expiry.
- Standalone review-only CloudFormation template adds an on-demand orgId/sk table with PITR,
  SSE, deletion protection and Retain. Not applied or linked to deployment; no production tables created.
- docs/eng-2964-sent-message-ledger.md records schema, safety invariants, rollout and remaining
  integrations/cooldown/reconciliation work. Existing send paths are unchanged.
