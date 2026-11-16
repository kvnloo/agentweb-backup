## ENG-2783: hot lead calls add-on, review fixes (2026-11-16)

Four review findings on the billing add-on (#4048), each checked against the code before the change.

- A mirror write that fails after the customer paid no longer reports success. `addHotLeadCallBilling` throws a plain "payment went through, calling is still off, try again" message, so the settings are not written; the retry finds the paid item in Stripe and writes the mirror without a second charge.
- A duplicate add-on item left by a failed cleanup is retried on the next add (the already-present path now removes duplicates too). A cleanup failure is logged, never thrown, because the add-on is paid.
- The webhook mirror never decides from an event payload when Stripe cannot be read: the mirror is left unchanged. Cost: a cancellation event whose live read fails is not applied until the next event or the next enable. The webhook writer still never throws (a throw would make Stripe replay the whole subscription handler); that part of the finding was not taken.
- The approval card wording follows the billing model (`addon`) and not whether a purchase is needed (`purchase`): an organization that already has the add-on is told it covers the calls, not asked to approve per-minute billing.
