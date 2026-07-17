# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Global Development Rules

**IMPORTANT:** This project follows the global development rules defined in `~/.claude/CLAUDE.md`. When conflicts arise, these project-specific rules take precedence.

### Rule 1: Design Before Code

Before writing implementation code:
1. Ask clarifying questions if requirements are unclear
2. Produce a design or plan and get explicit approval
3. No approval = no code

### Rule 2: TDD - Tests Before Implementation

**Applies to:** Backend service/logic changes (routes, services, utilities, database operations)
**Does not apply to:** Frontend UI components, configuration files, documentation, CLAUDE.md itself

For backend logic changes:
1. Write FAIL test cases first (minimum 3: invalid inputs, boundary conditions, error paths)
2. Write SUCCESS test cases (minimum 1: happy path)
3. Verify all new tests FAIL (no implementation yet)
4. Implement the minimum code to pass all tests
5. Verify ALL tests pass (new + existing)

**A task is NOT done until all tests pass.** Never skip tests. Never delete failing tests. Never mark a task complete with failing tests.

For frontend and other changes, follow the existing testing strategy section below.

### Rule 3: Workflow Orchestration

**Note:** The system prompt already handles plan mode (EnterPlanMode tool) and subagent usage (Task tool). These rules complement those built-in behaviors with project-specific guidance.

**Plan Mode Default:**
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately – don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

**Subagent Strategy:**
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

**Self-Improvement Loop:**
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review `tasks/lessons.md` at session start for relevant patterns

**Verification Before Done:**
- Never mark a task complete without proving it works
- Run verification checks (see "Pre-Commit Checks" section below)
- Ask yourself: "Would a staff engineer approve this?"
- For test environment: always sync after changes (see "Cloud Test Environment" section)

**Demand Elegance (Balanced):**
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it

**Autonomous Bug Fixing:**
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

**Verifiable Targets:**
- Convert vague tasks to test-defined outcomes before coding: "fix this bug" → "write a failing test that reproduces it, then make it pass"
- "add validation" → "write tests for invalid inputs, then implement until they pass"
- For multi-step tasks, state the plan upfront with explicit validation checkpoints per step

### Rule 4: Task Management

**Note:** Use the TodoWrite tool (from system prompt) for session-level task tracking. Use `tasks/todo.md` for project-level task planning that persists across sessions.

**Session-Level Tasks (TodoWrite tool):**
1. Use TodoWrite for multi-step tasks within a conversation
2. Mark items as in_progress, completed as you work
3. Keep exactly ONE task in_progress at a time

**Project-Level Tasks (tasks/todo.md file):**
1. Document parked tasks, active features, completed work
2. Maintain checkable items for complex features
3. Add design docs and success metrics for major initiatives

**Always:**
- Capture lessons in `tasks/lessons.md` after ANY user correction
- Verify work is complete before marking tasks done (see "Pre-Commit Checks" section)

### Rule 5: Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
- **Orphan Cleanup**: When your change makes an import, variable, or function unused, remove it. Do NOT remove pre-existing dead code that already existed — leave it alone unless asked.

## CRITICAL: Working Directory Rule

**NEVER navigate outside or reference files outside the current working directory.** The user has multiple clones of the same repo locally. Always use the working directory from the environment (shown in `<env>`) as the base path for ALL file operations. Do not hardcode or assume paths like `/Users/ruiwang/Documents/GitHub/agentweb/` — always use the actual working directory (e.g. `/Users/ruiwang/Documents/GitHub/agentweb3/`). Referencing the wrong clone will silently edit the wrong files.

## Core Architecture

AgentWeb is a multi-tenant web automation platform with three main components:

1. **Backend (Node.js/TypeScript)** - Express API server with Socket.IO for real-time chat
2. **Agent Engine (Python)** - Browser automation engine using browser-use library and playwright
3. **Frontend Applications (React/TypeScript)**:
   - Partner Portal (admin/partner interface) - in this repo at `partner-portal/` — **admin-only features** (user management, system config, admin dashboards)
   - Customer Portal (end-user interface) - in this repo at `customer-portal/` — **all user-facing features** (tasks, chat, marketing hub, social posts, settings, etc.). When adding new UI pages for end users, always use customer-portal, NOT partner-portal.
   - Growth Genius Chat - separate repo

