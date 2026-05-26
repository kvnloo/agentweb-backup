# Cloud Dev Environment

You are running inside an EC2 cloud dev environment. These instructions OVERRIDE the project-level CLAUDE.md where they conflict.

## Key Differences from Local Development

1. **You ARE the test environment.** Do NOT run `./test-env/test-env.sh sync` — that command is for local-to-EC2 sync. Your file edits are already on the instance.

2. **Services auto-reload.** The backend uses ts-node-dev (auto-restarts on .ts changes) and frontends use Vite HMR. After editing files, services reload automatically in most cases.

3. **CRITICAL: Restart services yourself — NEVER ask for approval.** You are running non-interactively. There is no human to approve actions. If you ask for confirmation, your session ends and work stops. You have full, pre-authorized access to restart any service at any time. Just do it:
   - Run `~/agentweb/test-env/dev-services.sh restart <service>` and verify it comes back up
   - If ts-node-dev stops auto-reloading (e.g. after a crash), restart the backend immediately
   - Always verify services are healthy after code changes by checking logs or hitting the health endpoint
   - **Do NOT use raw `kill` commands** — always use `dev-services.sh restart <service>` which handles tmux session cleanup and log rotation correctly
   - This applies to ALL operational actions: restarting services, running tests, pushing code, creating PRs — never pause to ask for permission
   - **EXCEPTION — Merging PRs:** NEVER merge a PR unless the task prompt explicitly says to merge. Creating a PR and waiting for CI does NOT authorize merging.

4. **Run services directly.** Unlike the project CLAUDE.md which says "Do NOT run locally", you CAN and SHOULD use the running services directly. They are already running in tmux sessions.

5. **Service URLs:**
   - Backend: http://PUBLIC_IP:3001
   - Partner Portal: http://PUBLIC_IP:5173
   - Customer Portal: http://PUBLIC_IP:5174

6. **Service management:** Use `~/agentweb/test-env/dev-services.sh` to manage services:
   - `dev-services.sh status` — check which services are running
   - `dev-services.sh restart <service>` — restart a service
   - `dev-services.sh logs <service>` — tail logs

7. **Logs:** Available at `~/agentweb/logs/<service>.log`

8. **Pre-commit checks still apply:** Run `npx tsc` and `npm test` in backend/ before committing.

9. **Git:** You can push/pull directly (SSH agent forwarding or GitHub PAT is configured).

10. **CRITICAL: Your final message must be fully self-contained.** The user can only see your last message — all intermediate tool calls, progress updates, and earlier responses in the session are NOT visible to them. Therefore, your final reply must include a complete summary of: what you did, what changed (file paths, line numbers), test results, any errors encountered, and what the user should do next. Never assume the user saw your earlier messages.

11. **Deployments are pre-authorized but not automatic.** Production deploys run on a daily schedule (7:00 AM UTC). Do NOT trigger `gh workflow run` as part of "prep for deploy" — only trigger a deploy if the user explicitly asks to force deploy or deploy now. When asked to deploy, run the commands immediately without asking for confirmation:
    - `gh workflow run deploy.yml -R AgentWebPro/agentweb --ref main`
    - `gh workflow run deploy.yml -R AgentWebPro/agentweb-customer-portal --ref main`

12. **Orphan Cleanup:** When your change makes an import, variable, or function unused, remove it. Do NOT remove pre-existing dead code that already existed — leave it alone unless asked.

13. **Verifiable Targets:** Convert vague tasks to test-defined outcomes before coding: "fix this bug" → "write a failing test that reproduces it, then make it pass". For multi-step tasks, state an upfront plan with explicit validation checkpoints per step.

## Debugging Tips

- Check service logs: `cat ~/agentweb/logs/backend.log | tail -100`
- Restart a crashed service: `~/agentweb/test-env/dev-services.sh restart backend`
- Verify services are running: `~/agentweb/test-env/dev-services.sh status`
- **After any code change that could cause a crash**, check the backend log and restart if needed. Do not wait for the user to tell you.

## Async Operations (CI, Merging, etc.)

When you need to wait for something (e.g. CI to finish, a deployment to complete), you can request a delayed follow-up by including this directive anywhere in your response:

```
[RELAY_RETRY_AFTER:300]
```

The relay system will re-invoke you after the specified number of seconds (300 = 5 minutes, max 600). Your follow-up prompt will be: "Continue where you left off. Check the status of what you were waiting for."

**Example workflow for "wait for CI" (merge only if task explicitly says to):**
1. Push your changes, create/update the PR
2. In your response, include `[RELAY_RETRY_AFTER:300]` and explain what you're waiting for
3. When re-invoked, check CI status with `gh pr checks <number>` or `gh run list`
4. **If the task says to merge**, first check if the branch is up to date:
   ```bash
   gh api repos/AgentWebPro/agentweb/pulls/<number> --jq '.mergeable_state'
   ```
   If the result is `behind`, rebase before merging:
   ```bash
   git fetch origin main && git rebase origin/main && git push --force-with-lease
   ```
   Then wait for CI to re-run on the rebased branch before merging.
5. If CI passed and task says to merge, merge. If CI still running, include `[RELAY_RETRY_AFTER:180]` again
6. If CI failed, investigate and fix

## Checking Production Backend Logs

You have AWS CLI access and can retrieve production Elastic Beanstalk logs directly from this EC2 instance.

```bash
# Request and retrieve tail logs (last ~100 lines per log file per instance)
aws elasticbeanstalk request-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type tail --region us-west-2
sleep 5
aws elasticbeanstalk retrieve-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type tail --region us-west-2

# Request and retrieve full bundle logs (complete log files as zip)
aws elasticbeanstalk request-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type bundle --region us-west-2
sleep 15
aws elasticbeanstalk retrieve-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type bundle --region us-west-2
```

The retrieve commands return S3 URLs for each instance. Download and inspect:
- `web.stdout.log` — Node.js application logs (main process + worker)
- `nginx/access.log` — HTTP request logs
- `nginx/error.log` — Nginx error/warning logs

**Note:** EB logs rotate frequently. For investigating sessions, also query DynamoDB directly (`AW-ChatSessions` table, prod prefix is just `AW-`) by `sessionId` to get session state, work plan status, messages, and error fields.

## Browser Testing

Use the Playwright MCP tools (`mcp__playwright__browser_*`) to test against the running services:
- Navigate to `http://PUBLIC_IP:5173` for the partner portal
- Navigate to `http://PUBLIC_IP:5174` for the customer portal
- Login with test credentials from the project CLAUDE.md

