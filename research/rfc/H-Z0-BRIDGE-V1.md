# RFC-H-Z0-BRIDGE-V1 — AgentWeb ↔ z0intelligence bridge protocol

**Status:** downstream lab  
**Tracking:** #75  
**Depends on:** #48, #50, #54  
**Upstream promotion:** not yet

## Problem

The current AgentWeb/z0 lab already demonstrates routing, bounded decisions, reliability observations,
context packing, replay, and a TypeSafe SDK E2E. Those paths currently encode their boundary semantics
inside endpoint-specific adapter code.

That makes important invariants implicit:

- which system owns user authorization;
- how one logical operation gets one stable authority identity;
- what a timeout means after active dispatch may have started;
- whether a response may be treated as applied;
- which policy assertions cross the boundary;
- how evidence/receipt identity is represented;
- which failures are safe for AgentWeb to fall back from.

This RFC extracts those invariants into a small protocol without changing production behavior.

## Ownership

### AgentWeb owns

- user/account authentication;
- connected-account authorization;
- confirmation and publish policy;
- evaluation-workspace restrictions;
- scheduled/unattended-run policy;
- funding attribution;
- the decision to enable the z0 bridge at all.

### z0intelligence owns

- routing/decision authority after admission;
- request fingerprinting and idempotency;
- specialist/provider eligibility;
- dispatch claims;
- durable decision receipts;
- reconciliation of ambiguous active executions.

Neither side may infer authority owned by the other from prompt text.

## v1 request

`agentweb.z0.bridge.v1` carries:

- `operation_id` — stable logical operation;
- `trace_id` — deterministic authority identity;
- `parent_agent` — pseudonymous AgentWeb scope;
- `mode` — shadow or active;
- `kind` — plan, decide, dispatch, or observe;
- `capability` — explicit requested capability;
- `policy` — bounded assertions;
- `payload` — endpoint/capability-specific bounded input.

### Policy assertions

- `allow_remote`
- `free_only`
- `experimental`
- `risk_class = read | generate | mutate | external_side_effect`
- `approval_state = not_required | required | confirmed`

These are constraints, not credentials.

## Credentials and identity

The envelope MUST NOT carry raw AgentWeb user/account/session IDs, API keys, OAuth tokens, cookies,
or authorization headers.

`parent_agent` is pseudonymous and matches the existing adapter shape:
`agentweb:<24 lowercase hex>`.

`trace_id` is a 64-character lowercase SHA-256 identity. Existing deterministic trace derivation in
`z0Adapter.ts` remains valid; v1 makes the requirement explicit.

## Side effects

For `mode=active`, `kind=dispatch`, and `risk_class=external_side_effect`, AgentWeb must have
already reached `approval_state=confirmed`.

The bridge does not replace confirmation. It only proves that the caller asserts confirmation occurred
at the AgentWeb-owned boundary.

## Failure semantics

### Shadow

Any transport/HTTP ambiguity is `not_executed`.

- no reconciliation;
- no applied result;
- AgentWeb may continue using its incumbent behavior.

### Active, known pre-execution rejection

Validation, policy rejection, trace conflict, and bounded 4xx failures are `rejected`.

- no fresh identity;
- no automatic z0 retry;
- the caller may decide whether its native path is still appropriate.

### Active, execution ambiguity

Timeout, transport loss, 5xx, or malformed success response are `unknown`.

- `reconcile_required=true`;
- retry semantics are `same_identity_only`;
- a new trace MUST NOT be minted.

This is the bridge-level form of the invariant already exercised by #48/#50.

## Response

A v1 response repeats operation + trace identity and reports:

- `status = completed | not_executed | rejected | failed | unknown`;
- `applied`;
- `replayed`;
- `reconcile_required`;
- retry semantics;
- optional evidence/receipt identity;
- bounded structured error/output.

Shadow responses can never be `applied`, `unknown`, or reconciliation-required.

## Mapping current experiments

| Existing seam | v1 interpretation |
|---|---|
| `/v1/plan` | shadow / plan |
| `/v1/intelligence` | active / dispatch |
| `/v1/experimental/choice` | shadow / decide |
| `/v1/experimental/noul` | shadow / decide |
| `/v1/observe/reliability` | shadow / observe |

`/v1/context/pack` remains endpoint-specific in this first slice. Do not enlarge v1 merely to make
every existing endpoint fit.

## Capability negotiation

Next slice: z0 should expose a read-only bridge capability description including:

- supported bridge versions;
- supported kinds/capabilities;
- max request bytes;
- concurrency/backpressure hints;
- active-dispatch availability;
- receipt schema versions.

No provider secrets or credentials may be exposed.

## Acceptance gate

Before active promotion:

1. AgentWeb and z0 validate the same deterministic fixture corpus.
2. Identical replay produces no duplicate physical execution.
3. Changed request under the same authority identity conflicts.
4. Shadow failure cannot change AgentWeb behavior.
5. Active ambiguity cannot create a second trace.
6. No raw AgentWeb identity or credentials cross the boundary.
7. Existing #49/#51 E2E behavior maps to v1 without weakening safety.
8. Exact cross-repo heads are frozen in CI.

## First implementation slice

This branch adds only:

- protocol types;
- runtime request/response validation;
- conservative failure disposition;
- deterministic unit fixtures.

It intentionally does **not** wire production traffic to the envelope yet.