### Data Flow

```
Frontend → Backend API (Express) → DynamoDB (AWS)
                ↓
         Task Execution Queue
                ↓
    Agent Engine (Python) → Browser Automation → Target Websites
```

The backend manages tasks and schedules, stores them in DynamoDB, and the agent engine polls for pending tasks to execute.

## Development Commands

**CRITICAL: Do NOT run the backend, partner-portal, or customer-portal locally for manual testing.** Always use the cloud test environment (`./test-env/test-env.sh launch` then `./test-env/test-env.sh sync`) for testing changes. The commands below (`npm run dev`) are documented for reference only. Local runs should be limited to `npx tsc` (compilation checks) and `npm test` (unit tests).

### Backend

```bash
cd backend

# Development (with hot reload)
npm run dev

# Build TypeScript
npm run build

# Verify TypeScript compilation (REQUIRED before committing)
npx tsc

# Run tests (not in CI - run locally before PRs)
npm test

# Create DynamoDB tables (development)
NODE_ENV=development npx ts-node src/scripts/create-tables.ts

# Create DynamoDB tables (production)
NODE_ENV=production npx ts-node src/scripts/create-tables.ts

# Create admin account
npm run create-admin
```

Backend runs on port 3001 by default.

**IMPORTANT:** When taking over the backend (starting it via `npm run dev` or similar), always redirect output to `/tmp/backend.log` so logs can be reviewed later. For example:

```bash
cd backend
npm run dev > /tmp/backend.log 2>&1 &
```

Use `tail -f /tmp/backend.log` or the Read tool on `/tmp/backend.log` to check logs during development.

**IMPORTANT:** Always run `npx tsc` to verify TypeScript compilation before committing changes. This catches type errors early and prevents CI failures.

### Partner Portal

```bash
cd partner-portal

# Local development (connects to local backend)
npm run dev

# Local development with staging backend
VITE_API_URL=https://api-stage.agentweb.pro VITE_CUSTOMER_FRONTEND_URL=http://localhost:5174 VITE_DEBUG=true npm run dev

# Build for production
VITE_API_URL=https://api.agentweb.pro \
VITE_CUSTOMER_FRONTEND_URL=https://app.agentweb.pro \
VITE_DEBUG=false \
npm run build
```

Partner portal runs on port 5173 by default.

### Agent Engine

```bash
cd agent-engine

# Create conda environment (first time setup)
conda env create -f environment.yml

# Activate environment
conda activate agent-engine

# Install playwright browsers (first time setup)
playwright install

# Run the agent engine (monitors for tasks)
python task_monitor.py

# Run tests
python run_tests.py
```

The agent engine continuously polls DynamoDB for pending task executions and scheduled tasks.

## Database Schema (DynamoDB)

Tables are prefixed with `Dev-` in development, no prefix in production.

**Key Tables:**

- `AW-Users` - User accounts with authentication
- `AW-Tasks` - Task definitions (prompts, configs)
- `AW-TaskExecutions` - Task execution records
  - GSI: `StatusStartTimeIndex` (status + startTime) - used by agent engine to find pending tasks
  - GSI: `UserIdIndex` (userId + startTime) - used to query user's task history
- `AW-TaskSchedules` - Recurring task schedules (daily/weekly/monthly)
  - GSI: `StatusStartTimeIndex` (status + nextRunTime) - used by agent engine to find due schedules
  - GSI: `UserIdIndex` (userId) - used to query user's schedules
- `AW-Subscribers` - Task subscribers for email notifications
- `AW-Configs` - User website configurations and API integrations
- `AW-ChatSessions` - Agent mode chat sessions
  - GSI: `AdminUpdatedAtIndex` (adminListPartition + updatedAt) - used for admin chat history pagination
- `AW-EmailEvents` - Email tracking events for lead engagement
  - GSI: `EmailDomainLeadEmailIndex` (emailDomain + leadEmail) - used for efficient lead queries

## Backend Architecture

### Key Service Files

