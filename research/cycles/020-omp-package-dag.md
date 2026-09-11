# Cycle 020 — OMP package DAG is the template; AgentWeb creative already matches

UTC: 2026-09-11T18:58Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **OMP (`can1357/oh-my-pi` package.json, fetched this cycle).**
   - `@oh-my-pi/pi-catalog` → `omptype`, `pi-utils` only.
   - `@oh-my-pi/pi-ai` → catalog, natives, utils, wire, omptype. **Does not
     depend on `pi-agent-core`.**
   - `@oh-my-pi/pi-agent-core` → **`pi-ai`** + catalog, natives, utils, wire,
     snapcompact.
   - `@oh-my-pi/pi-coding-agent` → `pi-agent-core` **and** `pi-ai`.

   Direction: `coding-agent → agent-core → ai → catalog`. Providers never
   import the loop. That is the nanoservice *logical* DAG; all still one
   bun workspace / one process for the CLI.

2. **AgentWeb already has that arrow for images.**
   `agentModeService.ts` L136 `import { normalizeImageModel } from './imageGeneration'`.
   Creative files do **not** import `agentModeService` (cycle 19 grep).
   `imageGeneration.ts` L1–6: axios, secrets, S3, `llmClients`,
   `usageRecorderService`, `llmPricing`. A-008 is a folder rename that
   **preserves** this DAG, not a new HTTP hop.

3. **The layer AgentWeb inverted vs OMP:** `utils/llmClients.ts` L33 and
   `utils/llmService.ts` L3 import `services/usageRecorderService`. In OMP,
   `pi-utils` does not depend on the app. Here the meter lives in `services/`
   and the client factory lives in `utils/`. Cycle 18 counted `utils → services`
   21 times. Do not “fix” by moving the meter into utils (PROTOCOL: one
   charge path). Park as A-009.

4. **Second leak, already noted:** `videoGeneration.ts` L6 imports
   `mcp/client/mcpClientService`. That is `creative → MCP client` — like
   `pi-ai` depending on `pi-coding-agent`. Leave it in the A-008 move.

5. **Hermes analog (architecture.md, cycle 17):**
   `registry.py` ← `tools/*.py` ← `model_tools.py` ← `run_agent.py`.
   Tools do not import the loop. Same arrow as OMP `ai ↛ agent-core`.

## DISCARD / rank

- A-006 stays discard.
- A-008 stays ready; first_slice now: also add a test that
  `creative/**` (or `imageGeneration.ts` until the folder exists) cannot
  import `agentModeService` — the package.json edge OMP gets for free.
- **A-009 PARK:** do not invert `llmClients` ↔ meter. Shared money hub
  stays in `services/`.
- Product READY unchanged.

## Mapping evidence

OMP DAG recorded in `COMPARISON.md` and `SERVICES_DAG.md`.

## Next

Cycle 21: collision-only unless a new PR hits `imageGeneration.ts` or
`apiTools.ts`. Optionally sketch the A-002 test as a 20-line jest
`fs.readFile` import grep (research note, not code). Unsubscribe after
`stop_after`.
