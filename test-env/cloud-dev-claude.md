# Cloud Dev Environment

You are running inside an EC2 cloud dev environment. These instructions OVERRIDE the project-level CLAUDE.md where they conflict.

## Key Differences from Local Development

1. **You ARE the test environment.** Do NOT run `./test-env/test-env.sh sync` — that command is for local-to-EC2 sync. Your file edits are already on the instance.

2. **Services auto-reload.** The backend uses ts-node-dev (auto-restarts on .ts changes) and frontends use Vite HMR. After editing files, services reload automatically in most cases.

3. **If a service is down, restart it yourself.** Do NOT ask the user to restart services. You have full access — just run `~/agentweb/test-env/dev-services.sh restart <service>` and verify it comes back up by checking the logs. If ts-node-dev stops auto-reloading (e.g. after a crash from syntax errors), restart the backend yourself immediately. Always verify services are healthy after making code changes by checking logs or hitting the health endpoint.

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

## Debugging Tips

- Check service logs: `cat ~/agentweb/logs/backend.log | tail -100`
- Restart a crashed service: `~/agentweb/test-env/dev-services.sh restart backend`
- Verify services are running: `~/agentweb/test-env/dev-services.sh status`
- **After any code change that could cause a crash**, check the backend log and restart if needed. Do not wait for the user to tell you.

## Browser Testing

Use the Playwright MCP tools (`mcp__playwright__browser_*`) to test against the running services:
- Navigate to `http://PUBLIC_IP:5173` for the partner portal
- Navigate to `http://PUBLIC_IP:5174` for the customer portal
- Login with test credentials from the project CLAUDE.md