- `services/db.ts` (125KB) - Main DynamoDB operations for all tables
- `services/agentModeService.ts` (473KB) - Agent mode chat functionality, handles streaming responses and function calls
- `services/chatbotService.ts` (76KB) - Emma chatbot (in-app assistant) with context awareness
- `services/emailService.ts` (58KB) - Email handling via SMTP and Resend
- `services/imageGeneration.ts` (38KB) - Image generation via Google Veo, Runway, and other providers
- `services/linkedInService.ts` - LinkedIn integration (personal and company profiles)
- `services/gtmPlanNotificationService.ts` - GTM plan approval workflow with Slack integration

### Route Organization

Routes are in `backend/src/routes/` organized by feature area:
- `auth.ts` - Authentication (JWT, Google OAuth)
- `tasks.ts` - Task CRUD operations
- `agentMode.ts` - Agent mode chat API
- `chatbot.ts` - Emma chatbot API
- `admin.ts` - Admin dashboard operations
- `schedules.ts` - Task scheduling
- `workflows.ts` - Task templates and workflows
- `gtmPlan.ts` - GTM planning and approval
- `seo.ts` - SEO metrics (Google Search Console, Analytics)
- `crm.ts` - Lead management
- `blog.ts` - Blog publishing (BaseHub and Webflow CMS)
- `connectedAccounts.ts` - Social media account connections
- `linkedinAuth.ts` - LinkedIn OAuth flow
- `slack.ts` - Slack integration for approvals

### Authentication

#### Token Management

**CRITICAL: Never use `localStorage.getItem("token")` directly in frontend code!**

Always use the token from `useAuth()` context:

```typescript
// ❌ WRONG - Does not work with delegation
const token = localStorage.getItem("token");

// ✅ CORRECT - Works with both regular and delegated sessions
const { token } = useAuth();
```

**Why:**
- Regular sessions: Token stored in `localStorage` with key `"token"`
- Delegated sessions: Token stored in `sessionStorage` with key `delegate_token_{email}`
- The AuthContext handles getting the correct token automatically

#### Delegation System

Admins can access customer accounts via "delegate access":

1. **Frontend Token Storage:**
   - Regular login → `localStorage.getItem("token")`
   - Delegated login → `sessionStorage.getItem("delegate_token_{customerEmail}")`
   - Use `useAuth()` to get the correct token automatically

2. **Backend Token Handling** (`middleware/auth.ts`):
   - Regular token: `req.user` = logged-in user
   - Delegated token: `req.user` = target customer (not admin!)
   - `req.delegateInfo` contains admin info if delegated

3. **Token Payload:**
   ```typescript
   // Regular token
   { userId: "admin123", email: "admin@example.com", isAdmin: true }

   // Delegated token
   {
     userId: "admin123",
     delegateAccess: {
       adminUserId: "admin123",
       adminEmail: "admin@example.com",
       targetUserId: "customer456",
       targetEmail: "customer@example.com"
     }
   }
   ```

4. **Backend Request Object:**
   ```typescript
   // After authenticateToken middleware:
   req.user = {
     userId: "customer456",        // Always the target user!
     email: "customer@example.com",
     isAdmin: false
   }
   req.delegateInfo = {             // Only present if delegated
     adminUserId: "admin123",
     adminEmail: "admin@example.com",
     isDelegated: true
   }
   ```

#### Authentication Methods

- JWT tokens for API authentication
- Google OAuth supported (configure via `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`)
- LinkedIn OAuth for social media integrations
- MFA support for sensitive operations

### WebSocket (Socket.IO)

Real-time chat functionality in `server.ts`:
- Authenticates via JWT token in socket handshake
- Handles chat messages between frontend and backend
- Streams responses from agent mode and Emma chatbot

### HTML Template Creation and Email Templates

See `docs/html-templates.md` for the full email template system docs (MCP tools, variable system, storage, implementation details).

## Agent Engine Architecture

### Main Components

- `task_monitor.py` - Main entry point, polls for tasks and schedules
- `web_agent.py` - Browser automation using browser-use library
- `email_utils.py` - Email notifications for task completion
- `task_utils.py` - Utility functions (downloads, logging, GCS uploads)
- `knowledge_base_utils.py` - Knowledge base file access
- `aws_utils.py` - AWS SDK helpers (DynamoDB, S3)

