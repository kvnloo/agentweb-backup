## ENG-2724: Retry failed surviving-subscription sync instead of canceling paid access (2026-11-14)

When Stripe confirms a surviving active/trialing subscription, errors during its tier lookup or sync now propagate for webhook retry instead of falling through to Free. Existing subscription-list failure behavior is unchanged. Three regressions reproduce the previous swallowed errors and now pass.

Opslane run 2009's concurrent update/deletion race is still unresolved; this change does not claim to fix it. An atomic status/subscription guard is needed for the delayed tier write, not a non-atomic re-read. Any persistence-semantics change remains subject to the data-plane pre-merge approval gate.
