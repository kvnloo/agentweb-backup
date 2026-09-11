# Cycle 88 — OMP 0.85.1 undid publishing a server/client split

**UTC:** 2026-09-11T21:48:00Z
**Kind:** comparison
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 54 pinned Oh My Pi `@earendil-works/pi-ai` **0.85.1** with
images in-process (`sideEffects` `images.js`) and `pi-ai` ↛
`pi-agent-core`. Has cutting-edge moved toward a tool HTTP mesh
since then — or did they double down on in-process packages?

## Finding

**Still 0.85.1 (released 2026-09-05). DAG unchanged. Images still
in `pi-ai`. 0.85.1 *undid* 0.85.0’s accidental publish of
experimental `client` / `server` subpaths. Cutting-edge agentic
SDLC this month rejected the split A-006 keeps proposing.**

### Live pin (`earendil-works/pi` v0.85.1)

| Package | Depends on `@earendil-works/*` | Must not |
|---|---|---|
| `pi-ai` 0.85.1 | `pi-telemetry` only | **agent-core** (confirmed: no such dep) |
| `pi-agent-core` 0.85.1 | **pi-ai**, chord, telemetry | coding-agent |
| `pi-coding-agent` 0.85.1 | agent-core, pi-ai, tui, chord | — |

`pi-ai` `sideEffects` still `./dist/images.js` and
`./dist/providers/images/register-builtins.js`. Script
`generate-image-models` is in-package codegen, not a process.

### They tried a server package and rolled it back

`pi-coding-agent` `package.json` v0.85.1:

- `exports["./client"]` and `./experimental/plugin` are
  `"source": "./src/..."` (not published `dist`).
- `files` excludes `!dist/client` and `!dist/experimental`.
- `@earendil-works/pi-server` and `pi-client` are
  **devDependencies** only.

Release notes (2026-09-05): 0.85.0 “unintentionally publishing
internal experimental code”; 0.85.1 makes experimental
`client` / `plugin` / server-client commands **source-only**;
“the supported local SDK and stdio RPC API are unchanged.”

That is the 2026 cutting-edge verdict on “extract a server”:
keep the SDK local; do not ship the experimental HTTP mesh.
AgentWeb already has MCP as the **external** bus (Q-014 lists
on it). A fifth `listen()` for `generate_image` is the shape
OMP just unpublished.

Hermes stays one-process tools. AgentWeb’s modular-monolith
thesis (A-001) matches this pin. Do not copy `pi-server` as a
product slice.

## Queue effect

A-006 stays **discard** (new citation: OMP 0.85.1 rolled back
publishing client/server). Q-014 stays **ready**. A-008 still
folder-move + shim (OMP images stay in `pi-ai`, not a new
package). Do not add npm workspaces to copy OMP’s publish
graph instead of Q-014.

## Next

Cycle 89: cheapest remaining mapping. Candidate: Hermes
`mcp_tool.py` still client-only (AgentWeb is the server).
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
