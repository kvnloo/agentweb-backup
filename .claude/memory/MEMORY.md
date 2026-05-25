# AgentWeb Cloud Dev - Engineering Knowledge

## Quick Reference
- Logs: `~/agentweb/logs/<service>.log`
- Services: `~/agentweb/test-env/dev-services.sh {status|restart|logs} <service>`
- Pre-commit: `cd backend && npx tsc && npm test`
- Test accounts (dev/EC2): `test@example.com` / `Test123!` (admin), `test1@example.com` / `Test123!` (basic)
- [Prod test account](prod-test-account.md): `test@agentweb.pro` / `WeNeedVeryReliableQualitySystem` at app.agentweb.pro

## Critical Rules
- You ARE the test env. Never run `test-env.sh sync` from cloud dev.
- Always use `useAuth()` for tokens, never `localStorage.getItem("token")`.
- Customer-portal = all user-facing features. Partner-portal = admin only.
- `customerPortalPages.ts` exists in TWO places (backend + customer-portal). Update both.
- Agent mode (`agentModeService.ts`) is the primary agent. Emma chatbot is secondary.
- Tool wiring: `apiTools.ts` -> `mcpToolRegistry` -> `emma/tools.ts` bridge -> `emmaToolRegistry` -> `agentModeService.toolRegistry`
- Admin features: check `isAdmin` at EVERY entry point (listing, install, execution).
- Run `npx tsc` after EVERY .ts file edit. Don't batch.

## Key Files (by size/importance)
- `backend/src/services/agentModeService.ts` (473KB) - agent mode chat
- `backend/src/services/db.ts` (125KB) - all DynamoDB ops
- `backend/src/services/chatbotService.ts` (76KB) - Emma chatbot
- `backend/src/services/emailService.ts` (58KB) - email via SMTP/Resend
- `backend/src/server.ts` - Express + Socket.IO setup
- `backend/src/app.ts` - routes + middleware

## Detailed Knowledge Files
- [architecture.md](architecture.md) - service architecture, data flows, LLM integration
- [debugging.md](debugging.md) - failure modes, log analysis, recovery procedures
- [patterns.md](patterns.md) - code conventions, DynamoDB, auth, deployment patterns