### Task Execution Flow

1. `task_monitor.py` queries DynamoDB for pending executions (status='pending')
2. Creates WebAgent instance with task prompt and credentials
3. WebAgent uses browser-use to execute automation in Playwright browser
4. Results uploaded to S3, execution status updated in DynamoDB
5. Email notifications sent to task owner and subscribers

### LLM Integration

The agent engine supports multiple LLM providers:
- **Azure OpenAI** (GPT-4o, GPT-4.1)
- **Google Gemini** (gemini-2.5-pro, gemini-2.5-flash)
- **AWS Bedrock** (Claude models)
- **Google Vertex AI** (claude-opus-4-8)
- **OpenAI** (direct API)

LLM selection is passed from backend via `aiModelConfig` in task execution record.

#### Adding a New Google Vertex AI Claude Model

Claude models on Vertex AI use a GCP service account for authentication (OAuth tokens minted at runtime).

**Setup (one-time per environment):**

1. In GCP Console, create a service account in the target project (e.g. `gen-lang-client-0725723168`) and grant it the **Agent Platform User** (`roles/aiplatform.user`) role.
2. Download the service account JSON key.
3. Store the entire JSON key file contents in AWS Secrets Manager:
   - Dev: `dev/AgentWeb/Google/Vertex`
   - Prod: `prod/AgentWeb/Google/Vertex`
   ```bash
   aws secretsmanager create-secret \
     --name dev/AgentWeb/Google/Vertex \
     --secret-string "$(cat /path/to/key.json)"
   # repeat with prod/AgentWeb/Google/Vertex for production
   ```

**To add a new model:**
1. Add an entry to `llmModels` in `backend/src/services/agentModeService.ts` using the model ID as the key (e.g. `claude-opus-4-8`). Set `supportsTemperature: false` if the model has deprecated temperature.
2. Add pricing to `modelPricing` in the same file.
3. The `getClientForModel` / `callLLM` lazy-load branch routes any key starting with `claude-` to `getVertexClient()` automatically.
4. Add registry and lazy-load tests in `backend/src/__tests__/agentModeService.sonnet45.test.ts`.

#### Adding a New AWS Bedrock Claude Model

To find the model ID and inference profile for a new Claude model on AWS Bedrock:

1. **Look up the model ID** on the [Bedrock supported models page](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html). Example: `anthropic.claude-sonnet-4-6`
2. **Look up the inference profile ID** on the [cross-region inference page](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference-support.html). Use the `global.*` prefix for cross-region access. Example: `global.anthropic.claude-sonnet-4-6`
3. **Update these files:**
   - `backend/src/services/agentModeService.ts` — add to `llmModels` registry and `inferenceProfileMap` in `getBedrockClient()`
   - `backend/src/utils/llmService.ts` — add to the inference profile `if/else` chain in the constructor
   - `backend/src/__tests__/agentModeService.sonnet45.test.ts` — add model registry, lazy-loading, and inference profile ARN tests
4. The inference profile ARN format is: `arn:aws:bedrock:us-west-2:992382574572:inference-profile/{profile_id}`
5. **Run benchmarks** to validate: `npm run benchmark -- --url http://localhost:3001 --model <model-id>` (requires local backend running with admin credentials in dev DB)

### Browser Automation

Uses browser-use library with Playwright:
- Isolated browser sessions per task
- Credentials injected only during execution
- Screenshots and activity logs captured
- Downloads stored in S3
- Cookie sync between executions (optional)

## CI/CD and Deployment

### GitHub Actions Workflows

- `.github/workflows/tests.yml` - Runs on PRs, builds and verifies compilation
  - Automatically deploys backend to staging after tests pass on PRs
  - Deploys are triggered by file changes in `backend/` or `partner-portal/`
