# WIP: Local Agent as Proxy for Restricted Platforms

**Date:** 2026-04-28  
**Branch:** `rui/investigate-local-agent-proxy`  
**Status:** Investigation complete. Implementation deferred to future sprint.

---

## Problem Statement

AgentWeb has no integration with WhatsApp, WeChat, X.com, Reddit, and similar platforms
that block cloud-based browser automation. These platforms either have no open API, require
a persistent logged-in desktop/mobile session, or aggressively detect headless browsers.

The idea: run a **local agent on a shared EC2 instance** that holds persistent sessions for
these platforms, and route tasks to it from the AgentWeb backend.

---

## Tools Researched

### OpenClaw
- A **personal AI agent** running locally on the host machine (went viral early 2026)
- Creator: Peter Steinberger — formerly known as "Moltbot" / "Clawdbot"
- GitHub: `github.com/openclaw/openclaw`
- Executes tools locally (terminal, browser, GitHub), extensible via community "Skills"
- Memory stored as JSONL + markdown files; uses ChatGPT subscription or LLM APIs
- **Not suitable** for our use case — personal productivity agent, not a messaging gateway

### Hermes Agent (NousResearch)
- Open-source, self-improving agent from Nous Research
- GitHub: `github.com/NousResearch/hermes-agent` | Docs: `hermes-agent.nousresearch.com`
- Has an explicit **gateway mode** (`hermes gateway setup` + `hermes gateway start`) designed
  to receive messages from external platforms and route them to the agent runtime
- Supports local Chrome via CDP for browser automation; smart model routing via `SOUL.md`
- **VPS deployment is the recommended production setup** — aligns with running on EC2
- **Open question:** which messaging platforms (WhatsApp, WeChat) are natively supported
  vs. requiring custom connectors — needs verification against Hermes docs/issues

---

## Proposed Architecture

```
AgentWeb Backend
      │
      │  POST /api/local-proxy/tasks
      │  { type: "whatsapp_scan", platform: "whatsapp", config: { ... } }
      ▼
Hermes Agent (shared EC2 instance, gateway mode)
      │
      │  hermes gateway → WhatsApp Web (browser via CDP)
      │  — reads group message history
      │  — identifies unanswered questions (LLM classification)
      ▼
Result POSTed back to AgentWeb webhook
      │
      ▼
Admin UI (partner-portal): table of groups × unanswered questions
```

### Key Design Decisions
- **Shared instance, not per-user:** one EC2 running Hermes serves all customers. Sessions
  belong to the admin's accounts, not individual users.
- **Task routing via `agentType` field:** add `agentType: "local-proxy"` to
  `AW-TaskExecutions`. Backend dispatcher checks this field; if set, pushes to local proxy
  instead of the existing browser-use agent engine.
- **Async result delivery:** local proxy POSTs results back to a webhook on the backend
  (no polling needed from the backend side).

---

## First Feature Scoped: WhatsApp Group Unanswered Question Scanner (Admin Tool)

**Goal:** Admin can trigger a scan of all WhatsApp groups, get back a list of groups with
pending unanswered questions — useful for support/community management.

### Components to Build

| Component | Location | Description |
|-----------|----------|-------------|
| Hermes gateway setup | EC2 (manual) | Install Hermes, log into WhatsApp Web once, persist session |
| `agentType` field | `AW-TaskExecutions` DynamoDB schema | Route flag for local-proxy vs browser-use |
| Local proxy route | `backend/src/routes/localProxy.ts` | New route: dispatch tasks to Hermes, receive webhook results |
| Task dispatcher update | `backend/src/services/agentModeService.ts` | Check `agentType` field, push to Hermes if `local-proxy` |
| Admin UI page | `partner-portal/src/` | Dashboard: groups × unanswered question counts + timestamps |

### Pre-Implementation Verification Needed
1. Confirm Hermes gateway supports WhatsApp natively (vs custom connector required)
2. Test Hermes gateway mode on EC2 with a WhatsApp Web session
3. Decide on webhook auth scheme (shared secret vs JWT) for result delivery back to backend

---

## Existing Agent Engine Context

The current agent engine (`agent-engine/task_monitor.py`) uses a **polling model**:
- Polls `AW-TaskExecutions` via `StatusStartTimeIndex` GSI every 5 seconds
- No `agentType` field exists today — all tasks go to `web_agent.py` (browser-use)
- Max 3 concurrent tasks per `MAX_CONCURRENT_TASKS` env var
- Only messaging integrations today: Slack (approval requests) + Email (notifications)

Adding `agentType: "local-proxy"` is a minimal, non-breaking change — `task_monitor.py`
can skip tasks with this field, and a new `local_proxy_agent.py` (or Hermes) handles them.

---

## Files to Create/Modify (when implementing)

- `backend/src/routes/localProxy.ts` — new
- `backend/src/services/localProxyService.ts` — new
- `backend/src/app.ts` — register new route
- `backend/src/__tests__/localProxy.test.ts` — new
- `partner-portal/src/pages/admin/WhatsAppScanner.tsx` — new
- DynamoDB: add `agentType` to `AW-TaskExecutions` (no migration needed — optional field)
