# Lessons Learned - AgentWeb

This file captures patterns and mistakes to avoid. Updated after corrections from users to prevent repeat errors.

## Pattern Recognition

### Authentication & Token Handling
- **Lesson:** Never use `localStorage.getItem("token")` directly in frontend code
  - **Why:** Doesn't work with delegation (delegated tokens stored in sessionStorage)
  - **Fix:** Always use `const { token } = useAuth()` from context
  - **Date:** Documented in CLAUDE.md

### Test Environment Workflow
- **Lesson:** Always sync after code changes when test environment is active
  - **Why:** No automatic file watcher - changes must be explicitly deployed
  - **Fix:** Run `./test-env/test-env.sh sync [service]` after each change
  - **Date:** Documented in CLAUDE.md

### TypeScript Compilation
- **Lesson:** Run `npx tsc` after EVERY backend file edit, including tests
  - **Why:** Type errors not caught during hot reload; prevents CI failures
  - **Fix:** Don't batch - verify compilation after each file change
  - **Date:** Documented in CLAUDE.md

### Working Directory Isolation
- **Lesson:** Never hardcode paths like `/Users/user/path/agentweb/`
  - **Why:** User has multiple clones; hardcoded paths silently edit wrong files
  - **Fix:** Always use working directory from `<env>` context
  - **Date:** Documented in CLAUDE.md

## Testing Patterns

### Backend Service Tests
- **Lesson:** Mock AWS services (DynamoDB, S3, Secrets Manager) in unit tests
  - **Why:** Tests must run without AWS credentials or network access
  - **Fix:** Use Jest mocks for `aws-sdk` calls
  - **Example:** See `backend/src/__tests__/agentModeService.*.test.ts`

### Coverage Requirements
- **Lesson:** CI requires ≥95% coverage on statements, branches, functions, lines
  - **Why:** Enforced by Jest config and CI pipeline
  - **Fix:** Ensure all new code paths have test coverage before committing

## Deployment Patterns

### Build Naming
- **Lesson:** Deployments triggered by file changes, not version bumps
  - **Why:** GitHub Actions uses path filters to detect changes
  - **Fix:** No need to update package.json versions for deployment

### Elastic Beanstalk Logs
- **Lesson:** EB logs rotate frequently - use DynamoDB for investigation
  - **Why:** Session state in AW-ChatSessions table persists longer
  - **Fix:** Query by sessionId to get messages, errors, work plan status

### Portal Distinction
- **Lesson:** partner-portal is admin-only; customer-portal is for ALL user-facing features
  - **Why:** Put social posts page in partner-portal instead of customer-portal — had to revert
  - **Fix:** Always use customer-portal for end-user pages (tasks, chat, marketing, social posts, settings)
  - **Date:** 2026-03-11

### Adding New Customer Portal Pages
- **Lesson:** `customerPortalPages.ts` exists in TWO places — both must be updated
  - **Why:** Forgot backend copy; admin subscription UI didn't show the new page
  - **Fix:** Update both `backend/src/services/customerPortalPages.ts` AND `customer-portal/src/services/customerPortalPages.ts`
  - **Also:** `customer-portal/src/App.tsx` (route), `customer-portal/src/utils/pageTitles.ts` (title)
  - **Date:** 2026-03-11

### Agent Mode vs Emma Chatbot
- **Lesson:** Agent Mode (`agentModeService.ts`) is the PRIMARY agent; Emma chatbot (`chatbotService.ts`) is secondary (customer support widget)
  - **Why:** Wired admin work plan tools into chatbotService instead of agentModeService — tools weren't available in agent-mode sessions where they're actually needed
  - **Fix:** Always wire new tools into agent mode first. Agent mode uses `emmaToolRegistry` (bridged from `mcpToolRegistry` in `emma/tools.ts`). The chatbot uses a separate `toolsToInclude` approach in `chatbotService.ts`.
  - **Architecture:** `apiTools.ts` → `mcpToolRegistry` → bridge in `emma/tools.ts` → `emmaToolRegistry` → `agentModeService.toolRegistry`
  - **Date:** 2026-03-13

### Admin-Only Features Must Check isAdmin at Every Entry Point
- **Lesson:** When adding admin-only features, verify authorization at EVERY code path that exposes or grants access — not just one
  - **Why:** Added admin tools to `list_available_skills` in `emma/tools.ts` without an `isAdmin` check, allowing non-admin users to see admin tools in the skill list. The install path was gated, but listing wasn't.
  - **Fix:** Always check `user?.isAdmin === true` before exposing admin-only data. Check ALL entry points: listing, installation, execution. Never assume one gate covers all paths.
  - **Pattern:** Use `userDb.getUserById(userId)` to verify admin status; don't trust context fields that may not exist.
  - **Date:** 2026-03-13

## Cloud Test Environment SSH

