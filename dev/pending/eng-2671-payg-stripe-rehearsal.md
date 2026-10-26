## ENG-2671: Stripe test-mode rehearsal script for Extra usage settlement (2026-10-26)

`backend/src/scripts/paygStripeRehearsal.ts` runs the real settlement code, the real webhook controller and every PAYG handler against Stripe TEST mode and the Dev-* tables, using Stripe test clocks for the "hour after finalize", retry-schedule and 7-day-unconfirmed timing. Webhook events are pulled from Stripe (`events.list`) and replayed, signed with a local secret, into `handleWebhook`, so no public endpoint is needed. Our own emails are captured, never sent; the settlement switch is forced on in-process only.

Run (needs a Stripe `sk_test_` key in `STRIPE_SECRET_KEY`, or read access to `dev/AgentWeb/Stripe`):

    cd backend
    NODE_ENV=development STRIPE_SECRET_KEY=sk_test_... npx ts-node --transpile-only src/scripts/paygStripeRehearsal.ts --out /tmp/payg-rehearsal.json

Guards: refuses unless NODE_ENV=development, key is `sk_test_`/`rk_test_`, Stripe reports livemode false, and STRIPE_API_BASE is unset.

Cases: happy path with receipt, re-delivery, idempotent re-run and refund; credit-paid invoice; decline sequence with `next_payment_attempt`; hosted-invoice payment; 3-D Secure action required and unconfirmed past grace; void; uncollectible then paid; dispute won and lost; concurrent settlement runs and a month record removed by hand.

Not testable here (Dashboard only, per Stripe docs): retry policy (Revenue recovery > Retries), failed-payment emails, 3DS confirmation emails, successful-payment receipts. In test mode Stripe emails only the confirmed address of a team member (set `REHEARSAL_STRIPE_EMAIL`); test and live Dashboard settings are separate.
