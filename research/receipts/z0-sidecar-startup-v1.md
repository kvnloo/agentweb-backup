# Sidecar startup wiring — #95 / roadmap #100

## Scope and provenance

Stacked on `lab/z0-backpressure-circuit-v1` at
`a45cbc3f184c680d72378143bb8e31a75ee5d2c9`; no reviewed branch or `main` changed.
Preserves Kevin Rajan (`kvnloo`)'s sidecar profile/handshake design and original
Jest tests from `lab/z0-sidecar-deployment-v1` at
`a1bc653d9315a50af07b45ee691a04af9ad6fbbd`. AgentWeb retains its existing
execution, authentication, approval, funding and publish authority.

The existing handshake was not called by `z0Adapter.ts`. The shared admission
seam now checks it for route, Choice and Noul before any execution request.
`Z0INT_AGENTWEB_DEPLOYMENT=sidecar` is explicit; `Z0INT_AGENTWEB_MODE` remains
`off` by default. Setting deployment mode alone does not start requests.

Client startup is lazy, on the first valid integration call, not process
supervision or an eager backend boot hook. Concurrent callers share one pending
handshake; successful startup is cached without per-turn health probes.
All four handshake requests and later execution requests refuse redirects.
The normalized loopback origin is used for the POST too. Unsupported
capabilities and failed startup return a local pre-execution rejection.
A `draining: true` readiness payload is rejected even when HTTP/`ok` say success.

A startup rejection concerns this attempt only: it never reconciles a previous
ambiguous execution. Once a POST is admitted, existing unknown/same-identity
semantics remain authoritative. No retry loop, canary activation, process
spawning, upstream promotion or merge is introduced.

## Reproduction

From a backend checkout with its declared dependencies installed:

```sh
node --test scripts/test-z0-sidecar-startup.cjs
npx tsc --noEmit --target es2018 --module commonjs --strict --skipLibCheck \
  --types node src/emma/z0Adapter.ts src/emma/z0SidecarDeployment.ts
```

The fixture runner uses the existing `ts-node` dependency and Node's native
test runner, HTTP server and fetch. It contacts synthetic loopback peers only;
there are no provider calls, credentials, customer data or model charges.
The remote-address denial checks inject a counting fetch and make no network
request. The original Jest fixture suite is retained unchanged, not replaced.

## Executed evidence — 2026-10-06

The five relevant TypeScript modules were materialized from the pinned sources
and their Git blob hashes verified before editing. This was a focused source
checkout, not a full repository checkout/install.

- Same final regression suite before the fix: **6 passed, 17 failed**.
- After the fix: **23 passed, 0 failed, 0 skipped/cancelled**.
- Focused strict ES2018/CommonJS typecheck before: one TS18046 error in the
  original sidecar validator's `loopback_hosts` narrowing.
- After: **exit 0**. The validator now retains the narrowed local array.
- Local tools: Node 22.16.0, TypeScript 5.8.3, ts-node 10.9.2,
  transitive Node type definitions 25.1.0. The backend lockfile toolchain still
  needs its separate build gate.

Checks cover all three call paths, default-off, invalid origins, startup
coalescing, no POST before readiness, failed health, draining, mismatched
limits/protocol, unsupported active dispatch, explicit recovery, legacy mode,
origin normalization, redirect refusal, active ambiguity, and proven-overload
circuit behavior. Changed-source and test blob identities are in the adjacent
JSON receipt.

## Remaining acceptance gates

**Not run:** full backend build/Jest suite, real z0 Python service cross-repo
E2E, Tern dogfood, live Emma validation. Do not interpret local HTTP fixture
success as real z0 or production acceptance. Keep #95 open and the PR draft
until a matching pinned z0 head serves the real deployment profile/readiness
contract and the affected backend gates pass. #101 remains disabled/blocked on
that evidence; this change does not satisfy the full canary contract.
