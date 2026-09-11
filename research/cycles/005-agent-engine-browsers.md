# Cycle 005 — agent-engine vs Agent Mode browsers

**When:** 2026-09-11  
**Focus:** Where browser-use still matters; cookies; WhatsApp; local agent.

## Three browser stacks (not two)

| Stack | Where | Session | Cookies | What it's for |
|---|---|---|---|---|
| **agent-engine** | Python VM, `task_monitor.py` polls `AW-TaskExecutions` every 5s, `MAX_CONCURRENT_TASKS=3` | Isolated Playwright via **browser-use** | S3 `CookieSync` (`prod/cookies/{userId}/`) | Classic NL web tasks, scheduled site work |
| **Playwright MCP** | Backend spawns `@playwright/mcp@0.0.70` per Agent Mode session | `--headless --no-sandbox --isolated` injected in `mcpClientService.ts` | `AW-BrowserCookies` + `save_browser_cookies` / `load_browser_cookies` (internal Emma tools) | Landing-page verify, screenshots, GSC-ish logged-in reads |
| **local-agent-relay** | `local-agent-relay/` still in tree | User's real Chrome via Codex | Host machine cookies | **DEAD** (ENG-383, 2026-07). Tools are fail-fast stubs. Replacement: **ENG-381**. |

Agent Mode is not a replacement for agent-engine. Playwright MCP cannot hold WhatsApp Web: isolated headless Chrome is exactly what those platforms detect, and the injector **unconditionally** adds `--headless` / `--isolated` even if admin config omits them (`dev.md` ~L7148).

## LLM path on agent-engine

`openrouter_gateway.py` is already the text/tool transport (legacy `platform->provider->model` IDs mapped). Timeouts are still process-kill (`TASK_EXECUTION_TIMEOUT_SECONDS`). Do not restack this — ENG-1416 inventory.

The strangler doc (`AGENTMODE_MIGRATION.md`) names the target loop as
"Claude-Code / OpenAI-agent-loop / **Hermes** / OpenClaw shaped". That is Q-010
(Harsha gravity), not a first PR.

## WhatsApp

- Cloud API: open PR **#2271** (Q-011 collision).
- Browser/session: needs a **non-headless, persistent, local** agent. That is
  the retired relay, not agent-engine, not Playwright MCP.
- WIP.md (Hermes on shared EC2) is the 2026-04 investigation; ENG-383 killed
  the Codex/ngrok instance of the same idea.

## Queue mutations

- **Q-011** reframed: Hermes as **ENG-381 successor** (local logged-in browser),
  not "compete with WhatsApp Cloud API". Still **park** until ENG-381 ownership
  is clear. Do not add `agentType` on Dynamo.
- Do **not** add a Comfy/browser-use item. Kevin's ComfyUI work is image graph,
  not this VM.
- `local-agent-relay/` in-tree is a fossil. Don't revive Codex/ngrok; if we
  revive anything, it's Hermes with a durable tunnel (Tailscale/`dash`, not
  ngrok).
