## ENG-55: Compare models as a plan-gated add-on (2026-10-08)

Compare models can now be sold as a plan add-on, enforced on the server. It is OFF until an
AW-Settings switch is flipped, so deploying this changes nothing.

**Pieces**
- Subscription feature id `model_compare` ("Compare models") registered in
  `services/subscriptionService.ts`. The partner-portal Subscription Types editor builds its
  checklist from `GET /api/admin/subscription-features`, so it needs no code change.
- AW-Settings `model_compare_requires_entitlement`. Only the string `true` (case/space
  insensitive) enforces; absent or anything else = not required (today's behaviour).
- `services/agentMode/modelCompareEntitlement.ts`: one function used by `/compare`,
  `/compare/select` (via the existing deps seam, a new optional `isEntitled` dep checked right
  after the `model_compare_enabled` kill switch, before any session read, usage check, lock,
  model call or write) and by `GET /api/auth/me` (`modelCompareEntitled`, additive, not stored).
- Entitled = requester is admin, OR `isSubscriptionFeatureEnabled(user, 'model_compare') === true`
  (the effective, org-owner-aware resolver). Unreadable tier or a thrown lookup = denied.
- Denial: HTTP 403 `{ error: 'Compare models is not available on your current plan.', code: 'model_compare_not_entitled' }`.
- The switch is cached ~60s; a failed read keeps the last-known value; with no known value
  (cold start) it is treated as not required. A settings outage never flips behaviour.
- Delegated sessions: `req.user` is the target customer, so the customer's plan applies.

**ROLLOUT STEPS (owner)**
1. Deploy backend then portal (either order is safe). After deploy nothing changes: the switch
   is absent, nobody is gated, and the portal shows the button when the hint is missing or true.
2. In the admin Subscription Types editor, tick "Compare models" on every tier that should have
   it and save. NOTE: a saved tier with an explicit feature list that lacks `model_compare`
   loses Compare as soon as the switch flips. Legacy rows that never saved a feature list keep
   it (no list = all features), but the editor shows them with every box ticked and saving
   writes that list explicitly, so review each tier before saving.
3. Set AW-Settings `model_compare_requires_entitlement` = `true`. Takes effect within ~60s per
   instance (cache TTL).
4. Rollback: set the setting to anything other than `true` (or delete it); within ~60s everyone
   is entitled again. Unticking the feature on a tier only matters while the switch is on.
   `model_compare_enabled=false` remains the separate global kill switch (503).

**Dialog hardening (portal)**: default suggested models are derived from the supported list at
runtime (non-legacy, best quality score, one per provider) instead of hard-coded ids that had
become legacy; the dialog shows a usage-multiplier note and a one-line privacy note.

**Needs owner review**: the three user-facing strings (cost note, privacy note, 403 message).