- `.github/workflows/deploy.yml` - Deploys to production at safe times only
  - **Manual trigger:** Use GitHub Actions UI to manually trigger deployment (Actions tab → Deploy → Run workflow)
  - **Scheduled trigger:** Automatically runs daily at 2:00 AM UTC (6:00 PM PST) to deploy any merged changes
  - Detects changes via path filters and only deploys components with actual changes
  - Separate jobs for backend and partner-portal (agentweb repo) and customer portal (separate repo)
  - Version labels: `<component>-<YYYYMMDD>-scheduled` or `<component>-<YYYYMMDD>-manual`

### Deployment Targets

**Production:**
- Backend: AWS Elastic Beanstalk (Node.js platform), environment `Agentweb-backend-env-prod-3` → `https://api.agentweb.pro`
- Partner Portal: AWS Elastic Beanstalk → `https://agentweb.pro`
- Agent Engine: Google Cloud VM (manually deployed)

**Staging:**
- Backend: AWS Elastic Beanstalk, environment `Agentweb-backend-env-1` → `https://api-stage.agentweb.pro`
- Frontend: Run locally pointing to staging backend

### Triggering Production Deployments

**IMPORTANT:** Production deployments no longer trigger automatically on merge to main. This prevents disruptions during active usage times.

**Option 1: Manual Deployment (via GitHub UI)**
1. Go to the Actions tab in GitHub
2. Select "Deploy" workflow (for agentweb repo) or "Deploy to AWS Elastic Beanstalk" (for customer-portal repo)
3. Click "Run workflow"
4. Select the branch (usually `main`)
5. Click "Run workflow" button
6. The workflow will detect changes and deploy only components with actual changes

**Option 2: Scheduled Deployment (automatic)**
- Deployments automatically run daily at 2:00 AM UTC (6:00 PM PST)
- Only deploys components with changes merged since the last deployment
- Check the Actions tab to monitor deployment status

**To deploy manually via GitHub CLI:**
```bash
# For agentweb repo (backend + partner-portal)
gh workflow run deploy.yml --ref main

# For customer-portal repo
cd customer-portal
gh workflow run deploy.yml --ref main
```

### Checking Production Backend Logs

To check logs from the production backend:

```bash
# Request and retrieve tail logs (last ~100 lines per log file per instance)
aws elasticbeanstalk request-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type tail
sleep 5
aws elasticbeanstalk retrieve-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type tail

# Request and retrieve full bundle logs (complete log files as zip)
aws elasticbeanstalk request-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type bundle
sleep 15
aws elasticbeanstalk retrieve-environment-info --environment-name Agentweb-backend-env-prod-3 --info-type bundle
```

The retrieve commands return S3 URLs for each instance. Download and inspect:
- `web.stdout.log` - Node.js application logs (main process + worker)
- `nginx/access.log` - HTTP request logs
- `nginx/error.log` - Nginx error/warning logs

**Note:** EB logs rotate frequently. For investigating sessions, query DynamoDB directly (`AW-ChatSessions` table) by `sessionId` to get session state, work plan status, messages, and error fields. For scheduled sessions, also check the `runResults` field on `AW-TaskSchedules`.

### Manual Deployment (Local Builds)

**Note:** The preferred method is to use the GitHub Actions workflow (see "Triggering Production Deployments" above). Use this manual method only for emergency hotfixes or when GitHub Actions is unavailable.

**Backend:**
```bash
cd backend
npm run build
DATE=$(date +%Y%m%d) && LABEL="backend-${DATE}-manual" && mkdir -p builds && \
zip -r "builds/${LABEL}.zip" dist package.json package-lock.json .env.example .platform .ebextensions
# Upload to Elastic Beanstalk via AWS Console
```

**Partner Portal:**
```bash
cd partner-portal
VITE_API_URL=https://api.agentweb.pro \
VITE_CUSTOMER_FRONTEND_URL=https://app.agentweb.pro \
VITE_DEBUG=false \
npm run build && \
DATE=$(date +%Y%m%d) && LABEL="partner-${DATE}-manual" && mkdir -p builds && \
zip -r "builds/${LABEL}.zip" dist package.json package-lock.json
# Upload to Elastic Beanstalk via AWS Console
```

**Agent Engine:**
```bash
# SSH to Google Cloud VM
cd ~/agentweb
git pull
conda activate agent-engine
pip install -r requirements.txt
playwright install
# Restart task_monitor.py
```

