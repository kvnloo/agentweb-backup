# A11 — Lifecycle filter semantics

## Finding A: presence is safe to virtualize now

Lifecycle is a total semantic stage. `is_empty` should match zero rows and
`is_not_empty` should match every row, regardless of whether DynamoDB stores the
attribute. This is the narrow result promoted upstream in #3153.

## Finding B: equality needs live joins

A lead row does **not** contain enough information to correctly derive
`signed_up`, `in_deal`, `trialing`, `paying`, or activity-driven churn/risk.
The existing backfill obtains those signals from AW-Users, AW-ContactEvents, and
AW-Deals.

The second experiment therefore tests a batched resolver that:
- deduplicates emails and deal IDs;
- loads users, events, and deals once per page/batch;
- reuses the existing backfill computation;
- produces lifecycle values for all leads without an N+1 query shape.

Promotion gate for equality filtering: production adapters must preserve bounded
batch/page cost and classifications must agree with the backfill/live scoring path.
Until then, stored equality filters remain compatibility behavior.
