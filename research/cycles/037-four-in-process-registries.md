# Cycle 037 — Four in-process registries; Q-014 is only the MCP instance’s list

UTC: 2026-09-11T19:37Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). Filter
   `apiTools|imageGeneration|loops/core|loops/index|emma/registry|agentStep`:
   **empty** (A-007 / A-008 / A-002 targets). A-005 pile **unchanged**:
   **#2871 #2861 #2832 #2563 #2060 #1584 #1076** still touch
   `agentModeService.ts`. Scorecard (`AGENTMODE_MIGRATION.md` L44) still
   says **23,895**; disk is **40,571**. `toolDispatch.ts` is **1,409** vs
   scorecard **522**. A-005 stays park.

2. **`emma/registry.ts` is three lines.** L1–3:
   `import { McpToolRegistry } from '../mcp/server/registry'` then
   `export const emmaToolRegistry = new McpToolRegistry()`. In-app Emma
   is a **second instance** of the MCP registry class, not a nanoservice.
   Hermes has one `registry.py`. AgentWeb already has four in-process
   tables:

   | Table | Who registers | Hermes analog |
   |---|---|---|
   | `mcpToolRegistry` | `apiTools` / `workflowTools` / `evaluationTools` | MCP *server* catalog (`tools/list` = `mcpServerCore.ts` L81–83 `getToolDefinitions()`) |
   | `emmaToolRegistry` | `emma/tools.ts` L4996 `generate_image` (policy path) | In-app tool table |
   | `mcpClientService.getTools()` | vendor MCP (GitHub/Playwright/Higgsfield) | Hermes MCP *client* |
   | `this.toolRegistry` | copy: vendor tools L1827–1828; Emma tools L1891–1898 | session loop table |

   `registerTools()` L1868–1870 side-effect-imports `evaluationTools` and
   `emma/tools` (which L7240 also imports `apiTools`). chatbotService
   L5254–5256: Emma handler **then** MCP fallback.

3. **Q-014 must not dual-register.** `evaluationTools.ts` L62 copies
   one handler onto both MCP and Emma instances. `generate_image` is
   **already** on Emma (`emma/tools.ts` L4996, richer description, policy
   `generateImage`). MCP copy is `apiTools.ts` L2075 `internal: true` +
   mcpFetch. Listing it is `ListToolsRequestSchema` L81–83 filtering
   `!internal`. Do not `emmaToolRegistry.register(mcpToolRegistry.getTool('generate_image'))` — two execute paths (policy vs
   loopback) for one name.

4. **`executeAgentStep` still throws** (`agentStep.ts` L48–55). A-003
   stays park. Scorecard “2 / 6 seams” with a 40.5k monolith is why
   A-005 is a ratchet after the pile shrinks, not a nanoservice rewrite.

## DISCARD / rank

No rank change. A-005 stays park (7 PRs). A-006 stays discard (four
tables already compose in-process). Q-014 stays ready (flag + L91).
Product READY unchanged.

## Mapping evidence

`MODULE_MAP.md` emma/registry. `COMPOSITION.md` four tables.
`queue.json` A-005 why (LOC still 40,571).

## Next

Cycle 38: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