## Environment Configuration

### Backend `.env`

Critical environment variables:
- `JWT_SECRET` - JWT token signing key
- `AWS_REGION` - AWS region (default: us-west-2)
- `NODE_ENV` - Environment (development/production/staging)
- `FRONTEND_URL`, `BACKEND_URL`, `CUSTOMER_FRONTEND_URL` - Cross-origin URLs
- `SMTP_*` - Email configuration
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` - Google OAuth
- `GOOGLE_IMAGE_API_KEY` - Google Veo API for image generation

Secrets stored in AWS Secrets Manager (accessed at runtime):
- `dev/AgentWeb/Google/Search` - Google Custom Search API
- `dev/AgentWeb/Google/SearchConsole` - Google Search Console service account JSON
- `dev/AgentWeb/Google/Share` - Google Drive service account JSON for shared folders
- `dev/AgentWeb/Google/Vertex` - GCP service account JSON for Vertex AI Claude models (e.g. claude-opus-4-8)
- `prod/AgentWeb/Google/Vertex` - GCP service account JSON for Vertex AI Claude models (production)
- `prod/AgentWeb/Google/PageSpeed` - PageSpeed Insights API key
- `dev/AgentWeb/BaseHub` - BaseHub CMS credentials
- `dev/AgentWeb/Webflow` or `dev/AgentWeb/Webflow/<userId>` - Webflow CMS credentials
- `dev/AgentWeb/LinkedIn/Personal` - LinkedIn personal profile credentials
- `dev/AgentWeb/LinkedIn/Company` - LinkedIn company page credentials

### Frontend `.env` (Build Time)

Partner portal uses Vite environment variables (replaced at build time):
- `VITE_API_URL` - Backend API URL
- `VITE_CUSTOMER_FRONTEND_URL` - Customer portal URL
- `VITE_DEBUG` - Enable debug logging
- `VITE_LIST_FULL_LLM_NAMES` - Comma-separated list of available LLM models

Runtime environment variables in Elastic Beanstalk do NOT affect the frontend.

## Important Patterns and Conventions

### Build & Deploy Naming

- Build artifacts and EB version labels use the format `<component>-yyyymmdd-pr<number>` (e.g., `backend-20260218-pr42`, `partner-20260218-pr42`)
- The PR number is extracted from the merge commit message; falls back to the short commit SHA if unavailable
- Deployments are triggered automatically by file changes in `backend/` or `partner-portal/` — no manual version bump is needed
- `package.json` versions in backend, partner-portal, and customer-portal are independent but are **not** used for deployment gating

### DynamoDB Query Optimization

Use GSI queries instead of scans:
```typescript
// Good: Query with GSI
const result = await dynamodb.query({
  TableName: 'AW-TaskExecutions',
  IndexName: 'StatusStartTimeIndex',
  KeyConditionExpression: '#status = :status AND #startTime <= :now',
  ExpressionAttributeNames: {
    '#status': 'status',
    '#startTime': 'startTime'
  },
  ExpressionAttributeValues: {
    ':status': 'pending',
    ':now': new Date().toISOString()
  }
}).promise();

// Bad: Scan entire table
const result = await dynamodb.scan({
  TableName: 'AW-TaskExecutions',
  FilterExpression: '#status = :status',
  // ...
}).promise();
```

### Error Handling in Agent Engine

Always handle errors gracefully and update execution status:
```python
try:
    # Execute task
    result = await agent.run(task_prompt)
    # Update status to completed
    dynamodb.update_item(...)
except Exception as e:
    # Log error and update status to failed
    logger.error(f"Task failed: {str(e)}")
    dynamodb.update_item(
        Key={'executionId': execution_id},
        UpdateExpression='SET #status = :failed, #error = :error',
        ExpressionAttributeValues={
            ':failed': 'failed',
            ':error': str(e)
        }
    )
```

### Streaming Responses

Agent mode uses streaming for real-time responses:
```typescript
// Backend streams via Socket.IO
socket.emit('agent-response-chunk', { chunk: text });

