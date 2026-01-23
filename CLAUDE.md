# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Core Architecture

AgentWeb is a multi-tenant web automation platform with three main components:

1. **Backend (Node.js/TypeScript)** - Express API server with Socket.IO for real-time chat
2. **Agent Engine (Python)** - Browser automation engine using browser-use library and playwright
3. **Frontend Applications (React/TypeScript)**:
   - Partner Portal (admin/partner interface) - in this repo at `partner-portal/`
   - Customer Portal (end-user interface) - separate repo
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

### Backend

```bash
cd backend

# Development (with hot reload)
npm run dev

# Build TypeScript
npm run build

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
- **OpenAI** (direct API)

LLM selection is passed from backend via `aiModelConfig` in task execution record.

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
  - Version check: PR version must be >= base branch version
  - Automatically deploys backend to staging after tests pass on PRs
- `.github/workflows/deploy.yml` - Deploys to production on merge to main
  - Version check: Only deploys if version strictly higher than previous commit
  - Separate jobs for backend and partner-portal

### Deployment Targets

**Production:**
- Backend: AWS Elastic Beanstalk (Node.js platform) → `https://api.agentweb.pro`
- Partner Portal: AWS Elastic Beanstalk → `https://agentweb.pro`
- Agent Engine: Google Cloud VM (manually deployed)

**Staging:**
- Backend: AWS Elastic Beanstalk → `https://api-stage.agentweb.pro`
- Frontend: Run locally pointing to staging backend

### Manual Deployment

**Backend:**
```bash
cd backend
npm run build
VERSION="X.Y" && mkdir -p builds && \
zip -r "builds/deploy_v${VERSION}.zip" dist package.json package-lock.json .env.example .platform .ebextensions
# Upload to Elastic Beanstalk via AWS Console
```

**Partner Portal:**
```bash
cd partner-portal
VITE_API_URL=https://api.agentweb.pro \
VITE_CUSTOMER_FRONTEND_URL=https://app.agentweb.pro \
VITE_DEBUG=false \
npm run build && \
VERSION="X.Y" && mkdir -p builds && \
zip -r "builds/deploy_v${VERSION}.zip" dist package.json package-lock.json
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

### Version Management

- Backend and partner-portal have independent versioning in their `package.json`
- Always bump version before merging to main for production deployment
- Version format: `X.Y.Z` (semantic versioning)
- No version bump needed for staging deployments (PRs)

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

### Backend Issues

**Port 3001 already in use:**
```bash
lsof -ti:3001 | xargs kill -9
```

**Google OAuth redirect errors:**
- Check Google Cloud Console redirect URIs match exactly
- Verify `BACKEND_URL` environment variable
- For dev: `http://localhost:3001/api/auth/google/callback`
- For prod: `https://api.agentweb.pro/api/auth/google/callback`

**DynamoDB index missing errors:**
- Check if GSI exists: `aws dynamodb describe-table --table-name Dev-AW-TaskExecutions --region us-west-2`
- Create missing index using AWS CLI commands in `dev.md`

### Agent Engine Issues

**Memory system database errors (Azure OpenAI models):**
```bash
cd agent-engine
python memory_fix_v2.py
```

**Browser initialization failures:**
```bash
# Check VNC server (on Google Cloud VM)
ps aux | grep vnc
export DISPLAY=:1
vncserver -kill :1
tigervncserver :1 -geometry 1920x1080 -depth 24
```

**Module import errors:**
```bash
conda activate agent-engine
pip install -r requirements.txt
playwright install chromium
```

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
