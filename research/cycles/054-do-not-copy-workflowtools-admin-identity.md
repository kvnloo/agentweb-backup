# Cycle 54 — do not copy workflowTools's admin identity into A-007

**UTC:** 2026-09-11T20:31:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

A-007's first slice says "copy `workflowTools.ts`" (ENG-982). Cycle 53 said
keep `ctx()` on `generate_image`. Does the template file itself mix the
ENG-1596 `overrideToken` skip into that copy?

## Finding

**Yes. `workflowTools.ts` is mixed-identity. Copy the mcpFetch + name-list
pattern, not the admin import.**

### 1. The template imports admin scoping

`workflowTools.ts` L37: `import { resolveClientScopedContext } from './adminClientScope'`.
L248 `emma_get_account_status` uses it (`client_id` in schema L238–242).
The other four workflow tools use `ctx(context)` (L103, L112, L142, L217,
L274, L321). Header L26–28 still claims every call is the same mcpFetch +
quota gate. One of five is not.

Hermes: a tool file that needs admin identity imports it **in that file**.
`registry.py` does not. OMP `pi-ai` does not import `pi-agent-core`.

### 2. The five infrastructure tools A-007 would move are all `ctx()`

| Tool | Citation |
|---|---|
| `you_search_web` | `apiTools.ts` L2015 |
| `you_search_news` | L2044 |
| `google_search_web` | L2068 |
| `generate_image` | L2098 |
| `send_email` | L2141 |

None call `resolveClientScopedContext`. `infrastructure.ts` must **not**
import `adminClientScope.ts`. Wholesale copy of `workflowTools.ts` would
drag that import into the Q-014 file for no reason.

### 3. OMP still puts images in the leaf package, not HTTP

Live `earendil-works/pi` `@earendil-works/pi-ai` **0.85.1** (same as cycle
30). `package.json` `dependencies`: `@earendil-works/pi-telemetry` only —
still **no** `pi-agent-core`. `sideEffects` include `./dist/images.js` and
`./providers/images/register-builtins.js`. Images are an **in-process
submodule of the leaf package**. That is A-008 (`services/creative/`),
not A-006 (fifth HTTP process).

## Queue effect

A-007 first_slice tightened: copy ENG-982 **shape** (mcpFetch, exported
name list, barrel from `apiTools.ts`), do **not** copy L37
`adminClientScope`. No rank change. Q-001 / Q-014 / Q-003 stay ready.

## Next

Cycle 55: cheapest remaining mapping or collision. Do not un-ready
Q-001 / Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
