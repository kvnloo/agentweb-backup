# Architecture Knowledge

## System Overview
Multi-tenant web automation platform: Frontend -> Backend API (Express) -> DynamoDB -> Task Queue -> Agent Engine (Python) -> Browser Automation

## Three Frontends
1. **Partner Portal** (`partner-portal/`, :5173) - Admin-only: user management, system config, admin dashboards
2. **Customer Portal** (`customer-portal/`, :5174) - All user-facing: tasks, chat, marketing hub, social posts, settings
3. **Growth Genius Chat** - Separate repo

## Backend Services (by importance)
| Service | File | Role |
|---------|------|------|
| Agent Mode | `agentModeService.ts` (473KB) | Primary agent chat with streaming + function calls |
| Database | `db.ts` (125KB) | All DynamoDB CRUD for every table |
| Emma Chatbot | `chatbotService.ts` (76KB) | In-app assistant (secondary to agent mode) |
| Email | `emailService.ts` (58KB) | SMTP + Resend API |
| Image Gen | `imageGeneration.ts` (38KB) | Google Veo, Runway |
| LinkedIn | `linkedInService.ts` | Personal + company profile integration |
| GTM Notify | `gtmPlanNotificationService.ts` | GTM plan approval via Slack |

## Route Organization (`backend/src/routes/`)
auth, tasks, agentMode, chatbot, admin, schedules, workflows, gtmPlan, seo, crm, blog, connectedAccounts, linkedinAuth, slack

## DynamoDB Tables (prod prefix: `AW-`, dev prefix: `Dev-`)
| Table | Key GSIs | Purpose |
|-------|----------|---------|
| AW-Users | - | User accounts + auth |
| AW-Tasks | - | Task definitions |
| AW-TaskExecutions | StatusStartTimeIndex, UserIdIndex | Execution records |
| AW-TaskSchedules | StatusStartTimeIndex, UserIdIndex | Recurring schedules |
| AW-ChatSessions | AdminUpdatedAtIndex | Agent mode sessions |
| AW-Configs | - | User website configs + API integrations |
| AW-EmailEvents | EmailDomainLeadEmailIndex | Email tracking |
| AW-Subscribers | - | Task email subscribers |

## Agent Engine (Python)
- `task_monitor.py` - polls DynamoDB for pending tasks
- `web_agent.py` - browser-use + Playwright automation
- `task_utils.py` - downloads, logging, GCS uploads
- `knowledge_base_utils.py` - knowledge base file access
- `aws_utils.py` - AWS SDK helpers

## LLM Providers
- Azure OpenAI (GPT-4o, GPT-4.1)
- Google Gemini (gemini-2.5-pro, gemini-2.5-flash)
- AWS Bedrock (Claude models) - inference profile ARN: `arn:aws:bedrock:us-west-2:992382574572:inference-profile/{profile_id}`
- OpenAI (direct)

### Adding New Bedrock Claude Model
1. Look up model ID on Bedrock supported models page
2. Look up inference profile ID (use `global.*` prefix for cross-region)
3. Update: `agentModeService.ts` (llmModels + inferenceProfileMap), `utils/llmService.ts` (inference profile chain), tests
4. Run benchmarks: `npm run benchmark -- --url http://localhost:3001 --model <model-id>`

## Tool Wiring Chain (critical path)
`apiTools.ts` -> `mcpToolRegistry` -> bridge in `emma/tools.ts` -> `emmaToolRegistry` -> `agentModeService.toolRegistry`

## Real-time: Socket.IO
- JWT auth in handshake
- `agent-response-chunk` events for streaming
- Frontend accumulates chunks

## Storage
- S3: activity logs, downloads, images
- GCS: knowledge base files
- DynamoDB: all application data
- Secrets Manager: API keys (Google, BaseHub, Webflow, LinkedIn)

## CI/CD
- `.github/workflows/tests.yml` - PR tests + auto-deploy to staging
- `.github/workflows/deploy.yml` - production deploy (daily 7AM UTC or manual)
- Backend + Partner Portal: AWS Elastic Beanstalk
- Customer Portal: separate repo, separate EB deploy
- Agent Engine: Google Cloud VM (manual deploy)