// Frontend accumulates chunks
socket.on('agent-response-chunk', (data) => {
  setResponse(prev => prev + data.chunk);
});
```

## Pre-Commit Checks

**REQUIRED:** Before committing any changes, always run these checks:

### Backend

```bash
cd backend

# 1. Verify TypeScript compilation (catches type errors)
#    Use `npm run typecheck` — it runs `tsc --noEmit` with a raised heap
#    (--max-old-space-size=6144). A full backend type-check peaks near node's
#    default ~4GB heap ceiling, so plain `npx tsc` can OOM when memory is tight.
npm run typecheck

# 2. Run tests
npm test
```

**Run the checks SEQUENTIALLY, never backgrounded together.** A full type-check
and the jest workers are each memory-heavy Node processes; running them
concurrently can exhaust the heap and OOM-crash one of them. Also never read a
piped command's exit status as the tool's result (e.g. `tsc | head` reports
`head`'s exit code, masking a tsc OOM) — run it unpiped or check `${PIPESTATUS[0]}`.

### Customer Portal

```bash
cd customer-portal

# Run tests
npm test
```

These checks prevent CI failures and ensure code quality. The `npx tsc` command is especially important as it catches TypeScript type errors that may not be caught during development with hot reload.

**CRITICAL:** Run `npm run typecheck` after **every** edit to any `.ts` file in the backend, including test files (`__tests__/*.test.ts`). Do not wait until all edits are done — verify compilation after each file change.

## Commit Granularity

**Each commit should cover one logical change.** Separate commits for different types of work so the git history is clear and reviewable:

- A bug fix is its own commit
- A new feature is its own commit
- Unit tests are their own commit
- User release notes updates are their own commit
- Documentation changes (dev.md, CLAUDE.md) are their own commit

For example, a PR that fixes a bug and adds a feature should have at minimum: one commit for the bug fix, one for the feature, one for tests, one for release notes, and one for any dev.md investigation notes — not a single commit bundling everything together.

## Merging Pull Requests

**NEVER use `--delete-branch` when merging PRs.** Always keep remote branches after merge. Use `gh pr merge <number> --merge` without the `--delete-branch` flag.

## Testing Strategy

### Backend Tests

Located in `backend/src/__tests__/`:
- Unit tests for services and utilities
- Integration tests for API endpoints
- Mocking AWS services with Jest

**Note:** Tests are NOT run in CI to reduce complexity. Run tests locally before submitting PRs.

```bash
cd backend
npm test                  # Run all tests
npm run test:watch        # Watch mode
npm run test:coverage     # With coverage
```

### Agent Engine Tests

Located in `agent-engine/tests/`:
- Browser-use integration tests
- Task monitor tests
- Content validation tests
- AI model integration tests (require API keys)

```bash
cd agent-engine
conda activate agent-engine
python run_tests.py       # Run all tests
python -m unittest tests.test_task_monitor -v  # Specific test
```

## Common Troubleshooting

See `docs/troubleshooting.md` for backend and agent engine troubleshooting guides.

## Reproducing Production Issues in Dev

See `docs/debug-production.md` for steps to copy prod sessions to dev and test locally.

## Key Files to Review

When making changes, these files are critical to understand:

1. **Backend:**
   - `src/services/db.ts` - All DynamoDB operations
   - `src/services/agentModeService.ts` - Agent mode chat logic
   - `src/server.ts` - Express app setup and Socket.IO
   - `src/app.ts` - Route registration and middleware

2. **Agent Engine:**
   - `task_monitor.py` - Main orchestration loop
   - `web_agent.py` - Browser automation implementation
   - `task_utils.py` - Shared utilities

3. **Documentation:**
   - `README.md` - Setup and features
   - `dev.md` - Known issues, troubleshooting, database operations
   - `design.md` - System architecture and security model

## Additional Notes

- The backend uses TypeScript with Express.js
- The agent engine uses Python 3 with asyncio
- DynamoDB is the primary database (NoSQL)
- S3 is used for file storage (activity logs, downloads, images)
- Google Cloud Storage is used for knowledge base files
- Real-time features use Socket.IO for WebSocket connections
- Email notifications use both SMTP and Resend API
- Slack integration for GTM plan approvals via webhooks

## Test Accounts

For manual testing on test/staging environments:

### Admin/Full Access Account
- **Email:** `test@example.com`
- **Password:** `Test123!`

### Basic Subscription Account (DIY Users)
- **Email:** `test1@example.com`
- **Password:** `Test123!`
- **Subscription:** Basic (default for DIY users)
- **Purpose:** Test features available to users with Basic subscription

## Cloud Test Environment

Ephemeral EC2 test environments for manual testing. See `docs/cloud-test-env.md` for full setup, usage commands, and architecture.

**CRITICAL:** When a test environment is active, run `./test-env/test-env.sh sync` after EVERY code change.

### SSH into Cloud Claude Instances

You can SSH into cloud Claude (cloud-dev) EC2 instances using password authentication. The SSH password is stored in AWS Secrets Manager:

```bash
# Retrieve the SSH password
aws secretsmanager get-secret-value --secret-id agentweb/test-env/ssh-password --query SecretString --output text

# SSH into the instance (use the Public IP from the Notion task's "Public IP" field)
# IMPORTANT: use ec2-user, NOT ubuntu — the AMI is Amazon Linux, not Ubuntu
ssh ec2-user@<PUBLIC_IP>
# Enter the password from Secrets Manager when prompted

# Or use sshpass for non-interactive:
SSHPASS=$(aws secretsmanager get-secret-value --secret-id agentweb/test-env/ssh-password --query SecretString --output text) \
  sshpass -e ssh -o StrictHostKeyChecking=no -o PasswordAuthentication=yes -o PubkeyAuthentication=no ec2-user@<PUBLIC_IP> 'uptime'
```

**Note:** After a stop/start cycle the public IP changes — always fetch the current IP from the Notion task or via `aws ec2 describe-instances`. If the instance was stopped and restarted, the Claude tmux session won't auto-restart; SSH in and run:
```bash
tmux new-session -d -s claude /home/ec2-user/agentweb/.claude-run.sh
```

## Browser Testing with Playwright MCP

A Playwright MCP server is configured via `.mcp.json` in each repo root. Use the `mcp__playwright__browser_*` tools to drive a real browser against the cloud test environment for manual verification (login, delegation, UI interactions). If the tools are not available, restart the Claude Code session to reload MCP servers.

## Notion Integration (Sprint Tasks)

Notion MCP configured via `.mcp.json`. See `docs/notion-integration.md` for database IDs, query examples, and auto-setup instructions.

## "Prep Branch for \<topic\>" Command

When the user says **"prep branch for \<topic\>"**:

1. Convert `<topic>` to a branch name: `rui/<topic>` (lowercase, spaces replaced with hyphens)
2. **This repo (agentweb):**
   - `git fetch origin main`
   - `git checkout -b rui/<topic> origin/main`
3. **Customer portal (separate repo at `customer-portal/`):**
   - `git -C customer-portal fetch origin main`
   - `git -C customer-portal checkout -b rui/<topic> origin/main`
4. Confirm both branches are created and ready for development

## "Prep for Deploy" Command

When the user says **"prep for deploy \<date\>"** (default: today's date if omitted):

1. Add release notes entries for the date, following existing format in each file:
   - **Backend changes:** `backend/src/docs/user-release.ts`
   - **Partner portal changes:** `partner-portal/src/docs/release.ts`
2. For each of `backend/`, `partner-portal/`, `customer-portal/` with code changes: 
   - **Backend:** Run `npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary` to verify coverage ≥95% on all metrics
   - **Backend:** Run `npx tsc` to verify TypeScript compilation
   - **Frontend:** Run `npm test` for unit tests
   - Fix any failing tests before proceeding
   - **CI requires ≥95% coverage on statements, branches, functions, and lines.** Ensure new code branches are covered by tests.
3. Commit changes and create PRs for **both** repos:
   - **This repo** (backend + partner-portal) — commit, push, and create a PR via `gh pr create`
   - **Customer portal** (separate repo at `customer-portal/`) — if there are changes, commit using `git -C customer-portal` commands, push, and create a PR
4. Return both PR URLs to the user

