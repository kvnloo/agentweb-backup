# Code Patterns & Conventions

## Portal Distinction (critical, learned from mistake)
- **Partner portal** = admin-only (user management, system config, admin dashboards)
- **Customer portal** = ALL user-facing features (tasks, chat, marketing hub, social posts, settings)
- When adding new pages for end users: ALWAYS use customer-portal

### Adding New Customer Portal Pages (4 files to update)
1. `customer-portal/src/services/customerPortalPages.ts` - page definition
2. `backend/src/services/customerPortalPages.ts` - SAME file, backend copy (easy to forget!)
3. `customer-portal/src/App.tsx` - route
4. `customer-portal/src/utils/pageTitles.ts` - page title

## Authentication

### Token Handling
```typescript
// WRONG - breaks delegation
const token = localStorage.getItem("token");

// CORRECT - works for both regular and delegated sessions
const { token } = useAuth();
```

### Delegation Flow
- Regular token: `localStorage` key `"token"`
- Delegated token: `sessionStorage` key `delegate_token_{email}`
- Backend: `req.user` = always the TARGET user (not admin). `req.delegateInfo` has admin info if delegated.

### Admin Checks
Check `isAdmin` at EVERY entry point: listing, installation, execution. One gate doesn't cover all paths.
Use `userDb.getUserById(userId)` to verify — don't trust context fields that may not exist.

## DynamoDB Patterns

### Always Use GSI Queries (never scan)
```typescript
// GOOD: GSI query
dynamodb.query({
  TableName: 'AW-TaskExecutions',
  IndexName: 'StatusStartTimeIndex',
  KeyConditionExpression: '#status = :status AND #startTime <= :now'
})

// BAD: full table scan
dynamodb.scan({ TableName: 'AW-TaskExecutions', FilterExpression: '...' })
```

### Item Size Limit (400KB)
Exclude large fields (e.g., `runResults`) from list queries. Only fetch on detail view.

## Agent Mode vs Emma Chatbot
- **Agent Mode** (`agentModeService.ts`) = PRIMARY agent. Wire new tools here first.
- **Emma Chatbot** (`chatbotService.ts`) = secondary customer support widget.
- Tool registry chain: `apiTools.ts` -> `mcpToolRegistry` -> `emma/tools.ts` bridge -> `emmaToolRegistry`

## Streaming Pattern
```typescript
// Backend: emit chunks via Socket.IO
socket.emit('agent-response-chunk', { chunk: text });

// Frontend: accumulate
socket.on('agent-response-chunk', (data) => {
  setResponse(prev => prev + data.chunk);
});
```

## Git & Deployment

### Commit Granularity
One logical change per commit. Separate: bug fix, feature, tests, release notes, docs.

### Build Naming
`<component>-<YYYYMMDD>-pr<number>` (e.g., `backend-20260218-pr42`)
Deployments triggered by file changes, not version bumps.

### PR Merging
Never use `--delete-branch`. Use `gh pr merge <N> --merge`.

### Deploy Commands (when explicitly asked)
```bash
gh workflow run deploy.yml -R AgentWebPro/agentweb --ref main
gh workflow run deploy.yml -R AgentWebPro/agentweb-customer-portal --ref main
```
Don't trigger deploys as part of "prep for deploy" — only on explicit "deploy now" / "force deploy".

## Frontend Environment Variables
Partner portal uses Vite (`VITE_*` prefix, replaced at build time).
Runtime env vars in Elastic Beanstalk do NOT affect the frontend.

## Secrets (AWS Secrets Manager)
- `dev/AgentWeb/Google/Search` - Custom Search API
- `dev/AgentWeb/Google/SearchConsole` - Search Console service account
- `dev/AgentWeb/Google/Share` - Drive service account for shared folders
- `prod/AgentWeb/Google/PageSpeed` - PageSpeed API
- `dev/AgentWeb/BaseHub` - BaseHub CMS
- `dev/AgentWeb/Webflow` or `dev/AgentWeb/Webflow/<userId>` - Webflow CMS
- `dev/AgentWeb/LinkedIn/Personal` + `Company` - LinkedIn creds

## Error Handling in Agent Engine (Python)
Always catch exceptions and update execution status to `failed` with error message in DynamoDB.
Never let a task hang in `running` state on failure.
