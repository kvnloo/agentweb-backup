# Debugging Knowledge

## Cloud Dev Environment Recovery

### Service Crashed
1. Check: `~/agentweb/test-env/dev-services.sh status`
2. View logs: `tail -100 ~/agentweb/logs/backend.log`
3. Restart: `~/agentweb/test-env/dev-services.sh restart backend`
4. Verify: check logs again or hit health endpoint

### ts-node-dev Stops Auto-Reloading
Happens after syntax errors crash the process. Fix: restart backend immediately.
Don't wait for user to tell you — check logs after any code change that could crash.

### Backend Won't Start
- Check for TypeScript errors: `cd backend && npx tsc`
- Check for port conflicts: `lsof -i :3001`
- Check .env is present and valid

## Production Debugging

### Elastic Beanstalk Logs
```bash
# Tail logs (quick, last ~100 lines)
aws elasticbeanstalk request-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type tail --region us-west-2
sleep 5
aws elasticbeanstalk retrieve-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type tail --region us-west-2

# Bundle logs (full, takes longer)
aws elasticbeanstalk request-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type bundle --region us-west-2
sleep 15
aws elasticbeanstalk retrieve-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type bundle --region us-west-2
```
Returns S3 URLs. Key files: `web.stdout.log`, `nginx/access.log`, `nginx/error.log`

### EB Logs Rotate Frequently
For session investigation, query DynamoDB directly:
- Table: `AW-ChatSessions` (prod prefix is `AW-`)
- Query by `sessionId` to get: session state, work plan status, messages, error fields
- For scheduled sessions: check `runResults` field on `AW-TaskSchedules`

### Reproducing Prod Issues
See `docs/debug-production.md` for copying prod sessions to dev.

## Common Failure Modes

### DynamoDB Item Size Limit (400KB)
- Symptom: `ValidationException: Item size has exceeded the maximum allowed size`
- Cause: large fields (e.g., `runResults` on scheduled chats)
- Fix: exclude large fields from list queries, only fetch on detail view

### DynamoDB Throttling
- Symptom: `ProvisionedThroughputExceededException`
- Fix: use GSI queries (not scans), implement exponential backoff

### Socket.IO Connection Issues
- Check JWT token validity in handshake
- Verify CORS settings in `server.ts`
- Check `FRONTEND_URL` / `CUSTOMER_FRONTEND_URL` env vars match actual origins

### Agent Mode Streaming Failures
- Check `agentModeService.ts` for error handling in stream pipeline
- Verify LLM provider API keys in Secrets Manager
- Check inference profile ARN for Bedrock models

## CI Failures

### TypeScript Compilation
- Always run `npx tsc` after EVERY .ts file edit
- Common: missing imports, type mismatches after refactoring
- Fix: resolve errors before committing

### Test Coverage < 95%
- CI requires >= 95% on statements, branches, functions, lines
- Run: `npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary`
- Ensure all new code branches are covered

## Async Wait Pattern (CI, Deploy)
Use `[RELAY_RETRY_AFTER:300]` in response to get re-invoked after N seconds (max 600).
Before merging: check `gh api repos/AgentWebPro/agentweb/pulls/<N> --jq '.mergeable_state'`
If `behind`: `git fetch origin main && git rebase origin/main && git push --force-with-lease`, then wait for CI again.
