## ENG-2724: Stripe metadata resolver review fixes (2026-11-14)

Block the administrator-only Sandbox tier at the existing metadata resolver boundary. Remove raw account-controlled plan values from both unmappable-tier and lookup-failure logs; retain price/subscription identifiers for diagnosis. No persistence contract changes.

Three regressions failed before the fix; 29/29 targeted Stripe tests pass after syncing current main. Backend production build passes. Full typecheck passes with the configured 6GB heap (the default 2GB invocation exhausted its heap).

Execution actor: Yugo (gpt-6.1-sol). Accountable owner: Harsha Vankayalapati. Existing PR #3822 remains subject to exact-head CI/Opslane and remaining review findings; this is not merge approval.