### SSH User is ec2-user, NOT ubuntu
- **Lesson:** Test-env EC2 instances use `ec2-user`, not `ubuntu`
  - **Why:** The AMI is Amazon Linux (not Ubuntu). The user-data script sets the password via `echo "ec2-user:${SSH_PASSWORD}" | chpasswd`. Tried `ubuntu@` repeatedly before realizing the correct user.
  - **Fix:** Always SSH as `ec2-user@<PUBLIC_IP>` with the password from `agentweb/test-env/ssh-password`
  - **Secret:** `agentweb/test-env/ssh-password` (NOT `agentweb/cloud-dev/ssh-password`)
  - **Date:** 2026-04-01

### Stop/Start Changes the Public IP
- **Lesson:** After an EC2 stop/start, the public IP changes
  - **Why:** Stop/start deallocates and reassigns the public IP (unlike reboot)
  - **Fix:** After stop/start, run `aws ec2 describe-instances --instance-ids <id> --query 'Reservations[0].Instances[0].PublicIpAddress'` to get the new IP
  - **Date:** 2026-04-01

### ALL Cloud Env Services Don't Auto-Restart After Stop/Start
- **Lesson:** ALL 5 tmux services are started by user-data at first boot only — NONE restart on stop/start
  - **Why:** cloud-init user-data only runs once (at first boot). Stop/start only re-runs lightweight cloud-init phases (config/final), not the full user-data script.
  - **Services:** `backend`, `partner-portal`, `customer-portal`, `test-env-access`, `claude` — all 5 must be manually started
  - **Also:** The public IP changes on stop/start — must update `.env`, `.env.local` files AND Notion page IP field
  - **Fix after stop/start:**
    1. Get new IP: `aws ec2 describe-instances --instance-ids <id> --query 'Reservations[0].Instances[0].PublicIpAddress'`
    2. Update `.env` files with new IP (use sudo for `.env.local` files, they're root-owned)
    3. Start all 5 sessions: backend, partner-portal, customer-portal, test-env-access, claude
    4. Update Notion Public IP field
  - **Monitoring service:** `test-env-access` is the one that polls Notion for new comments and re-triggers Claude. If it's not running, new comments won't be processed.
  - **Date:** 2026-04-02

### Don't Add a Polling Loop — Restart test-env-access Instead
- **Lesson:** When Notion comments aren't being picked up (status stuck on "In Review" after user replies), the fix is to restart the `test-env-access` tmux session — NOT to add a polling loop to `.claude-run.sh`
  - **Why:** The comment relay already works via webhook: Notion → backend `/webhooks/notion-dev-env` → `relayPromptToEC2()` → port 5175 on EC2 → `test-env-access/server.js` → spawns Claude with `--resume`. Adding a polling loop to `.claude-run.sh` creates a **duplicate trigger** — both the webhook and the loop pick up the same comment and fire two Claude runs.
  - **Root cause of missing comments:** `test-env-access` not running (it's stopped/crash after instance restart)
  - **Fix:** `tmux new-session -d -s test-env-access -c /home/ec2-user/agentweb/test-env-access "node server.js 2>&1 | tee -a /var/log/test-env/test-env-access.log; exec bash"`
  - **How to diagnose:** `ss -tlnp | grep 5175` — if nothing listening, `test-env-access` is down
  - **Date:** 2026-05-20

## Data Safety

### Never Delete Test Accounts or Any User Account
- **Lesson:** Never delete user accounts from DynamoDB — especially `test@example.com` and `test1@example.com`
  - **Why:** Deleting a user row wipes the account entirely. The `createUser` condition (`attribute_not_exists(email)`) only protects against overwrite if the row exists — once deleted, anyone can re-register with the same email and create a blank account, losing all historical data (tasks, sessions, org membership, configs).
  - **What happened:** `test@example.com` was deleted (mechanism unknown — no CloudTrail trail was configured), then someone signed up fresh with the same email, replacing the original admin account that owned the AgentWeb org with 283 tasks and 2409 chat sessions.
  - **Fix:** If an account needs to be "reset", deactivate it (`isActive: false`) or clear specific fields — never delete the row. If you must delete a test account for a specific reason, recreate it immediately via `npm run create-admin` and restore the userId.
  - **Date:** 2026-05-20

## Domain Terminology

### "Tasks" = Web Automation Subagent Activities (NOT User Activities)
- **Lesson:** In this codebase, "tasks" (`AW-Tasks`, `AW-TaskExecutions`) refer to web automation/browser automation jobs that the platform's AI agent (subagent) runs on behalf of users — NOT to user-initiated activities.
  - **Why:** Confused "user activities" with task execution counts when designing an "Activities" feature. Task count is NOT a measure of user engagement in the traditional sense.
  - **Domain model:**
    - `AW-Tasks` / `AW-TaskExecutions` = web automation jobs (browser agent scraping/clicking/filling forms for the user) — subagent activities
    - `AW-ChatSessions` = actual user interactions (the user chatting with the AI agent mode) — user activities
    - `AW-TaskSchedules` = recurring automation schedules
  - **Fix:** When showing "user activities" for an admin, use `AW-ChatSessions` (user chatting with AI), NOT task executions (subagent automation). Task counts in the admin UI labeled "Tasks / Workflows" represent automation setups, not user engagement sessions.
  - **Date:** 2026-04-09

## CRM / Outreach Safety

### CRITICAL: Always scope outreach operations to the configured list — never fan out to all user lists
- **Lesson:** When implementing any feature that sends messages, emails, or takes actions on leads, ALWAYS filter to the exact list(s) explicitly configured for that operation. Never iterate over all lists a user owns as a "convenience" fallback.
- **Why:** `enrollNewConnections` fetched ALL of a user's lead lists via `getLeadListsByUserId()` instead of only the lists in `seq.autoEnrollListIds`. This caused 6 people from unrelated lists to receive unsolicited LinkedIn outreach messages. Real messages were sent to real people who were not in the intended campaign list. This is damaging — it erodes trust with contacts, can be flagged as spam, and is impossible to fully undo once sent.
- **The error pattern to avoid:**
  ```typescript
  // WRONG — iterates every list the user owns
  const lists = await crmDb.getLeadListsByUserId(seq.userId);
  for (const list of lists) { /* search and act */ }

  // RIGHT — filter to only the explicitly configured lists
  const lists = await crmDb.getLeadListsByUserId(seq.userId);
  for (const list of lists) {
    if (seq.targetListIds?.length && !seq.targetListIds.includes(list.listId)) continue;
    /* search and act */
  }
  ```
- **Rule:** Any function that dispatches outreach (LinkedIn messages, emails, enrollments, invitations) MUST:
  1. Have a clearly named scope parameter (`listId`, `targetListIds`, `autoEnrollListIds`, etc.)
  2. Enforce that scope before touching any lead record
  3. Never default to "all lists" as a fallback — if the scope is unset, fail loudly or require explicit opt-in
- **Test requirement:** Every outreach-dispatching function must have a test that asserts leads outside the configured list are NOT contacted.
- **Date:** 2026-05-20

## Code Patterns

### DynamoDB Queries
- **Lesson:** Use GSI queries instead of scans
  - **Why:** Scans are slow and expensive on large tables
  - **Fix:** Create GSIs for common query patterns (status+time, userId, etc.)

### Commit Granularity
- **Lesson:** Each commit should cover one logical change
  - **Why:** Makes git history clear and reviewable
  - **Fix:** Separate commits for: bug fix, feature, tests, release notes, docs

---

**Note:** Add new lessons to this file after ANY correction from users. Include:
- What went wrong
- Why it happened
- How to prevent it
- Example or reference

## Reading an adjacent function is not reading the function (ENG-941, 2026-08-14)

- **What went wrong:** claimed "ad sets default to PAUSED" and built the launch gate's predicate on it. `createAdSet` sets status only when provided, so an omitted status falls through to Meta's default of ACTIVE — an ad set created with no status started delivering completely ungated. Same day, claimed "Emma has exactly 4 landing-page tools" and used it to conclude a capability didn't exist.
- **Why it happened:** the PAUSED default was read from `createCampaign`, one function away. The tool list was read from a gating array in `agentModeService`, not the registry in `emma/tools.ts`. Both sources were adjacent, plausible, and wrong. Both claims were stated with confidence.
- **How to prevent it:** before asserting a default, a capability, or a list, open the exact function or registry that produces it. "I checked" means naming the file and line you checked, not the neighbourhood. If a claim is load-bearing for a design decision, quote the line.
- **Reference:** `metaService.createAdSet` vs `createCampaign`; `emma/tools.ts` registry vs `agentModeService.ts:6565`.

## A safety gate must be tested for being reached, not just for being right (ENG-941, 2026-08-14)

- **What went wrong:** the pure check and the enforcement logic were both well covered, and neither would have failed if the gate were never called at all.
- **Why it happened:** unit tests exercise a function directly. A gate that is wired in wrongly — or after an earlier early-return — is indistinguishable from a correct one at that level. The first wiring test immediately revealed the ENG-400 confirmation gate returns before the tracking gate is reached.
- **How to prevent it:** for anything that blocks, add a test that drives the real entry point and asserts the downstream write did NOT happen. Assert the absence of the side effect, not just the returned verdict.
- **Reference:** `metaLaunchGateWiring.test.ts`.

## Run the whole suite, and don't trust a CI score you didn't attribute to a commit (ENG-941, 2026-08-14)

- **What went wrong:** ran only the suites that looked related, and pushed. The full run found 1 failure in 22,920 — the gate correctly failing closed in a suite that mocks neither credentials nor the Graph API. Separately, a failing "Require Greptile Review" was read as a verdict on fixed code when it was re-reading a review posted before the fixes.
- **Why it happened:** a new dependency reaches suites that never mentioned it. And the required check re-reads the last posted review, so its state can lag the head by an entire round.
- **How to prevent it:** run `npm test` in full before pushing anything that adds a dependency to a shared path. To judge a review, count the review comments and check which head they were posted against — do not read the score string alone.
- **Reference:** `agentModeService.audienceCampaignWorkflows.test.ts`; PR #2406.
