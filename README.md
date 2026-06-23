# AgentWeb

AgentWeb is a powerful web automation platform that allows users to create and manage web-based tasks using natural language instructions. It provides secure credential management and executes tasks in isolated environments, making it ideal for automating recurring web operations while maintaining security.

## Features

- 🤖 Natural language task creation
- 🔒 Zero credential storage - credentials required per task execution
- 🌐 Isolated browser sessions for each task
- ⏱️ Support for both single and recurring tasks
- 📊 Real-time task monitoring and alerts
- 🔐 MFA for AgentWeb account security
- 🔌 API Integration support - connect with external APIs
- 👥 Admin dashboard for user management and analytics
  - User overview and management
  - Waitlist management with email invitations
  - Task analytics and monitoring
  - Tasks management with detailed view
    - View all tasks with task ID, name, prompt, and owner
    - Track task creation dates
    - Direct links to task details pages
    - Monitor task status and progress

## Prerequisites

- Node.js (v16 or higher)
- Docker
- AWS Account
- browser-use library

## Installation

1. Clone the repository:

```bash
git clone https://github.com/yourusername/agentweb.git
cd agentweb
```

2. Install dependencies:

```bash
npm install
```

3. Configure environment variables:

```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Migrate passwords (if upgrading from an older version):

```bash
# For development - process 1 record at a time (default)
NODE_ENV=development npx ts-node src/scripts/encrypt-passwords.ts

# For development - process multiple records
NODE_ENV=development npx ts-node src/scripts/encrypt-passwords.ts 5

# For production - process 1 record at a time (default)
NODE_ENV=production npx ts-node src/scripts/encrypt-passwords.ts

# For production - process multiple records
NODE_ENV=production npx ts-node src/scripts/encrypt-passwords.ts 5
```

Note: The password migration script processes records one at a time by default for safety. You can specify a number to process more records at once. It's recommended to start with the default (1) to verify the migration works correctly before processing more records.

4. Start the development server:

```bash
npm run dev
```

## Usage

1. Create a new task using natural language
2. Input target website credentials when executing the task
3. Monitor task execution and results
4. Set up alerts for task completion or failures

## Agent Mode: Skills vs Work Plans

Agent Mode has two places to encode process knowledge: **Skills** (via `systemPrompt` and tool bundles) and **Work Plans** (via predefined step sequences). The key question is: *is the knowledge about how to use tools, or about what steps to follow?*

### Put process knowledge in a Skill when:

- **The knowledge is about tool usage** — how to call tools correctly, what parameters matter, domain-specific constraints. Example: "When creating Meta ad campaigns, always set the objective before configuring the audience" belongs in the Meta Ads skill's `systemPrompt`.
- **It applies across many workflows** — if the same guidance is relevant no matter what the user's specific goal is, it belongs in the skill. Example: "LinkedIn posts perform best under 1300 characters" applies whether the user is doing a one-off post or running a full content campaign.
- **It's about context the AI needs to use tools well** — API quirks, field mappings, validation rules, recommended defaults. This lives in the skill so it's available any time those tools are loaded.

### Put process knowledge in a Work Plan when:

- **The knowledge is a specific sequence of steps** — a defined workflow where order matters and steps build on each other. Example: "Client onboarding" = analyze website → create brand guidelines → build marketing strategy → generate content.
- **Steps have validation gates** — use `requiredFunctionCalls` to enforce that specific tools are called before a step can be marked complete. Example: step "Create brand guidelines" requires `update_brand_guidelines` to actually be called.
- **Progress tracking matters** — the user needs to see where they are, pause, and resume later. Work plans persist in the session and show status per step.
- **The workflow is goal-specific** — unlike skill knowledge (always relevant when tools are loaded), a work plan is tied to one specific outcome the user is trying to achieve.

### Decision rule

If you can express the knowledge as *"when using tool X, always/never do Y"*, put it in the **skill's `systemPrompt`**. If you can express it as *"to achieve goal X, do steps A → B → C in order"*, put it in a **predefined work plan**.

They often work together: a skill provides the tools and usage guidance, and a work plan orchestrates those tools into a specific workflow.

## Audit Report PDF

To convert the security audit markdown to PDF, use `pandoc`:

```bash
pandoc audits/security-audit-2026-01-30.md -o audits/security-audit-2026-01-30.pdf
```

### API Integrations

AgentWeb supports integrating with external APIs by securely storing API credentials:

1. Navigate to the Configurations page
2. Click "Add API Config"
3. Enter the API details:
   - API/App Name: A unique identifier for this API (e.g., "Stripe", "GitHub")
   - API Key Name: The name of the credential parameter (e.g., "api_key", "access_token")
   - API Key/Secret: The actual API credential value
   - Documentation URL: Optional link to integration documentation

When creating tasks, your agents can access these API integrations with:

- `get_integration_instructions`: Retrieves the API configuration details including documentation links
- `run_integration`: Executes Python code with the API credentials automatically injected

Example task prompt that uses an API integration:

```
Get my latest GitHub repositories and create a report. Use my GitHub API integration to access the data.
```

### Knowledge Base Functions

In Agent Mode, Emma can access knowledge base files using the following function calls:

- `list_knowledge_base_files`: Provides a list of all available knowledge base files to Emma, including file names, unique references, and metadata
- `read_knowledge_base_file`: Reads a knowledge base file based on a unique reference identifier, returning the full content of the file

Example usage in Agent Mode:

```
List all available knowledge base files and then read the file about product specifications.
```

### Google Drive Integration

AgentWeb supports accessing Google Drive files as part of the knowledge base. The platform integrates with the Google Drive API directly using a service account.

**Step 1: Enable the Google Drive API**

1. Go to the [Google Cloud Console API Library](https://console.cloud.google.com/apis/library)
2. Select the **knowledge-base** project from the project dropdown at the top
3. Search for "Google Drive API" and click on it
4. Click **Enable** (if not already enabled)

**Step 2: Create a service account**

1. Go to [IAM & Admin > Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts) and select the **knowledge-base** project
2. Click **+ Create Service Account**
3. Enter the name `agentweb-dev` (development) or `agentweb-prod` (production) and click **Create and Continue**
4. Skip the optional role grants and click **Done**
5. The service account emails will be:
   - Dev: `agentweb-dev@knowledge-base.iam.gserviceaccount.com`
   - Prod: `agentweb-prod@knowledge-base.iam.gserviceaccount.com`

**Note:** If key creation is blocked with the error "Google automatically disables service account keys detected in public repositories", you need to disable the org policy first:

1. Go to [IAM & Admin > Organization Policies](https://console.cloud.google.com/iam-admin/orgpolicies) and select the **knowledge-base** project
2. Search for `iam.disableServiceAccountKeyCreation`
3. Click on the policy, then click **Manage Policy**
4. Set the policy source to **Override parent's policy**
5. Under **Rules**, click **Add Rule**, set **Enforcement** to **Off**
6. Click **Done**, then **Set Policy**

Then return to the service account's **Keys** tab and create the key:

6. Click **Add Key > Create new key > JSON** and download the key file
7. Store the key JSON in AWS Secrets Manager:
   - Dev: `dev/AgentWeb/Google/Share`
   - Prod: `prod/AgentWeb/Google/Share`

**Step 3: Share Google Drive folders with the service account**

1. Open [Google Drive](https://drive.google.com) in your browser
2. Right-click the folder you want to share and select **Share**
3. Paste the service account email (`agentweb-dev@knowledge-base.iam.gserviceaccount.com` or `agentweb-prod@knowledge-base.iam.gserviceaccount.com`) and grant **Viewer** access (or **Editor** if write access is needed)
4. Copy the folder ID from the URL — it's the string after `/folders/` (e.g., in `https://drive.google.com/drive/folders/1ABC2DEF3GHI`, the folder ID is `1ABC2DEF3GHI`)

**Step 4: Configure shared folders in the Admin Dashboard**

1. Go to the Admin Dashboard > **Users** tab
2. Find the target customer and click the edit icon on the **Shared Folders** column
3. Enter each folder's ID (from Step 3) and a display name (e.g., "Marketing Assets")
4. Click **Save**

Customers can then view their configured shared folders on the Knowledge Base page, with direct links to open each folder in Google Drive.

> **Note:** Google's official MCP server list is at https://github.com/Google/mcp. The [Google Workspace MCP server](https://github.com/gemini-cli-extensions/workspace) was evaluated but requires interactive OAuth browser login (incompatible with service account / headless agent engine). It may be adopted in the future when per-user OAuth MCP sessions are supported. See `dev.md` for details.

### Social Media Functions

In Agent Mode, Emma can create social media posts using the following function call:

- `create_social_media_posts`: Creates a list of social media posts and generates an HTML file containing all posts. Each post includes:
  - **Type**: The social media platform type (`linkedin`, `x/twitter`, `instagram`, `facebook`, or `custom`)
  - **Content**: Rich text content that can be transformed to HTML for display and copied for use
  - **Image URL**: Optional image URL for posts that include images
  - The output is an HTML file stored in S3 with all the posts formatted for easy viewing and copying

Example usage in Agent Mode:

```
Create 5 LinkedIn posts about our new product launch, each with different angles and include relevant images.
```

For detailed documentation, please refer to our [Design Document](./design.md).

## Security

AgentWeb implements a strict security model:

- Zero permanent storage of target website credentials
- Fresh credential input required for each task execution
- Isolated browser sessions for each task
- MFA-protected AgentWeb accounts
- No correlation between AgentWeb accounts and target website credentials
- Automatic session cleanup after task completion
- Secure API credential management with isolated execution environments

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For support, please open an issue in the GitHub repository or contact the maintainers.

## Roadmap

See our [Design Document](./design.md) for detailed development roadmap and future considerations.

## Setup

### Prerequisites

- Node.js (v18 or later)
- AWS Account with DynamoDB access

### Backend Setup

1. Install dependencies:

```bash
cd backend
npm install
```

2. Configure environment variables:

- Create a `.env` file in the `backend` directory:

```
PORT=3001
JWT_SECRET=your_jwt_secret
AWS_REGION=your_aws_region
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
SMTP_HOST=your_smtp_host
SMTP_PORT=your_smtp_port
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
FROM_EMAIL=your_from_email
ADMIN_EMAIL=your_admin_email
ADMIN_PASSWORD=your_admin_password
GCS_BUCKET_NAME=agentweb-knowledge-base-dev
GCS_BUCKET_NAME_PRIVATE=agentweb-knowledge-base-private-dev
GCS_PROJECT_ID=your_gcs_project_id
GCS_CLIENT_EMAIL=your_gcs_client_email
GCS_PRIVATE_KEY=your_gcs_private_key
```

3. Create DynamoDB tables:

```bash
cd backend
npm run build
npx ts-node src/scripts/create-tables.ts
```

This will create all required tables in DynamoDB. Table names will be prefixed with "Dev-" in development environment and no prefix in production:

Development Environment:

- Dev-AW-Users: User accounts
- Dev-AW-Tasks: Task definitions
- Dev-AW-TaskExecutions: Task execution records
- Dev-AW-Waitlist: Waitlist entries
- Dev-AW-Subscribers: Task subscribers
- Dev-AW-TaskSchedules: Task schedules
- Dev-AW-Configs: User website configurations

Production Environment:

- AW-Users: User accounts
- AW-Tasks: Task definitions
- AW-TaskExecutions: Task execution records
- AW-Waitlist: Waitlist entries
- AW-Subscribers: Task subscribers
- AW-TaskSchedules: Task schedules
- AW-Configs: User website configurations

The environment is determined by the NODE_ENV environment variable:

```bash
# For development tables (with "Dev-" prefix)
NODE_ENV=development npx ts-node src/scripts/create-tables.ts

# For production tables (no prefix)
NODE_ENV=production npx ts-node src/scripts/create-tables.ts
# or simply
npx ts-node src/scripts/create-tables.ts
```

4. Start the backend server:

```bash
npm run dev
```

5. (Optional) Expose backend for Slack integration:

```bash
# In a new terminal, expose the backend to the internet for Slack webhooks
ngrok http 3001
```

This creates a public URL that Slack can use to send approval button interactions to your local backend. Then configure it in https://api.slack.com/apps for Emma dev.

**Additional Slack Configuration** - Configure Event Subscriptions in your Slack app (https://api.slack.com/apps):
- **Event Subscriptions** → Enable Events
- **Request URL**: `https://your-backend-url.com/api/slack/events` (e.g., `https://abc123.ngrok.io/api/slack/events` for local dev)
- **Subscribe to bot events** → Add `app_mention`
- Set `SLACK_BOT_TOKEN` in your `.env` file

### Frontend Setup for Development

**Note**: The frontend applications are now separate repositories:

- **Partner Portal**: [AgentWeb Partner Portal](https://github.com/AgentWebPro/agentweb-partner-portal) (if separate)
- **Customer Portal**: [AgentWeb Customer Portal](https://github.com/AgentWebPro/agentweb-customer-portal)
- **Growth Genius Chat**: [Growth Genius Chat](https://github.com/AgentWebPro/growth-genius-chat)

For development setup, please refer to the individual repository README files.

#### Partner Portal Development (if still in this repo)

1. Install dependencies:

```bash
cd partner-portal
npm install
```

2. Start the development server:

**Option A: Local development with local backend** (default):
```bash
npm run dev
```
This will use `http://localhost:3001` as the API URL (if backend is running locally).

**Option B: Local development with staging backend** (recommended for testing):
```bash
VITE_API_URL=https://api-stage.agentweb.pro VITE_CUSTOMER_FRONTEND_URL=http://localhost:5174 VITE_DEBUG=true npm run dev
```

The frontend development server will be available at:

- Local access: http://localhost:5173
- Network access: http://[your-ip-address]:5173

**Note**: When using staging backend, your local partner portal will connect to `https://api-stage.agentweb.pro` for API calls. This is useful for testing frontend changes against the staging backend without deploying the frontend.

### Admin Setup

1. Configure admin credentials in backend `.env`:

```
ADMIN_EMAIL=your_admin_email
ADMIN_PASSWORD=your_admin_password
```

2. Create admin account:

```bash
cd backend
npm run create-admin
```

3. Access admin dashboard:

- Log in with your admin credentials
- Navigate to /admin in the application
- Features available:
  - User management
  - Waitlist management with email invitations
  - Task analytics
  - System performance monitoring
  - Tasks overview
    - View comprehensive task list with details
    - Access task information: ID, name, prompt, owner
    - Click on task IDs to view detailed task pages (/tasks/{taskId})
    - Monitor task creation and execution history

## Development

### Project Structure

```
.
├── backend/             # Backend API and services
│   ├── src/
│   │   ├── routes/      # API routes
│   │   ├── services/    # Database and business logic
│   │   └── utils/       # Utility functions
│   └── scripts/         # Database setup scripts
├── agent-engine/        # Agent execution engine
├── partner-portal/      # Partner portal frontend (if still in this repo)
└── misc/               # Documentation and assets
```

**Note**: Frontend applications are now separate repositories:
- [AgentWeb Customer Portal](https://github.com/AgentWebPro/agentweb-customer-portal)
- [Growth Genius Chat](https://github.com/AgentWebPro/growth-genius-chat)

### Running Backend with Log File (Recommended for Debugging)

When running the backend during development, it's recommended to redirect output to a log file. This allows AI agents (like Claude Code) to easily access and analyze logs for debugging.

**Start backend with log redirection:**
```bash
cd backend
npm run dev > /tmp/backend.log 2>&1
```

This command:
- Redirects both stdout and stderr to `/tmp/backend.log`
- Allows easy log access for debugging: `tail -f /tmp/backend.log`
- Enables AI agents to read logs using: `Read tool with file_path="/tmp/backend.log"`

**Alternative: Background with log file:**
```bash
cd backend
nohup npm run dev > /tmp/backend.log 2>&1 &
echo $! > /tmp/backend.pid

# To stop later:
kill $(cat /tmp/backend.pid)
```

**Monitoring logs in real-time:**
```bash
# Watch latest logs
tail -f /tmp/backend.log

# Search for errors
grep -i "error" /tmp/backend.log

# View last 100 lines
tail -100 /tmp/backend.log
```

### Environment Variables

Backend:

- Create a `.env` file in the `backend` directory:

```
PORT=3001
JWT_SECRET=your_jwt_secret
AWS_REGION=your_aws_region
FRONTEND_URL=https://agentweb.pro
BACKEND_URL=https://api.agentweb.pro
SITE_DOMAIN=https://agentweb.pro
CUSTOMER_FRONTEND_URL=https://customer.agentweb.pro
GROWTH_GENIUS_CHAT_URL=https://genius.agentweb.pro
SMTP_HOST=your_smtp_host
SMTP_PORT=your_smtp_port
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
FROM_EMAIL=your_from_email
ADMIN_EMAIL=your_admin_email
ADMIN_PASSWORD=your_admin_password
GOOGLE_VEO_API_KEY=your_google_veo_api_key
RUNWAY_API_KEY=your_runway_api_key
REELMIND_API_KEY=your_reelmind_api_key
GCS_BUCKET_NAME=agentweb-knowledge-base-dev
GCS_BUCKET_NAME_PRIVATE=agentweb-knowledge-base-private-dev
GCS_PROJECT_ID=your_gcs_project_id
GCS_CLIENT_EMAIL=your_gcs_client_email
GCS_PRIVATE_KEY=your_gcs_private_key
```

Frontend Production:

- Create a `.env` file in the `partner-portal` directory:

```
VITE_API_URL=https://agentweb.pro
```

### Google OAuth Configuration

To enable Google OAuth authentication, you need to configure both the backend environment variables and the Google OAuth app settings. Note the current account is under ruiwangwarm@gmail.com account, not ruiw@agentweb.pro. (TODO: migrate)

#### Backend Environment Variables

Add these variables to your backend `.env` file:

```env
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
```

#### Google OAuth App Configuration

1. **Go to Google Cloud Console**:
   - Visit [Google Cloud Console](https://console.cloud.google.com/)
   - Select your project or create a new one

2. **Enable Google+ API**:
   - Go to "APIs & Services" > "Library"
   - Search for "Google+ API" and enable it

3. **Create OAuth 2.0 Credentials**:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth 2.0 Client IDs"
   - Choose "Web application"

4. **Configure Authorized Redirect URIs**:
   
   **For Production:**
   ```
   https://api.agentweb.pro/api/auth/google/callback
   ```
   
   **For Staging:**
   ```
   https://api-stage.agentweb.pro/api/auth/google/callback
   ```
   
   **For Development:**
   ```
   http://localhost:3001/api/auth/google/callback
   ```

5. **Copy Credentials**:
   - Copy the Client ID and Client Secret
   - Add them to your backend `.env` file

#### Troubleshooting OAuth Issues

If you encounter redirect URL errors:

1. **Check Google Console**: Ensure the redirect URI matches exactly
2. **Verify Environment Variables**: Make sure `BACKEND_URL` is set correctly
3. **Check Backend Logs**: Look for OAuth-related errors in the backend logs
4. **Test with Different Environments**: Try with localhost first, then staging, then production

The backend includes a fallback handler for malformed OAuth URLs, but the proper fix is to configure the correct redirect URI in Google Console.

### Google Custom Search API Configuration

To enable web search functionality in Agent Mode, you need to set up Google Custom Search API.

#### 1. Create a Google Cloud Project

1. **Go to Google Cloud Console**:
   - Visit [Google Cloud Console](https://console.cloud.google.com/)
   - Select your existing project or create a new one

2. **Enable Custom Search API**:
   - Go to "APIs & Services" > "Library"
   - Search for "Custom Search API" and enable it

#### 2. Create API Credentials

1. **Go to Credentials**:
   - Navigate to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "API Key"

2. **Restrict the API Key** (Recommended):
   - Click on the created API key
   - Under "API restrictions", select "Restrict key"
   - Choose "Custom Search API" from the list
   - Click "Save"

#### 3. Create a Custom Search Engine

1. **Go to Custom Search Engine**:
   - Visit [Google Custom Search Engine](https://cse.google.com/cse/)
   - Click "Add" to create a new search engine

2. **Configure the Search Engine**:
   - **Sites to search**: Enter `*` to search the entire web, or specify specific domains
   - **Language**: Select your preferred language
   - **Name**: Give your search engine a name (e.g., "AgentWeb Search")
   - Click "Create"

3. **Get the Search Engine ID**:
   - After creation, click on your search engine
   - Go to "Setup" > "Basics"
   - Copy the "Search engine ID" (it looks like: `017576662512468239146:omuauf_lfve`)

#### 4. Configure Web Search Provider

`search_web` now uses a provider abstraction. The default primary provider is You.com Search, with Google Custom Search as fallback. To restore Google as primary during rollback, set:

```bash
SEARCH_PROVIDER=google
```

You.com can be configured with either an environment variable or AWS Secrets Manager:

```bash
SEARCH_PROVIDER=you
YOU_API_KEY=your_you_api_key_here
```

For AWS Secrets Manager:

**For Development:**
- Secret Name: `dev/AgentWeb/YouCom/Search`
- Secret Value: either the raw API key string or JSON such as:
```json
{
  "apiKey": "your_you_api_key_here"
}
```

**For Production:**
- Secret Name: `prod/AgentWeb/YouCom/Search`
- Secret Value: either the raw API key string or the JSON shape above.

Google remains available as fallback. Store your Google Search API credentials in AWS Secrets Manager:

**For Development:**
- Secret Name: `dev/AgentWeb/Google/Search`
- Secret Value (JSON format):
```json
{
  "apiKey": "your_google_api_key_here",
  "searchEngineId": "your_search_engine_id_here"
}
```

**For Production:**
- Secret Name: `prod/AgentWeb/Google/Search`
- Secret Value (JSON format):
```json
{
  "apiKey": "your_google_api_key_here",
  "searchEngineId": "your_search_engine_id_here"
}
```

**Steps to add secrets:**
1. Go to AWS Secrets Manager in your AWS Console
2. Click "Store a new secret"
3. Choose "Other type of secret"
4. Add the JSON with your credentials
5. Name the secret according to your environment
6. Click "Store"

#### 5. Test the Configuration

1. **Install Dependencies**:
   ```bash
   cd backend
   npm install
   ```

2. **Restart the Backend**:
   ```bash
   npm run dev
   ```

3. **Test Web Search**:
   - Go to Agent Mode in your application
   - Ask a question that requires current information (e.g., "What are the latest marketing trends?")
   - The agent should now use real You.com search results, or Google results if You.com is not configured and fallback is enabled

#### 6. API Quotas and Limits

**You.com Search:**
- Returns unified web and news results from one request
- Agent Mode automatically requests fresher You.com result windows for time-sensitive queries: `day` for `today`/`breaking` queries and `week` for `latest`/`current`/`news`/`release notes` queries
- Supports up to 100 results per section at the provider layer; Agent Mode currently caps `search_web` requests to 10
- Optional livecrawl is supported by the provider but not enabled by default in `search_web`

**Google Custom Search fallback:**
- **Free Tier**: 100 searches per day
- **Paid Tier**: Up to 10,000 searches per day for $5
- **Rate Limits**: 10 requests per second

#### 7. Troubleshooting

**Common Issues:**

1. **"You.com Search API key is not configured"**:
   - Set `YOU_API_KEY` / `YOUCOM_API_KEY`, or store the key in `dev/AgentWeb/YouCom/Search` or `prod/AgentWeb/YouCom/Search`
   - If fallback is enabled, the backend will try Google next

2. **"API key not valid"**:
   - Check that the API key is correct in AWS Secrets Manager
   - Ensure Custom Search API is enabled in Google Cloud Console
   - Verify API key restrictions

3. **"Search engine not found"**:
   - Verify the Search Engine ID is correct in AWS Secrets Manager
   - Check that the search engine is active in Google Custom Search Engine

4. **"Secrets Manager access denied"**:
   - Ensure your AWS credentials have permissions to access Secrets Manager
   - Check that the secret names match exactly: `dev/AgentWeb/YouCom/Search`, `prod/AgentWeb/YouCom/Search`, `dev/AgentWeb/Google/Search`, or `prod/AgentWeb/Google/Search`
   - For You.com, verify the secret is either a raw API key string or JSON with `apiKey`; for Google, verify JSON includes `apiKey` and `searchEngineId`

5. **"Quota exceeded"**:
   - Check your daily quota usage in Google Cloud Console
   - Consider upgrading to paid tier if needed

6. **No search results**:
   - Empty web/news arrays are treated as successful zero-result searches, so the agent can adjust the query rather than treating this as infrastructure failure
   - Check the backend logs for error messages

**Fallback Behavior:**
- If You.com is not configured or fails and `SEARCH_PROVIDER_FALLBACK` is not `0`, the system tries Google Custom Search.
- If all configured providers fail, `search_web` returns a tool failure with the provider error summary.

### Google Search Console API Configuration

To enable SEO metrics tracking in the customer portal, you need to set up Google Search Console API.

#### 1. Create a Google Cloud Project

1. **Go to Google Cloud Console**:
   - Visit [Google Cloud Console](https://console.cloud.google.com/)
   - Select your existing project or create a new one

2. **Enable Search Console API**:
   - Go to "APIs & Services" > "Library"
   - Search for "Google Search Console API" and enable it

#### 2. Create Service Account

1. **Create Service Account**:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "Service account"
   - Enter a name (e.g., "AgentWeb SEO Service")
   - Click "Create and Continue"
   - Skip optional steps and click "Done"

2. **Create Service Account Key**:
   - Click on the service account you just created
   - Go to the "Keys" tab
   - Click "Add Key" > "Create new key"
   - Choose "JSON" format
   - Click "Create"
   - The JSON key file will be downloaded - **keep this secure!**

3. **Grant Service Account Access to Search Console Properties**:
   - Visit [Google Search Console](https://search.google.com/search-console)
   - For each domain you want to track:
     - Select the property
     - Go to Settings > Users and permissions
     - Click "Add user"
     - Enter the service account email (found in the JSON key file as `client_email`)
     - Select permission level: "Full" or "Restricted" (Restricted is sufficient for read-only access)
     - Click "Add"
   - **Note**: Users should grant access to the service account email for their domains

#### 3. Store Service Account JSON in AWS Secrets Manager

Store your Google Search Console API credentials in AWS Secrets Manager:

**For Development:**
- Secret Name: `dev/AgentWeb/Google/SearchConsole`
- Secret Value: Paste the entire contents of the service account JSON key file you downloaded

**For Production:**
- Secret Name: `prod/AgentWeb/Google/SearchConsole`
- Secret Value: Paste the entire contents of the service account JSON key file you downloaded

### Google Analytics Data API (GA4) Configuration for SEO/AEO

**AEO (Answer Engine Optimization)** tracks traffic from answer engines like ChatGPT, Perplexity, LinkedIn, and other AI-powered search platforms. The SEO/AEO page displays both traditional SEO metrics (from Google Search Console) and AEO metrics (from Google Analytics) to help you understand how users discover your content through both search engines and answer engines.

If you see `PERMISSION_DENIED: Google Analytics Data API has not been used...` on the SEO/AEO page, do the following:

1. **Enable Google Analytics Data API in the correct project**
   - Open [Google Cloud Console](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com)
   - Switch to the project used for AgentWeb (e.g., `606140610214` or your chosen project)
   - Click **Enable**
   - Wait a few minutes for the change to propagate

2. **Grant the service account access to the GA4 property**
   - Find the service account email stored in `dev/AgentWeb/Google/SearchConsole` or `prod/AgentWeb/Google/SearchConsole` (the `client_email` field)
   - In GA4 Admin, under **Property** > **Property Access Management**, click **Add** and grant this service account **Viewer** (read-only) access to the GA4 property you want to use

3. **Configure GA4 Property ID in Admin Dashboard**
   - In the partner portal Admin > Users tab, click the edit icon under the "SEO/AEO" column
   - In the "Google Analytics Property ID" field, enter the **numeric Property ID** (e.g., `123456789`)
   - **Important**: Enter the **Property ID** (numeric), NOT the Measurement ID (`G-XXXXXXXXXX`)
   - To find your Property ID: Go to GA4 Admin > Property Settings. The Property ID is the numeric value (e.g., `123456789`), not the Measurement ID which starts with `G-`
   - After enabling the API and granting access, retry the SEO/AEO page

4. **Configure Microsoft Clarity Project ID (for SEO/GEO Clarity link)**
   - In the partner portal Admin > Users tab, click the edit icon under the "SEO/AEO" column
   - In the "Microsoft Clarity Project ID" field, enter the Clarity project ID (e.g., `ul13e4f7fe`)
   - The customer portal SEO/GEO page will include a direct link to the Clarity dashboard

5. **Enable GA4 integration inside Clarity (to see GA4 view in Clarity)**
   - Open your Clarity project, go to Settings > Integrations
   - Connect Google Analytics and choose the GA4 property/data stream for this site
   - This unlocks the GA4 view and allows Clarity to show GA metrics alongside recordings

**What is AEO (Answer Engine Optimization)?**

AEO tracks how users discover your content through answer engines - AI-powered platforms like ChatGPT, Perplexity, Google Bard/Gemini, Bing Chat, LinkedIn, and other conversational search platforms. The SEO/AEO page shows:

- **SEO Metrics**: Traditional search engine performance from Google Search Console (clicks, impressions, CTR, position)
- **AEO Metrics**: Traffic from answer engines including:
  - Answer engine traffic volume and percentage of total traffic
  - Traffic sources breakdown (identifying which answer engines drive traffic)
  - Top pages that receive traffic from answer engines
  - User engagement metrics from answer engine traffic

This helps you understand both traditional search visibility and emerging answer engine visibility for your content.

#### Testing Google Analytics API Connection

If you're seeing 0 traffic or errors, you can test the API connection using the test script:

**Prerequisites:**
- The script uses the same AWS credential configuration as the backend (from `.env` file)
- AWS credentials must have `secretsmanager:GetSecretValue` permission
- Set `AWS_REGION` environment variable if not using default `us-west-2`
- Ensure `NODE_ENV` is set to `development` or `production` (defaults to `development`)
- **Note**: If you get `AccessDeniedException`, your local AWS credentials don't have Secrets Manager access. The script will work when run on the server where the backend normally runs.

**Run the test:**

```bash
cd backend
ts-node scripts/test-ga-api.ts <property-id>
```

Example:
```bash
ts-node scripts/test-ga-api.ts 123456789
```

The script will:
- Test the service account credentials from AWS Secrets Manager
- Fetch overall metrics (sessions, users, page views, bounce rate, session duration)
- Fetch daily data for the last 30 days
- Fetch traffic sources (including answer engine detection)
- Fetch top pages by traffic

**What to look for:**
- ✅ If you see data: The API is working correctly, check if the Property ID in admin matches
- ⚠️  If you see 0s: The Property ID might be correct but there's no traffic in the date range
- ❌ If you see errors: Check API enablement, service account permissions, or Property ID

**Common issues:**
- `PERMISSION_DENIED`: API not enabled or service account lacks access
- `not found`: Wrong Property ID or service account can't access this property
- `0 traffic`: Property ID is correct but no data in the selected date range

### PageSpeed Insights API Configuration (Technical SEO Score)

The SEO/GEO page can display a Technical SEO Score sourced from Google's PageSpeed Insights API (Lighthouse SEO category).

1. **Enable the PageSpeed Insights API**
   - Open [Google Cloud Console](https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com)
   - Select the project you want to bill and click **Enable**

2. **Create an API key**
   - Go to **APIs & Services** > **Credentials**
   - Click **Create Credentials** > **API key**
   - Optionally restrict the key (recommended for production)

3. **Configure the backend**
   - Store the PageSpeed API key in AWS Secrets Manager:
     - Secret Name: `dev/AgentWeb/Google/PageSpeed` or `prod/AgentWeb/Google/PageSpeed`
     - Secret value can be the raw API key or JSON containing `apiKey`
   - Optional: set `PAGESPEED_STRATEGY` to `mobile` or `desktop` (defaults to `mobile`)

**Notes:**
- The score is returned as a 0–100 integer (Lighthouse SEO category).
- If the API key is missing or the API call fails, the score shows as `N/A`.

### Meta (Facebook) App Configuration

The Meta integration allows users to connect Facebook Ad Accounts and Pages via OAuth.

#### 1. Create a Facebook App

1. Go to [Facebook Developers](https://developers.facebook.com/) and create a new app (type: **Business**)
2. Under **App Settings > Basic**, note your **App ID** and **App Secret**

#### 2. Configure OAuth Redirect URIs

In the Facebook app dashboard, first add the **Facebook Login for Business** product (under **App Dashboard > Add Product**). Then go to **Facebook Login for Business > Settings** and ensure:

- **Client OAuth Login**: On
- **Web OAuth Login**: On
- Add your redirect URI to **Valid OAuth Redirect URIs**:
  - Production: `https://api.agentweb.pro/api/oauth/meta/callback`
  - Local dev with ngrok: `https://<your-subdomain>.ngrok-free.app/api/oauth/meta/callback`

#### 3. Add Required Permissions

Under **App Review > Permissions and Features**, switch `public_profile` to **Advanced Access** (required after adding Facebook Login for Business). Then request these permissions:

- `ads_management`
- `ads_read`
- `business_management`
- `pages_show_list`
- `pages_read_engagement`
- `read_insights`

#### 4. Store Credentials in AWS Secrets Manager

- Secret Name: `dev/AgentWeb/MetaApp` (development) or `prod/AgentWeb/MetaApp` (production)
- Secret Value (JSON):
```json
{
  "clientId": "your_facebook_app_id",
  "clientSecret": "your_facebook_app_secret"
}
```

#### 5. Configure Backend Environment

The redirect URI is built from the `BACKEND_URL` environment variable (`backend/src/config/integrations.ts`):

```
redirect_uri = ${BACKEND_URL}/api/oauth/meta/callback
```

Set `BACKEND_URL` in your backend `.env` to match the domain you whitelisted in the Facebook app:

```bash
# Production
BACKEND_URL=https://api.agentweb.pro

# Local dev with ngrok
BACKEND_URL=https://<your-subdomain>.ngrok-free.app
```

Restart the backend after changing `BACKEND_URL`.

### Gmail Connected Account Configuration

Gmail uses Google OAuth 2.0 with offline access to let users connect their Gmail account for reading and sending email.

#### 1. Enable the Gmail API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project, then go to **APIs & Services > Library**
3. Search for **Gmail API** and enable it

#### 2. Add Redirect URIs

In your OAuth 2.0 Client ID (under **APIs & Services > Credentials**), add these redirect URIs:
- Production: `https://api.agentweb.pro/api/oauth/gmail/callback`
- Staging: `https://api-stage.agentweb.pro/api/oauth/gmail/callback`
- Local: `http://localhost:3001/api/oauth/gmail/callback`

Scopes (`gmail.readonly`, `gmail.send`, `userinfo.email`, `userinfo.profile`) are requested at runtime in the authorization URL — no console configuration needed.

#### 3. Store Credentials in AWS Secrets Manager

- Secret Name: `dev/AgentWeb/Google/Gmail` (development) or `prod/AgentWeb/Google/Gmail` (production)
- Secret Value (JSON):
```json
{
  "clientId": "your_google_client_id",
  "clientSecret": "your_google_client_secret"
}
```

### YouTube Connected Account Configuration

YouTube uses the same Google OAuth 2.0 credentials as Gmail (same Google Cloud project). It allows users to connect their YouTube channel for reading channel data, listing videos, viewing analytics, and uploading videos.

#### 1. Enable the YouTube Data API v3

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select the **same project** used for Gmail OAuth
3. Go to **APIs & Services > Library**
4. Search for **YouTube Data API v3** and enable it

#### 2. Add Redirect URIs

In the same OAuth 2.0 Client ID used for Gmail (under **APIs & Services > Credentials**), add these redirect URIs:
- Production: `https://api.agentweb.pro/api/oauth/youtube/callback`
- Staging: `https://api-stage.agentweb.pro/api/oauth/youtube/callback`
- Local: `http://localhost:3001/api/oauth/youtube/callback`

Scopes (`youtube`, `youtube.readonly`, `userinfo.email`, `userinfo.profile`) are requested at runtime in the authorization URL — no console configuration needed.

#### 3. Credentials

No additional secrets needed — YouTube reuses the Gmail credentials from `dev/AgentWeb/Google/Gmail` (or `prod/AgentWeb/Google/Gmail`).

### CMS Configuration (BaseHub and Webflow)

The blog publishing feature supports publishing to both BaseHub and Webflow CMS. Users can be configured with a CMS Type in the admin dashboard, and the system will automatically route blog posts to the appropriate CMS.

#### BaseHub CMS Configuration

BaseHub configuration is stored in AWS Secrets Manager:

**For Development:**
- Secret Name: `dev/AgentWeb/BaseHub`
- Secret Value (JSON format):
```json
{
  "apiUrl": "https://api.basehub.com/graphql",
  "token": "your_basehub_token_here",
  "postsCollectionId": "your_posts_collection_id",
  "imageComponentId": "your_image_component_id"
}
```

**For Production:**
- Secret Name: `prod/AgentWeb/BaseHub`
- Secret Value (JSON format):
```json
{
  "apiUrl": "https://api.basehub.com/graphql",
  "token": "your_basehub_token_here",
  "postsCollectionId": "your_posts_collection_id",
  "imageComponentId": "your_image_component_id"
}
```

**Steps to add BaseHub secret:**
1. Go to AWS Secrets Manager in your AWS Console
2. Click "Store a new secret"
3. Choose "Other type of secret"
4. Add the JSON with your BaseHub credentials
5. Name the secret according to your environment (`dev/AgentWeb/BaseHub` or `prod/AgentWeb/BaseHub`)
6. Click "Store"

#### Webflow CMS Configuration

Webflow configuration is stored in AWS Secrets Manager. You can configure either:

- A **global secret** (used when no per-user config is defined)
- A **per-user secret** for each user (recommended for multi-tenant setups)

**Global Configuration (fallback when no user-specific secret is used):**

**For Development (global):**
- Secret Name: `dev/AgentWeb/Webflow`
- Secret Value (JSON format, shared across all users who don't have their own Webflow config):
```json
{
  "apiToken": "your_webflow_api_token",
  "siteId": "your_webflow_site_id",
  "collectionId": "your_webflow_collection_id",
  "fieldMappings": {
    "summary": "post-summary",
    "body": "post-body",
    "image": "main-image",
    "publishDate": null
  }
}
```

**For Production (global):**
- Secret Name: `prod/AgentWeb/Webflow`
- Secret Value (JSON format, shared across all users who don't have their own Webflow config):
```json
{
  "apiToken": "your_webflow_api_token",
  "siteId": "your_webflow_site_id",
  "collectionId": "your_webflow_collection_id",
  "fieldMappings": {
    "summary": "post-summary",
    "body": "post-body",
    "image": "main-image",
    "publishDate": null
  }
}
```

**Note:** The `fieldMappings` field is optional but **highly recommended**. If omitted, the system will use default field names (`post-summary`, `post-body`, `main-image`) which may not match your Webflow collection schema. See the "Configuring Field Mappings" section below for details.

**Per-User Webflow Configuration (preferred):**

When a user has `CMS Type = Webflow`, you can give them their **own** Webflow site/collection by creating a per-user secret. In this case, the backend will **require** the per-user secret and will **not** fall back to the global one.

- Secret name pattern (Development):  
  `dev/AgentWeb/Webflow/<user_id>`

- Secret name pattern (Production):  
  `prod/AgentWeb/Webflow/<user_id>`

Example per-user secret value:

```json
{
  "apiToken": "user_specific_webflow_api_token",
  "siteId": "user_specific_webflow_site_id",
  "collectionId": "user_specific_webflow_collection_id",
  "fieldMappings": {
    "summary": "post-summary",
    "body": "post-body",
    "image": "main-image",
    "publishDate": null
  }
}
```

**Configuring Field Mappings (Required):**

The `fieldMappings` object maps AgentWeb's blog post fields to your Webflow collection's field slugs. **This is critical** - if the field names don't match your Webflow collection schema, you'll get validation errors.

**How to find your Webflow collection field slugs:**

1. Go to your Webflow site dashboard
2. Navigate to **CMS Collections** > Your blog posts collection
3. Click on any field (e.g., "Post Summary", "Post Body", "Main Image")
4. The field slug is shown in the field settings or in the URL
5. Alternatively, use the Webflow API to list collection fields:
   ```bash
   curl -X GET "https://api.webflow.com/v2/collections/{collectionId}" \
     -H "Authorization: Bearer {apiToken}" \
     -H "accept-version: 2.0.0"
   ```
   Look for the `fields` array - each field has a `slug` property

**Field Mappings Configuration:**

The `fieldMappings` object supports the following fields:

- **`summary`** (optional): Maps to the field that stores the blog post summary/description. Set to `null` or omit if your collection doesn't have this field.
- **`body`** (optional): Maps to the field that stores the blog post body/content (HTML). Set to `null` or omit if your collection doesn't have this field.
- **`image`** (optional): Maps to the field that stores the hero/main image URL. Set to `null` or omit if your collection doesn't have this field.
- **`publishDate`** (optional): Maps to the field that stores the publish date. Set to `null` or omit if your collection doesn't have this field.

**Example configurations:**

If your Webflow collection uses different field names:
```json
{
  "apiToken": "your_token",
  "siteId": "your_site_id",
  "collectionId": "your_collection_id",
  "fieldMappings": {
    "summary": "excerpt",
    "body": "content",
    "image": "featured-image",
    "publishDate": "published-on"
  }
}
```

If your collection doesn't have a publish date field:
```json
{
  "apiToken": "your_token",
  "siteId": "your_site_id",
  "collectionId": "your_collection_id",
  "fieldMappings": {
    "summary": "post-summary",
    "body": "post-body",
    "image": "main-image",
    "publishDate": null
  }
}
```

**Important Notes:**
- Field slugs are case-sensitive and must match exactly
- If `fieldMappings` is not provided, the system will use default values (`post-summary`, `post-body`, `main-image`), which may not match your collection schema
- If you get validation errors like "Field not described in schema", check that your `fieldMappings` match your actual Webflow collection field slugs
- You can configure `fieldMappings` in both global and per-user secrets
- When a `userId` is provided, the backend will **only** read from `dev/AgentWeb/Webflow/<user_id>` or `prod/AgentWeb/Webflow/<user_id>` and will **not** fall back to the global secret.
- When no `userId` is provided (legacy flows), the global secret (`dev/AgentWeb/Webflow` or `prod/AgentWeb/Webflow`) is used.

**Configuring Categories Mapping:**

The `categories` field in the Webflow configuration maps human-readable category names to Webflow category reference IDs. This allows the agent to use friendly category names (e.g., "Technology", "Marketing") instead of cryptic IDs when publishing blog posts.

**How to configure categories:**

1. **Find your Webflow category IDs:**
   - Go to your Webflow CMS Collections
   - Navigate to your Categories collection (if you have one)
   - Note down the category names and their corresponding IDs
   - Or use the Webflow API to list category items:
     ```bash
     curl -X GET "https://api.webflow.com/v2/collections/{categoriesCollectionId}/items" \
       -H "Authorization: Bearer {apiToken}" \
       -H "accept-version: 2.0.0"
     ```

2. **Add categories mapping to your Webflow secret:**

```json
{
  "apiToken": "your_webflow_api_token",
  "siteId": "your_webflow_site_id",
  "collectionId": "your_webflow_collection_id",
  "fieldMappings": {
    "summary": "post-summary",
    "body": "post-body",
    "image": "main-image",
    "publishDate": null,
    "author": "author",
    "category": "categories"
  },
  "categories": {
    "Technology": "64f2a3b1c8d9e7f6a5b4c3d2",
    "Marketing": "54e1b2c3d4e5f6a7b8c9d0e1",
    "Product": "74g3c4d5e6f7g8h9i0j1k2l3",
    "Design": "84h4d5e6f7g8h9i0j1k2l3m4"
  }
}
```

**Usage in Agent Mode:**

When publishing blog articles, the agent can now use category names instead of IDs:

```javascript
// Agent uses human-readable names
publish_blog_article({
  title: "Article Title",
  description: "Description",
  hero_image_url: "https://...",
  blog_html_url: "https://...",
  status: "published",
  categories: ["Technology", "Marketing"]  // Uses names, not IDs
})
```

**Important Notes:**
- Category names in the mapping must match exactly (case-sensitive)
- If a category name is not found in the mapping, it will be skipped with a warning
- If publishing with `status: "published"`, at least one valid category is required
- If validation fails, the error message will include a list of available category names
- The system automatically converts category names to IDs before sending to Webflow

**Single Reference vs Multi-Reference Fields:**

The system intelligently detects whether your Webflow category field is a single reference or multi-reference based on the field name:

- **Single Reference** (singular field name like `"category"`, `"tag"`):
  - Only accepts ONE category
  - If multiple categories are provided, only the first one will be used
  - Value sent to Webflow: `"categoryId123"` (string)
  - Configure in fieldMappings: `"category": "category"`

- **Multi-Reference** (plural field name like `"categories"`, `"tags"`):
  - Accepts MULTIPLE categories
  - All provided categories will be included
  - Value sent to Webflow: `["categoryId123", "categoryId456"]` (array)
  - Configure in fieldMappings: `"category": "categories"` (default)

**Example configurations:**

```json
// Multi-reference (default) - accepts multiple categories
{
  "fieldMappings": {
    "category": "categories"  // plural name = multi-reference
  }
}

// Single reference - accepts only one category
{
  "fieldMappings": {
    "category": "category"  // singular name = single reference
  }
}
```

The system automatically detects the field type based on whether the field name ends with "s" or "ies".

**How to get Webflow credentials:**

1. **Get Site API Token:**
   - Go to your Webflow site dashboard
   - Navigate to **Site Settings** > **Apps & integrations** tab
   - Under **API access**, click **Generate API token**
   - Provide a name for your token (e.g., "AgentWeb Blog Publishing")
   - Assign the necessary permissions (read and write for CMS collections)
   - Click **Generate token** and securely copy the token
   - **Note:** This is a Site API Token (not Workspace API), which is ideal for single-site integrations like this one

2. **Get Site ID:**
   - Go to your Webflow site dashboard
   - The Site ID is in the URL: `https://webflow.com/design/your-site-name?siteId=YOUR_SITE_ID`
   - Or go to Site Settings > General > Site ID

3. **Get Collection ID:**
   - Go to your Webflow site dashboard
   - Navigate to CMS Collections
   - Click on your blog posts collection
   - The Collection ID is in the URL: `https://webflow.com/design/your-site-name/collections/YOUR_COLLECTION_ID`
   - Or go to Collection Settings > General > Collection ID

**Steps to add Webflow secret:**
1. Go to AWS Secrets Manager in your AWS Console
2. Click "Store a new secret"
3. Choose "Other type of secret"
4. Add the JSON with your Webflow credentials
5. Name the secret according to your environment (`dev/AgentWeb/Webflow` or `prod/AgentWeb/Webflow`)
6. Click "Store"

### MCP Server Configuration

The backend supports multiple Model Context Protocol (MCP) servers, which can be configured internally (via code) or externally (via database/UI).

#### Internal MCP Servers (Core)

Internal servers are configured in `src/mcp/client/mcp_config.ts`. These are hardcoded and loaded at startup. This is also where you configure `stdio` based servers (local subprocesses).

- **Config File**: `src/mcp/client/mcp_config.ts`
- **Supported Transports**: SSE, Streamable HTTP, Stdio
- **Context Injection**: Internal servers (like `agentweb-tools`) automatically receive user context (`userId`, `sessionId`, `llmModel`) for tool execution.
- **Authentication**: To secure the internal server endpoints (`/mcp/server`), you **must** set `MCP_ACCESS_TOKEN` in your `.env` file. This token is required for all connections to the internal server.


#### External MCP Servers (Dynamic)

External servers can be added dynamically via the Admin UI or configured in the database setting `mcp_servers`.

- **Storage**: DynamoDB `Configs` table (key: `mcp_servers`)
- **Management**: Admin Dashboard -> MCP Servers
- **Supported Transports in Admin UI**: Streamable HTTP, SSE, and Stdio
- **Local MCP via Backend**: Use `Stdio` in the Admin UI to let the backend spawn local MCP processes directly (no separate HTTP wrapper service required).
  - Example (Brave Search MCP): `command: npx`, args lines: `-y`, `@brave/brave-search-mcp-server`, `--transport`, `stdio`
  - Brave API key can be passed in args too: add `--brave-api-key` and then your key as the next argument line.
  - Put API keys in the environment JSON field, e.g. `{"env":{"BRAVE_API_KEY":"${BRAVE_API_KEY}"}}`


#### Configuring ClickUp MCP Server

Each customer who uses ClickUp can connect their workspace so AI agents can read tasks, lists, and spaces via the official [ClickUp MCP server](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1).

**1. Add the ClickUp MCP server in Admin Dashboard:**

1. Open the **Partner Portal** (admin) and navigate to **Admin Dashboard > MCP Servers**
2. Add a new server with the following settings:
   - **Name:** `clickup`
   - **Transport:** `Streamable HTTP`
   - **URL:** `https://mcp.clickup.com/mcp`
   - **Access Token:** `{{clickup_access_token}}`

The `{{clickup_access_token}}` placeholder is resolved per-user at execution time — the backend decrypts the token from the user's secrets and injects it into the MCP connection. This is the same pattern used by the GitHub MCP server with `{{GITHUB_PERSONAL_ACCESS_TOKEN}}`.

**2. Users add their ClickUp Personal API Token:**

Each user provides their ClickUp Personal API Token from the **Knowledge Base** page in the customer portal:

1. Navigate to **Knowledge Base**
2. In the **ClickUp Shared Folders** section, paste a Personal API Token (generated from [ClickUp Settings → Apps](https://app.clickup.com/settings/apps))
3. Click **Connect** — the page verifies the token and shows connected workspaces

The token is stored as `clickup_access_token` in the user's secrets (encrypted at rest, decrypted only at execution time).

To disconnect, click **Disconnect** in the ClickUp Shared Folders section — this removes the encrypted token from the user's secrets.

#### Configuring GitHub Access Token for Landing Pages

Each customer who uses the **Landing Pages** feature (Brand Hub > Landing Pages) or the **Landing Page Development** skill in Agent Mode needs a GitHub fine-grained personal access token configured on their user record.

**1. Create the token on GitHub:**

1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta) (Fine-grained tokens)
2. Click **Generate new token**
3. **Token name:** `vercel-<client_name>-prod-token` (e.g., `vercel-acme-corp-prod-token`)
4. **Expiration:** choose an appropriate duration
5. **Resource owner:** select the `AgentWebPro` organization
6. **Repository access:** select **Only select repositories**, then pick the repositories for the client's landing page sites
7. **Permissions** — under *Repository permissions*, set:
   - **Contents** — Read and write
   - **Pull requests** — Read and write
8. Click **Generate token** and copy the token value

**2. Store the token on the user record:**

1. Open the **Partner Portal** (admin) and navigate to **Users**
2. Find the customer's user record and open the detail view
3. In the **Secrets** section, add a new secret:
   - **Key:** `GITHUB_PERSONAL_ACCESS_TOKEN`
   - **Value:** paste the token generated above
4. Save — the value is encrypted at rest and decrypted only at execution time

The token is used in two places:
- **Landing Pages page** — fetches the list of AgentWebPro repos the token can access and displays each repo's `AGENT.md`
- **Landing Page Development skill** (Agent Mode) — reads/writes files and creates pull requests on the client's repos via the GitHub MCP server

#### Configuring User CMS Type

After setting up the CMS secrets, you need to configure which CMS each user should use:

1. **Access Admin Dashboard:**
   - Log in to the partner portal as an admin
   - Navigate to the Admin Dashboard
   - Go to the "Users" tab

2. **Set CMS Type:**
   - Find the user you want to configure
   - In the "CMS Type" column, click the edit icon
   - Select either "Basehub" or "Webflow" from the dropdown
   - Click the checkmark to save

3. **Publishing Behavior:**
   - If CMS Type is set to "Basehub": Blog posts will be published to BaseHub CMS
   - If CMS Type is set to "Webflow": Blog posts will be published to Webflow CMS
   - If CMS Type is not set: Publishing will be disabled with an error message

**Note:** Users must have a CMS Type configured to publish blog posts. If not configured, the "Publish" button will show an error when attempting to publish.

### Testing MCP Server with Claude Code

The Emma MCP server exposes ~30 API-wrapping tools via [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http). You can connect Claude Code (or any MCP-compatible client) to test the tools.

#### 1. Get an API Key

1. Sign up at [agentweb.pro](https://agentweb.pro) and subscribe to a plan
2. Go to **Settings → API Keys**
3. Create a new key (starts with `aw_`)

#### 2. Configure Claude Code

Add the following to your project's `.mcp.json` (or `~/.claude.json` for global config):

```json
{
  "mcpServers": {
    "emma": {
      "type": "streamable-http",
      "url": "https://api.agentweb.pro/mcp",
      "headers": {
        "Authorization": "Bearer aw_YOUR_KEY_HERE"
      }
    }
  }
}
```

For the **test environment**, use:

```json
{
  "mcpServers": {
    "emma": {
      "type": "streamable-http",
      "url": "http://<TEST_ENV_IP>:3001/mcp",
      "headers": {
        "Authorization": "Bearer aw_YOUR_KEY_HERE"
      }
    }
  }
}
```

#### 3. Verify Connection

After restarting Claude Code, the Emma tools should appear in the tool list. Try calling:

- `list_tasks` — list your automation tasks
- `list_connected_accounts` — list linked social accounts
- `search_web` — perform a web search
- `list_lead_lists` — list CRM lead lists
- `list_gtm_plans` — list GTM plans

#### 4. Available Tools

| Category | Tools |
|----------|-------|
| Emma Chat | `emma_create_session`, `emma_send_message`, `emma_get_session`, `emma_list_sessions` |
| Tasks | `list_tasks`, `manage_task`, `execute_task`, `list_task_executions` |
| Schedules | `list_schedules`, `manage_schedule` |
| CRM/Leads | `list_lead_lists`, `manage_lead_list`, `manage_leads`, `search_leads` |
| GTM Plans | `list_gtm_plans`, `manage_gtm_plan`, `manage_gtm_items` |
| Knowledge Base | `list_knowledge_bases`, `search_knowledge_base`, `read_knowledge_base_files` |
| Brand & Strategy | `manage_brand`, `manage_market_strategy` |
| Content | `generate_blog_post`, `publish_blog_post` |
| Connected Accounts | `list_connected_accounts`, `post_on_account` |
| AI Operations | `search_web`, `generate_image`, `send_email`, `save_file` |
| Skills | `install_skills`, `list_available_skills` |

#### 5. Security Notes

- All tool calls go through the backend's REST API middleware (authentication, validation, rate limiting)
- The API key identifies the user; `userId` cannot be overridden in tool arguments (IDOR protection)
- API keys can be revoked at any time from **Settings → API Keys**

### Client Subdomain Setup for Lead Forms

AgentWeb supports hosting client lead forms on custom subdomains under `agentwebforms.com` (e.g., `clientname.agentwebforms.com`). This section describes how to configure the infrastructure to serve HTML files from S3 through CloudFront with proper caching and domain configuration.

#### Overview

The setup involves four main components:

1. **S3 File Storage**: HTML lead forms stored in the `agentweb-user-files` bucket with proper metadata
2. **CloudFront Distribution**: CDN to serve the files with caching and HTTPS
3. **CloudFront Functions**: URL rewriting to map subdomain paths to S3 object keys
4. **Route 53**: DNS configuration to point subdomains to CloudFront

#### 1. S3 File Configuration

When uploading lead form HTML files to S3, ensure the following metadata is set:

**Required System-Defined Metadata:**
- `Content-Type`: `text/html` (ensures browser displays HTML instead of downloading)
- `Cache-Control`: `max-age=60` (CloudFront caches for 60 seconds)

**Required User-Defined Metadata:**
- `x-amz-meta-original-filename`: Original filename (e.g., `html_1769547083048_AgentWeb_Lead_Generation_Form_v4.html`)
- `x-amz-meta-upload-timestamp`: Upload timestamp (e.g., `2026-01-27T20:58:03.052Z`)
- `x-amz-meta-uploaded-by`: Source of upload (e.g., `agent-mode`)

**Setting metadata via AWS CLI:**

```bash
aws s3api copy-object \
  --region us-west-2 \
  --bucket agentweb-user-files \
  --key "users/{userId}/files/{timestamp}/{token}/{filename}.html" \
  --copy-source "agentweb-user-files/users/{userId}/files/{timestamp}/{token}/{filename}.html" \
  --content-type "text/html" \
  --cache-control "max-age=60" \
  --metadata "original-filename={filename}.html,upload-timestamp={timestamp},uploaded-by=agent-mode" \
  --metadata-directive REPLACE
```

**Important Notes:**
- Do NOT set `Content-Disposition: attachment` as this will trigger downloads instead of displaying the file
- The `Cache-Control` header tells CloudFront to only cache for 60 seconds, allowing relatively quick updates to the forms

#### 2. CloudFront Distribution Setup

Create or configure a CloudFront distribution to serve files from the S3 bucket:

**Distribution Configuration:**

1. **Origin Settings:**
   - Origin Domain: `agentweb-user-files.s3.us-west-2.amazonaws.com`
   - Origin Path: Leave empty (or set to specific path if needed)
   - Origin Access: Use OAI (Origin Access Identity) or CloudFront Origin Access Control for security

2. **Default Cache Behavior:**
   - Viewer Protocol Policy: `Redirect HTTP to HTTPS`
   - Allowed HTTP Methods: `GET, HEAD`
   - Cache Policy: Create custom policy or use managed policy
   - Cache TTL: Respect origin headers (max-age=60 from S3)

3. **Alternate Domain Names (CNAMEs):**
   - Add wildcard domain: `*.agentwebforms.com`
   - This allows all client subdomains to use the same distribution

4. **SSL Certificate:**
   - Use AWS Certificate Manager (ACM) to create/import a wildcard certificate for `*.agentwebforms.com`
   - Certificate must be in `us-east-1` region for CloudFront
   - Attach the certificate to the distribution

5. **CloudFront Function Association:**
   - Create a function to rewrite URLs (see next section)
   - Associate the function with the `Viewer Request` event

#### 3. CloudFront Function for URL Rewriting

Create a CloudFront Function to redirect root path requests to the specific lead form HTML file:

```javascript
function handler(event) {
    var request = event.request;
    var uri = request.uri;

    // If the request is for the root (/) or is empty,
    // force it to your specific file.
    if (uri === '/' || uri === '') {
        request.uri = '/users/{userId}/files/{timestamp}/{token}/html_{timestamp}_ClientName_Lead_Generation_Form.html';
    }

    return request;
}
```

**Notes:**
- Replace the placeholders in `request.uri`:
  - `{userId}`: The client's user ID (e.g., `be754b6c-767e-44ec-b181-4042cfe45ea9`)
  - `{timestamp}`: File upload timestamp (e.g., `1769547083052`)
  - `{token}`: Random access token (e.g., `01c6bd804e771114d26a14cb13129be7`)
  - `ClientName`: The actual client name in the filename
- This redirects `clientname.agentwebforms.com/` to the specific S3 object path
- Each client subdomain typically needs its own CloudFront Function with their specific file path
- For more advanced routing (multiple forms per subdomain, dynamic client mapping), you can use request headers or query parameters to determine which file to serve

**To create and deploy the function:**

1. Go to CloudFront > Functions in AWS Console
2. Click "Create function"
3. Name: `lead-form-url-rewriter`
4. Add the function code above (customize as needed)
5. Test the function with sample events
6. Publish the function
7. Associate it with your CloudFront distribution (Viewer Request event)

#### 4. Route 53 DNS Configuration

Configure DNS to point client subdomains to the CloudFront distribution:

**Option A: Wildcard Record (Recommended for multiple clients)**

1. Go to Route 53 > Hosted zones
2. Select your hosted zone for `agentwebforms.com`
3. Click "Create record"
4. Record configuration:
   - Record name: `*` (wildcard for all subdomains)
   - Record type: `A - IPv4 address`
   - Alias: Yes
   - Route traffic to: `Alias to CloudFront distribution`
   - Choose your CloudFront distribution
   - Routing policy: Simple routing
5. Click "Create records"

**Option B: Individual Client Records (More granular control)**

For each client, create a separate record:

1. Go to Route 53 > Hosted zones
2. Select your hosted zone for `agentwebforms.com`
3. Click "Create record"
4. Record configuration:
   - Record name: `clientname` (e.g., `acme`)
   - Record type: `A - IPv4 address`
   - Alias: Yes
   - Route traffic to: `Alias to CloudFront distribution`
   - Choose your CloudFront distribution
5. Click "Create records"

#### 5. Testing the Setup

After configuration, test the setup:

1. **DNS Propagation:**
   ```bash
   dig clientname.agentwebforms.com
   nslookup clientname.agentwebforms.com
   ```

2. **HTTPS Access:**
   ```bash
   curl -I https://clientname.agentwebforms.com
   ```

   Should return:
   - Status: `200 OK`
   - `Content-Type: text/html`
   - `Cache-Control: max-age=60`
   - `X-Cache: Hit from cloudfront` (on subsequent requests)

3. **Browser Test:**
   - Open `https://clientname.agentwebforms.com/form.html` in a browser
   - Verify the HTML renders correctly (not downloaded)
   - Check SSL certificate is valid

#### 6. Troubleshooting

**Common Issues:**

1. **File downloads instead of displaying:**
   - Check `Content-Type` is set to `text/html` on S3 object
   - Verify no `Content-Disposition: attachment` header

2. **403 Forbidden errors:**
   - Check CloudFront OAI has permission to read from S3 bucket
   - Verify S3 bucket policy allows CloudFront access

3. **404 Not Found errors:**
   - Verify CloudFront Function is correctly rewriting URLs
   - Check S3 object key matches the rewritten path
   - Test function with CloudFront Function test console

4. **SSL certificate errors:**
   - Ensure wildcard certificate (`*.agentwebforms.com`) is created in `us-east-1`
   - Verify certificate is attached to CloudFront distribution
   - Check certificate includes the subdomain being accessed

5. **Caching issues (stale content):**
   - Cache-Control is set to 60 seconds, wait up to 1 minute for updates
   - Create CloudFront invalidation for immediate updates: `/*` or specific paths
   - Check CloudFront cache statistics in CloudFront console

6. **DNS not resolving:**
   - Wait for DNS propagation (can take up to 48 hours)
   - Use `dig` or `nslookup` to verify DNS records
   - Check Route 53 hosted zone has correct NS records

#### 7. Maintenance and Updates

**Updating Lead Form HTML:**

1. Upload new version to S3 with proper metadata
2. Wait up to 60 seconds for CloudFront cache to expire, or
3. Create CloudFront invalidation for immediate update:
   ```bash
   aws cloudfront create-invalidation \
     --distribution-id E1234567890ABC \
     --paths "/users/clientid/files/*/form.html"
   ```

**Adding New Clients:**

1. Upload client's lead form HTML to S3 with proper metadata
2. If using individual DNS records (Option B), create new Route 53 record
3. Update CloudFront Function if custom mapping is needed
4. Test the new subdomain

**Monitoring:**

- Monitor CloudFront access logs for usage patterns
- Set up CloudWatch alarms for 4xx/5xx error rates
- Track cache hit ratios to optimize performance

## Testing

### Running Backend Unit Tests

The backend includes comprehensive unit tests for the sharing functionality and other core features. To run the tests locally:

#### Prerequisites

1. **Install Dependencies**:
   ```bash
   cd backend
   npm install
   ```

2. **Set Environment Variables**:
   ```bash
   export NODE_ENV=test
   export AWS_REGION=us-west-2
   export AWS_ACCESS_KEY_ID=test-access-key
   export AWS_SECRET_ACCESS_KEY=test-secret-key
   ```

#### Running Tests

1. **Run All Tests**:
   ```bash
   cd backend
   npm test
   ```

2. **Run Tests with Coverage**:
   ```bash
   cd backend
   npm run test:coverage
   ```

3. **Run Specific Test Files**:
   ```bash
   cd backend
   npm test -- --testPathPattern=agentModeSharing
   ```

#### Test Structure

The tests are located in `backend/src/__tests__/` and include:

- **Unit Tests**: Test individual functions and controllers in isolation
- **Integration Tests**: Test API endpoints and database interactions
- **Mocking**: Uses Jest mocks for AWS services and external dependencies

#### Test Configuration

- **Jest Configuration**: `backend/jest.config.js`
- **Test Setup**: `backend/src/__tests__/setup.ts`
- **Environment**: Tests run with `NODE_ENV=test` and mock AWS credentials

#### Available Test Scripts

- `npm test` - Run all tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report
- `npm run test:ci` - Run tests in CI mode (single run, no watch)

#### Troubleshooting Tests

**Common Issues:**

1. **"Cannot find module" errors**:
   - Ensure all dependencies are installed with `npm install`
   - Check that the test setup file is properly configured

2. **AWS credential errors**:
   - Make sure environment variables are set correctly
   - Tests use mock credentials, not real AWS credentials

3. **Database connection errors**:
   - Tests use mocked database services, not real DynamoDB
   - Check that mocks are properly configured in test files

**Note**: Tests are not run automatically in the CI/CD pipeline to avoid complexity and reduce build times. Run tests locally before submitting pull requests.

## Cloud Test Environment

Ephemeral test environments on EC2 for manual testing. Runs backend, partner-portal, and customer-portal as Docker containers on a single instance.

### One-Time Admin Setup

1. **Grant yourself temporary permissions** by adding an inline IAM policy:

```bash
aws iam put-user-policy \
  --user-name YOUR_IAM_USERNAME \
  --policy-name SetupAgentWebTestInfra \
  --policy-document '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:PutSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:us-west-2:992382574572:secret:agentweb/test-env/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:GetRole",
        "iam:PutRolePolicy",
        "iam:CreateInstanceProfile",
        "iam:GetInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:PassRole"
      ],
      "Resource": [
        "arn:aws:iam::992382574572:role/agentweb-test-env-ec2-role",
        "arn:aws:iam::992382574572:instance-profile/agentweb-test-env-profile"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeVpcs"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}'
```

2. **Run the infrastructure setup script:**

```bash
./test-env/setup-infra.sh
```

This creates a Secrets Manager secret (stores backend `.env`) and an IAM instance profile (EC2 can read the secret). Per-instance security groups are created automatically at launch time, locked to the developer's IP.

3. **Remove the temporary policy** after setup completes:

```bash
aws iam delete-user-policy \
  --user-name YOUR_IAM_USERNAME \
  --policy-name SetupAgentWebTestInfra
```

### Developer IAM Policy

Each developer needs the `AgentWebTestEnvDeveloper` policy attached to their IAM user. This grants permission to launch and terminate test-env instances only (production instances are protected via tag-based conditions).

```bash
aws iam put-user-policy \
  --user-name DEVELOPER_IAM_USERNAME \
  --policy-name AgentWebTestEnvDeveloper \
  --policy-document '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowDescribeOnly",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeKeyPairs",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeImages",
        "ec2:DescribeVpcs"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowSecurityGroupManagement",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateSecurityGroup",
        "ec2:DeleteSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowLaunchTestEnvInstance",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": "arn:aws:ec2:us-west-2:992382574572:instance/*",
      "Condition": {
        "StringEquals": {
          "aws:RequestTag/purpose": "test-env"
        }
      }
    },
    {
      "Sid": "AllowLaunchTestEnvResources",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": [
        "arn:aws:ec2:us-west-2:992382574572:volume/*",
        "arn:aws:ec2:us-west-2:992382574572:network-interface/*",
        "arn:aws:ec2:us-west-2:992382574572:key-pair/*",
        "arn:aws:ec2:us-west-2:992382574572:security-group/*",
        "arn:aws:ec2:us-west-2:992382574572:subnet/*",
        "arn:aws:ec2:us-west-2::image/*",
        "arn:aws:ec2:us-west-2::snapshot/*"
      ]
    },
    {
      "Sid": "AllowTagging",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": "*"
    },
    {
      "Sid": "AllowTerminateTestEnvOnly",
      "Effect": "Allow",
      "Action": "ec2:TerminateInstances",
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "ec2:ResourceTag/purpose": "test-env"
        }
      }
    },
    {
      "Sid": "AllowCreateKeyPair",
      "Effect": "Allow",
      "Action": "ec2:CreateKeyPair",
      "Resource": "*"
    },
    {
      "Sid": "AllowPassTestEnvRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::992382574572:role/agentweb-test-env-ec2-role"
    },
    {
      "Sid": "AllowSSMForAMI",
      "Effect": "Allow",
      "Action": "ssm:GetParameters",
      "Resource": "arn:aws:ssm:us-west-2::parameter/aws/service/ami-amazon-linux-latest/*"
    },
    {
      "Sid": "AllowGetInstanceProfile",
      "Effect": "Allow",
      "Action": "iam:GetInstanceProfile",
      "Resource": "arn:aws:iam::992382574572:instance-profile/agentweb-test-env-profile"
    },
    {
      "Sid": "AllowGetCallerIdentity",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}'
```

To remove the policy later:

```bash
aws iam delete-user-policy \
  --user-name DEVELOPER_IAM_USERNAME \
  --policy-name AgentWebTestEnvDeveloper
```

### Developer Usage

Each environment is automatically named from your AWS username and repo folder name (e.g., `myuser-agentweb`). This means each clone gets its own isolated instance — scripts in `agentweb/` can only operate the `agentweb` instance, and scripts in `agentweb1/` can only operate the `agentweb1` instance.

1. On first launch, the script will interactively create `.test-env.config` and an EC2 key pair if needed. Or create it manually in the repo root:

```
KEY_NAME=my-keypair
KEY_FILE=~/.ssh/my-keypair.pem
```

2. Launch and use:

```bash
./test-env/test-env.sh launch              # Spin up environment
./test-env/test-env.sh sync                # Sync all code changes
./test-env/test-env.sh sync backend        # Sync just backend
./test-env/test-env.sh allow-ip 203.0.113.50  # Grant another person access
./test-env/test-env.sh revoke-ip 203.0.113.50 # Revoke their access
./test-env/test-env.sh logs backend        # View backend logs
./test-env/test-env.sh ssh                 # SSH into instance
./test-env/test-env.sh status              # Check status
./test-env/test-env.sh list                # Show this folder's environment
./test-env/test-env.sh teardown            # Terminate instance
```

- **IP-restricted by default** — only the developer's IP (auto-detected at launch) can access the instance. Use `allow-ip` / `revoke-ip` to manage access for others.
- Backend `.env` is fetched from Secrets Manager automatically (developers never see it)
- Code is synced via `rsync` (only changed files)
- Instance auto-terminates after **24 hours of inactivity**
- Ports: backend=3001, partner-portal=5173, customer-portal=5174
- Multiple clones (e.g., `agentweb/`, `agentweb1/`) run fully independent environments

### Updating the Backend .env Secret

When backend environment variables change, an admin can update the stored secret:

```bash
aws secretsmanager put-secret-value \
  --secret-id agentweb/test-env/backend-env \
  --secret-string "$(cat backend/.env)" \
  --region us-west-2
```

### Notion-Triggered Dev Environments

Dev environments can be launched automatically from Notion. When a sprint item's status changes to "Start", the backend webhook launches an EC2 instance with hot-reload dev servers and Claude Code. Changing to "Done" tears it down.

This requires 3 additional Secrets Manager secrets beyond the existing ones:

#### 1. GitHub PAT (`agentweb/test-env/github-pat`)

A GitHub Personal Access Token used by the EC2 instance to `git clone` both repos.

**How to create:**
1. Go to https://github.com/settings/tokens?type=beta (fine-grained tokens)
2. Token name: `agentweb-test-env`
3. Expiration: **No expiration**
4. Repository access: "Only select repositories" → select `AgentWebPro/agentweb` and `AgentWebPro/agentweb-customer-portal`
5. Permissions → Repository permissions:
   - Contents: **Read and write** (clone, push branches, create commits)
   - Pull requests: **Read and write** (create and update PRs via `gh`)
6. Click "Generate token"
7. Copy the token (starts with `github_pat_...`)

#### 2. SSH Password (`agentweb/test-env/ssh-password`)

A password for `ec2-user` SSH access on auto-launched instances (no key pair needed).

**How to create:**
- Choose a strong password (16+ characters, mix of letters/numbers/symbols)
- This replaces SSH key pairs for Notion-triggered instances — developers SSH in with `ssh ec2-user@<IP>` and enter this password

#### 3. Notion Integration Token (`agentweb/test-env/notion-token`)

An internal Notion integration token used by both the backend (webhook handler) and EC2 instances (to fetch page title/content for Claude Code).

**How to create:**
1. Go to https://www.notion.so/my-integrations
2. Click "New integration"
3. Name: `AgentWeb Dev Env`
4. Associated workspace: your team workspace
5. Capabilities: **Read content**, **Update content**, **Insert content** (all checked)
6. Click "Submit"
7. Copy the "Internal Integration Secret" (starts with `ntn_...`)
8. **Configure webhook:**
   - In the integration settings, add a webhook URL:
     - **Testing:** `https://api-stage.agentweb.pro/api/webhooks/notion-dev-env`
     - **Production:** `https://api.agentweb.pro/api/webhooks/notion-dev-env`
   - Subscribe to event: **`page.properties_updated`**
   - Start with the staging URL, verify the full flow, then switch to production
9. **Connect to database:** Open the sprint database in Notion → click `...` menu → "Connections" → add the `AgentWeb Dev Env` integration

#### Uploading the secrets

Once you have all 3 values, upload them:

```bash
aws secretsmanager put-secret-value \
  --secret-id agentweb/test-env/github-pat \
  --secret-string 'YOUR_GITHUB_PAT' \
  --region us-west-2

aws secretsmanager put-secret-value \
  --secret-id agentweb/test-env/ssh-password \
  --secret-string 'YOUR_SSH_PASSWORD' \
  --region us-west-2

aws secretsmanager put-secret-value \
  --secret-id agentweb/test-env/notion-token \
  --secret-string 'YOUR_NOTION_TOKEN' \
  --region us-west-2
```

**Note:** The secret names must be created first by running `./test-env/setup-infra.sh` (which creates them with placeholder values).

#### Notion Database Setup

After secrets and integration are configured:
1. Add 3 text properties to the sprint database: `Instance ID`, `Public IP`, `SG ID`

#### Testing with ngrok

To test the webhook, run `ngrok http http://<TEST_ENV_IP>:3001` locally, then set the Notion integration webhook URL to `https://<ngrok-url>/api/webhooks/notion-dev-env`.

## Deployment to AWS Elastic Beanstalk

### Prerequisites

- AWS Account with Elastic Beanstalk permissions
- AWS Management Console access

### Frontend Deployment

1. Build the production version and create deployment package:

```bash
cd partner-portal && \
VITE_API_URL=https://api.agentweb.pro \
VITE_CUSTOMER_FRONTEND_URL=https://app.agentweb.pro \
VITE_DEBUG=false \
VITE_LIST_FULL_LLM_NAMES="azure->openai->gpt-4.1,google->google->gemini-2.5-pro-preview-05-06,azure->openai->gpt-4o,aws->anthropic->anthropic.claude-3-5-sonnet-20241022-v2:0,openai->openai->gpt-4o,aws->anthropic->us.anthropic.claude-3-7-sonnet-20250219-v1:0,google->google->gemini-2.5-flash,google->google->gemini-2.5-flash-lite,azure->openai->gpt-5-chat,google->google->gemini-2.5-pro" \
VITE_DEEP_RESEARCH_LLM_NAMES="azure->openai->o1-mini,azure->openai->gpt-4o" \
npm run build && \
DATE=$(date +%Y%m%d) && LABEL="partner-${DATE}-manual" && \
mkdir -p builds && \
zip -r "builds/${LABEL}.zip" dist package.json package-lock.json
```

2. Create a new application in Elastic Beanstalk:
   - Go to AWS Management Console > Elastic Beanstalk
   - Click "Create application"
   - Enter application name (e.g., "agentweb-frontend")
   - Choose "Node.js" as platform
   - Upload the zip file from `builds/`
   - Click "Create application"

Note: Environment variables must be set during build time for the frontend, as Vite replaces them at build time. Runtime environment variables in Elastic Beanstalk are not used by the frontend application.

### Customer Portal Deployment

**Note**: The Customer Portal is now a separate repository. Please refer to the [AgentWeb Customer Portal repository](https://github.com/AgentWebPro/agentweb-customer-portal) for deployment instructions.

1. Clone the customer portal repository:
```bash
git clone https://github.com/AgentWebPro/agentweb-customer-portal.git
cd agentweb-customer-portal
```

2. Build the production version and create deployment package:

```bash
VITE_API_URL=https://api.agentweb.pro \
VITE_PARTNER_PORTAL_URL=https://partner.agentweb.pro \
VITE_DEBUG=false \
npm run build && \
DATE=$(date +%Y%m%d) && LABEL="customer-${DATE}-manual" && \
mkdir -p builds && \
zip -r "builds/${LABEL}.zip" dist package.json package-lock.json server.js
```

3. Create a new application in Elastic Beanstalk:
   - Go to AWS Management Console > Elastic Beanstalk
   - Click "Create application"
   - Enter application name (e.g., "agentweb-customer-portal")
   - Choose "Node.js" as platform
   - Upload the zip file from `builds/`
   - Click "Create application"

Note: Environment variables must be set during build time for the frontend, as Vite replaces them at build time. Runtime environment variables in Elastic Beanstalk are not used by the frontend application.

### Growth Genius Chat Deployment

**Note**: The Growth Genius Chat is now a separate repository. Please refer to the [Growth Genius Chat repository](https://github.com/AgentWebPro/growth-genius-chat) for deployment instructions.

1. Clone the growth chat repository:
```bash
git clone https://github.com/AgentWebPro/growth-genius-chat.git
cd growth-genius-chat
```

2. Build the production version and create deployment package:

```bash
VITE_API_URL=https://api.agentweb.pro \
npm run build && \
DATE=$(date +%Y%m%d) && LABEL="growth-genius-${DATE}-manual" && \
mkdir -p builds && \
zip -r "builds/${LABEL}.zip" dist package.json package-lock.json server.js
```

3. Create a new application in Elastic Beanstalk:
   - Go to AWS Management Console > Elastic Beanstalk
   - Click "Create application"
   - Enter application name (e.g., "agentweb-growth-genius-chat")
   - Choose "Node.js" as platform
   - Upload the zip file from `builds/`
   - Click "Create application"

4. Configure environment variables:
   - In your environment, go to Configuration > Software
   - Click "Edit"
   - Add environment variables:
     - PORT = 3000
   - Click "Apply"
   - Wait for the environment update to complete

Note: Environment variables must be set during build time for the frontend, as Vite replaces them at build time. Runtime environment variables in Elastic Beanstalk are not used by the frontend application.

### Backend Deployment

1. Build the backend and create deployment package:

```bash
cd backend && \
npm run build && \
DATE=$(date +%Y%m%d) && LABEL="backend-${DATE}-manual" && \
mkdir -p builds && \
zip -r "builds/${LABEL}.zip" dist package.json package-lock.json .env.example .platform .ebextensions
```

### AWS Elastic Beanstalk Permissions

To grant a user permission to deploy to AWS Elastic Beanstalk, follow these steps:

1. Create an IAM User:

   - Go to IAM Console > Users > Add User
   - Enter username (e.g., "eb-deployer")
   - Select "Access key - Programmatic access"
   - Click "Next: Permissions"

2. Attach the Managed Policy:

   - Choose "Attach existing policies directly"
   - Search for "AdministratorAccess-AWSElasticBeanstalk"
   - Select the policy
   - Click "Next: Tags" (optional)
   - Click "Next: Review"
   - Click "Create User"

3. Save Credentials:
   - Download the CSV file containing the Access Key ID and Secret Access Key
   - Store these credentials securely
   - Configure AWS CLI with these credentials:
   ```bash
   aws configure
   AWS Access Key ID: [Your Access Key ID]
   AWS Secret Access Key: [Your Secret Access Key]
   Default region name: [Your AWS Region]
   Default output format: json
   ```

Note: The managed policy grants broad permissions for development purposes. Consider using more restrictive permissions in future.

2. Create a new application in Elastic Beanstalk:

   - Go to AWS Management Console > Elastic Beanstalk
   - Click "Create application"
   - Enter application name (e.g., "agentweb-backend")
   - Choose "Node.js" as platform
   - Upload the zip file from `builds/`
   - Click "Create application"

3. Configure environment variables:
   - In your environment, go to Configuration > Software
   - Click "Edit"
   - Add environment variables:
     - AWS_REGION = us-west-2
     - JWT_SECRET = <your-jwt-secret>
     - FRONTEND_URL = https://agentweb.pro
     - BACKEND_URL = https://api.agentweb.pro
     - CUSTOMER_FRONTEND_URL = https://customer.agentweb.pro
     - GROWTH_GENIUS_CHAT_URL = https://genius.agentweb.pro
     - SMTP_HOST = <your-smtp-host>
     - SMTP_PORT = <your-smtp-port>
     - SMTP_USER = <your-smtp-user>
     - SMTP_PASS = <your-smtp-password>
     - FROM_EMAIL = <your-from-email>
     - SITE_DOMAIN = https://agentweb.pro
     - ADMIN_EMAIL = <your-admin-email>
     - ADMIN_PASSWORD = <your-admin-password>
   - Click "Apply"
   - Wait for the environment update to complete

### Backend Deployment to AWS Elastic Beanstalk (Staging)

This section describes how to deploy the backend to AWS Elastic Beanstalk for staging purposes.

#### Prerequisites

- AWS Account with Elastic Beanstalk permissions
- AWS Management Console access

#### 1. Use the production build package

You can use the same build package created for production deployment:

```bash
# Reference the production build from the Backend Deployment section
# The build should already exist in builds/
```

If you haven't created the production build yet, follow the build instructions in the Backend Deployment section above.

#### 2. Create a staging application in Elastic Beanstalk

1. Go to AWS Management Console > Elastic Beanstalk
2. Click "Create application"
3. Enter application name (e.g., "agentweb-backend-stage")
4. Choose "Node.js" as platform
5. Upload the same zip file used for production from `builds/`
6. Click "Create application"

#### 3. Configure environment variables

1. In your environment, go to Configuration > Software
2. Click "Edit"
3. Add environment variables:
   - AWS_REGION = us-west-2
   - NODE_ENV = staging
   - JWT_SECRET = <your-staging-jwt-secret>
        - FRONTEND_URL = https://agentweb-frontend.lovable.app
     - BACKEND_URL = https://api-stage.agentweb.pro
     - CUSTOMER_FRONTEND_URL = https://customer-stage.agentweb.pro
     - GROWTH_GENIUS_CHAT_URL = https://genius-stage.agentweb.pro
     - SMTP_HOST = <your-smtp-host>
   - SMTP_PORT = <your-smtp-port>
   - SMTP_USER = <your-smtp-user>
   - SMTP_PASS = <your-smtp-password>
   - FROM_EMAIL = <your-from-email>
   - SITE_DOMAIN = https://agentweb-frontend.lovable.app
   - ADMIN_EMAIL = <your-admin-email>
   - ADMIN_PASSWORD = <your-admin-password>
4. Click "Apply"
5. Wait for the environment update to complete

#### 4. Configure domain name and HTTPS

1. Set up DNS in Route 53:

   - Go to AWS Route 53 console
   - Select your hosted zone (e.g., agentweb.pro)
   - Click "Create record"
   - Name: api-stage (this will create api-stage.agentweb.pro)
   - Type: A - IPv4 address
   - Choose "Alias" option
   - Route traffic to: Alias to Elastic Beanstalk environment
   - Select your region and Elastic Beanstalk environment
        - Click "Create records"

    - Create additional records for staging frontends:
    - Name: customer-stage (customer-stage.agentweb.pro)
    - Name: genius-stage (genius-stage.agentweb.pro)

2. Configure HTTPS in Elastic Beanstalk:
   - In your environment, go to Configuration
   - Under "Load balancer" (for load-balanced environments) or under "Network listener" (for single instances), click "Edit"
   - Add listener on port 443 with protocol HTTPS
   - Select your existing \*.agentweb.pro certificate
   - Save the configuration
   - Wait for the environment update to complete

After the changes propagate, both http://api-stage.agentweb.pro and https://api-stage.agentweb.pro should work properly.

Note: The staging frontends (customer-stage.agentweb.pro and genius-stage.agentweb.pro) will need their own Elastic Beanstalk environments and HTTPS configurations.

#### 5. Updating the staging deployment

When you need to update your staging environment:

1. Use the same updated production build package
2. Go to your staging application environment in Elastic Beanstalk
3. Click "Upload and deploy"
4. Choose the same zip file used for production
5. Enter a version label (e.g., "v0.22-stage")
6. Click "Deploy"

#### 6. Creating IAM User for Vendor Access to Staging Backend Load Logs

Create an AWS IAM user for vendor Argusoft to access CloudWatch logs via AWS Console UI:

1. **Create IAM Policy**:
   - Go to AWS IAM Console > Policies > Create policy > JSON tab
   - Paste this policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "elasticbeanstalk:DescribeEnvironments",
           "elasticbeanstalk:DescribeEnvironmentHealth",
           "elasticbeanstalk:DescribeEnvironmentResources",
           "elasticbeanstalk:DescribeInstancesHealth",
           "elasticbeanstalk:DescribeConfigurationSettings",
           "elasticbeanstalk:DescribeApplicationVersions",
           "elasticbeanstalk:DescribeApplications",
           "elasticbeanstalk:ListAvailableSolutionStacks",
           "elasticbeanstalk:DescribeEvents",
           "elasticbeanstalk:RetrieveEnvironmentInfo",
           "elasticbeanstalk:RequestEnvironmentInfo"
         ],
         "Resource": "*"
       },
       {
         "Effect": "Deny",
         "Action": [
           "elasticbeanstalk:UpdateEnvironment",
           "elasticbeanstalk:UpdateApplicationVersion",
           "elasticbeanstalk:UpdateConfigurationTemplate",
           "elasticbeanstalk:CreateConfigurationTemplate",
           "elasticbeanstalk:DeleteConfigurationTemplate",
           "elasticbeanstalk:ValidateConfigurationSettings",
           "elasticbeanstalk:ApplyEnvironmentManagedAction",
           "elasticbeanstalk:RestartAppServer",
           "elasticbeanstalk:RebuildEnvironment",
           "elasticbeanstalk:SwapEnvironmentCNAMEs",
           "elasticbeanstalk:TerminateEnvironment"
         ],
         "Resource": "*"
       },
       {
         "Effect": "Allow",
         "Action": [
           "logs:DescribeLogGroups",
           "logs:DescribeLogStreams",
           "logs:GetLogEvents",
           "logs:FilterLogEvents"
         ],
         "Resource": [
           "arn:aws:logs:*:*:log-group:/aws/elasticbeanstalk/*"
         ]
       },
       {
         "Effect": "Allow",
         "Action": [
           "logs:DescribeLogGroups"
         ],
         "Resource": "*"
       },
       {
         "Effect": "Allow",
         "Action": [
           "cloudtrail:LookupEvents",
           "cloudtrail:GetTrail",
           "cloudtrail:ListTrails",
           "cloudtrail:DescribeTrails"
         ],
         "Resource": "*"
       },
       {
         "Effect": "Allow",
         "Action": [
           "s3:ListBucket",
           "s3:GetObject",
           "s3:GetObjectAcl",
           "s3:PutObjectAcl"
         ],
         "Resource": [
           "arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572",
           "arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572/*"
         ]
       },
       {
         "Effect": "Allow",
         "Action": [
           "cloudformation:DescribeStacks",
           "cloudformation:DescribeStackResources",
           "cloudformation:DescribeStackResource",
           "cloudformation:ListStacks",
           "cloudformation:GetTemplate"
         ],
         "Resource": "*"
       },
       {
         "Effect": "Allow",
         "Action": [
           "autoscaling:DescribeAutoScalingGroups",
           "autoscaling:DescribeAutoScalingInstances",
           "autoscaling:DescribeLaunchConfigurations",
           "autoscaling:DescribeScalingActivities"
         ],
         "Resource": "*"
       }
     ]
   }
   ```

   **Note**: Elastic Beanstalk read actions require `"Resource": "*"` as they don't support fine-grained resource restrictions. However, all write/modify actions are explicitly denied, so Argusoft can only view information and cannot make any changes to any environment.

   - Name: `VendorStagingLogsAccess` > Create policy

2. **Create IAM User**:
   - Go to AWS IAM Console > Users > Add User
   - Username: `vendor-argusoft-access`
   - Select "AWS Management Console access"
   - Attach the `VendorStagingLogsAccess` policy
   - Create user and set password

3. **Share Access**:
   - Share the AWS Console sign-in URL (found in IAM > Dashboard > "IAM users sign-in link")
   - Share the username and password securely
   - Argusoft can:
     - View the staging environment page: Elastic Beanstalk > Environments > `Agentweb-backend-env-1` (read-only, no Configuration access)
     - Access logs via CloudWatch > Logs > Log groups (filter by `/aws/elasticbeanstalk/`)

### Setting Up Oncall Alerts for Elastic Beanstalk Services

This section describes how to set up monitoring and oncall alerts when Elastic Beanstalk services become unhealthy.

#### Prerequisites

- AWS Account with CloudWatch and SNS permissions
- Access to AWS Management Console
- Email address for receiving alerts

#### 1. Create CloudWatch Alarms for Elastic Beanstalk Health

For each Elastic Beanstalk environment (backend, frontend, customer-portal, growth-genius-chat), create health monitoring alarms directly in the Elastic Beanstalk console:

1. **Go to Elastic Beanstalk Console**:
   - Navigate to [Elastic Beanstalk Console](https://console.aws.amazon.com/elasticbeanstalk/)
   - Select your environment (e.g., `agentweb-backend`)

2. **Navigate to Alarms**:
   - In the left navigation pane, click **Alarms** (under the Monitoring section)
   - Click **Create alarm** button

3. **Configure Alarm for Environment Health**:
   - **Period**: Select **5 minutes** from the dropdown
     - This is the evaluation period for the metric
   - **Change state after**: Select **5 minutes** from the dropdown
     - **This is the key setting**: The alarm will only change state (trigger) after the unhealthy condition persists for 5 minutes
     - This prevents false alarms from temporary glitches
   - **Threshold**: 
     - Select **<** (less than) from the dropdown
     - Enter `-1` in the text field
     - Health status values: `1` = Ok, `0` = Warning, `-1` = Degraded, `-2` = Severe
     - **This alarm will trigger only when health is Severe** (value is -2, which is less than -1)
     - This means you'll only be alerted for the most critical issues, not warnings or degraded states
   - **Notify**: 
     - Select **Create a new SNS topic** from the dropdown
   - **Topic name**: Enter `agentweb-oncall-alerts` (or your preferred name)
   - **Email**: Enter the email address for oncall notifications (e.g., `founders@agentweb.pro`)
     - The SNS topic and email subscription will be created automatically
     - You'll need to confirm the email subscription by clicking the link in the confirmation email
   - **Notify when state changes to**: 
     - Check **Alarm** (required - this sends notification when environment becomes unhealthy)
     - Uncheck **Ok** (optional - you typically don't need notifications when it recovers)
     - Uncheck **Insufficient data** (optional - only needed if you want alerts for missing metrics)

4. **Create the Alarm**:
   - Review the alarm configuration
   - Click **Create alarm** button (orange button at bottom right)
   - The alarm will be created and the SNS topic will be set up automatically

**Note on configuration**: 
- **Threshold of `-1`**: This alarm will only trigger when the environment health is **Severe** (value -2), not for Warning or Degraded states. This ensures you're only alerted for the most critical issues.
- **5-minute delay**: The "Change state after" setting of 5 minutes means the alarm will only trigger after the environment has been in Severe status for 5 consecutive minutes. This helps reduce false alarms while still alerting you to sustained critical issues. If you want immediate alerts, set this to `1 minute` instead.

### Agent Engine Deployment to Google Cloud VM

This section describes how to deploy the agent-engine on a single Google Cloud VM instance, suitable for development, testing, or lower-scale production use.

#### Prerequisites

- Google Cloud Platform account
- gcloud CLI installed and configured
- SSH client

#### 1. VM Instance Setup

##### Option A: Using Google Cloud Console (UI)

1. Access Google Cloud Console

   - Go to https://console.cloud.google.com
   - Select or create a project
   - Click "New Project" if needed
   - Enter project name and click "CREATE"

2. Enable Required APIs

   - Navigate to "APIs & Services" > "Dashboard"
   - Click "+ ENABLE APIS AND SERVICES"
   - Search for and enable "Compute Engine API"

3. Create VM Instance

   - Go to "Compute Engine" > "VM instances"
   - Click "CREATE INSTANCE"
   - Configure the following settings:

   **Basic Settings:**

   - Name: `agent-engine`
   - Region: `us-west-1` (or preferred region)
   - Machine type: `e2-standard-4` (4 vCPU, 16 GB memory)
     - For cost optimization, start with `e2-standard-2`

   **Boot Disk:**

   - Operating System: `Ubuntu` or `Debian`
   - Version: `Ubuntu 24.04 LTS` or `Debian/GNU Linux 12`
   - Size: `100 GB`
   - Type: `Standard persistent disk`

   **Note:** After increasing the disk size in Google Cloud Console, simply reboot the instance:

   ```bash
   sudo reboot
   ```

   The disk resize will be handled automatically after reboot.

   **Identity and Security:**

   - Service account: `Compute Engine default service account`
   - Access scopes: `Allow default access`
   - Enable Secure Boot, vTPM, and Integrity Monitoring

   **Networking:**

   - Default settings (only outbound connections needed)

4. Launch and Connect
   - Click "CREATE" and wait for deployment
   - Click "SSH" in the VM instances list to connect

#### 2. System Dependencies

````bash
# Update package list
sudo apt-get update

# Install Chrome dependencies
sudo apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils

# Install Playwright-specific dependencies
# For Ubuntu:
sudo apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0t64 \
    libatk-bridge2.0-0t64 \
    libcups2t64 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2t64 \
    libatspi2.0-0t64

# For Debian:
# First, enable additional repositories
sudo sed -i 's/^deb \(.*\) bookworm main$/deb \1 bookworm main contrib non-free/' /etc/apt/sources.list
sudo apt-get update

# Install dependencies
sudo apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libgstreamer1.0-0 \
    libgtk-4-1 \
    libgraphene-1.0-0 \
    libatomic1 \
    libxslt1.1 \
    libvpx7 \
    libopus0 \
    libgstreamer-plugins-base1.0-0 \
    libflite1 \
    libwebpdemux2 \
    libavif15 \
    libharfbuzz-icu0 \
    libwebpmux3 \
    libenchant-2-2 \
    libsecret-1-0 \
    libhyphen0 \
    libmanette-0.2-0 \
    libx264-164 \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    gstreamer1.0-tools \
    gstreamer1.0-x \
    gstreamer1.0-alsa \
    gstreamer1.0-gl \
    gstreamer1.0-gtk3 \
    gstreamer1.0-qt5 \
    gstreamer1.0-pulseaudio

# Install additional browser dependencies
sudo apt-get install -y \
    fonts-liberation \
    fonts-dejavu \
    xvfb \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils

# Install build dependencies for WOFF2
sudo apt-get install -y \
    build-essential \
    cmake \
    git \
    pkg-config \
    libbrotli-dev

# Build and install WOFF2 from source
cd /tmp
git clone https://github.com/google/woff2.git
cd woff2
git submodule update --init --recursive
mkdir build
cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make
sudo make install
sudo ldconfig

#### 3. Python Environment Setup

```bash
# Install Miniconda
wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -O ~/miniconda.sh
bash ~/miniconda.sh -b -p $HOME/miniconda
eval "$($HOME/miniconda/bin/conda shell.bash hook)"
conda init

# Restart your shell or run:
source ~/.bashrc
````

#### 4. Agent Engine Setup

```bash
# Install Git (if not already installed)
sudo apt-get update
sudo apt-get install -y git

# Clone repository
git clone https://github.com/AgentWebPro/agentweb.git

# Create and activate Conda environment
cd agentweb/agent-engine
conda env create -f environment.yml
conda activate agent-engine

# Install Playwright browsers
playwright install

# Create a .env file for environment variables
cat > .env << EOF
# Google Gemini API key for image generation
GOOGLE_IMAGE_API_KEY=your_google_image_api_key_here


# Other environment variables as needed
EOF

**Note**: Make sure to replace `your_google_image_api_key_here` with your actual Google Gemini API key.

**Image Model Configuration**: Image models are now configured through the database via the partner portal admin interface. The default image model and supported models are managed centrally and don't require environment variable updates.

#### 5. Running the Agent Engine

```bash
# Ensure you're in the correct directory and environment
cd ~/agentweb/agent-engine
conda activate agent-engine

# Set display to VNC server (display :1)
export DISPLAY=:1
# If vpc not working, use xvfb
Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &
export DISPLAY=:99

# Start the agent engine
python task_monitor.py
```

#### Maintenance

For system updates:

```bash
sudo apt-get update
sudo apt-get upgrade -y
```

For agent-engine updates:

```bash
cd ~/agentweb
git pull
conda env update -f environment.yml --prune
pip install -r requirements.txt
```

#### Troubleshooting

If you encounter browser initialization errors:

1. Make sure VNC server is running: `ps aux | grep vnc`
2. Check if DISPLAY is set: `echo $DISPLAY`
3. Restart VNC server if needed:

   ```bash
   # Kill current VNC server
   vncserver -kill :1

   # Start VNC server again
   tigervncserver :1 -geometry 1920x1080 -depth 24

   # Set display and restart Agent Engine
   export DISPLAY=:1
   python task_monitor.py
   ```

**VNC Server Restart Instructions:**

```bash
# Stop current VNC server
vncserver -kill :1

# Start VNC server again
tigervncserver :1 -geometry 1920x1080 -depth 24

# Verify VNC server is running
ps aux | grep vnc

# Check VNC port is listening
netstat -tlnp | grep 5901
```

#### GUI Access Setup (Optional)

Some AgentWeb features require GUI access for browser automation. To enable GUI access on your Debian/GNU Linux 12 Google Cloud VM:

##### Option 1: VNC Client (Recommended for Production)

1. **Install VNC Server**

   ```bash
   # Install TigerVNC server
   sudo apt-get update
   sudo apt-get install -y tigervnc-standalone-server tigervnc-common

   # Install xterm terminal
   sudo apt-get install -y xterm
   ```

2. **Configure VNC**

   ```bash
   # Set VNC password
   vncpasswd
   ```

3. **Start VNC Server**

   ```bash
   # Start VNC server on display :1 (standard VNC port 5901)
   # For local access only (default):
   tigervncserver :1 -geometry 1920x1080 -depth 24 -xstartup /usr/bin/xterm

   # For remote access (allows connections from any IP):
   tigervncserver :1 -geometry 1920x1080 -depth 24 -xstartup /usr/bin/xterm -localhost=0
   ```

   **Important**: Use display `:1` to use the standard VNC port 5901. This allows you to see the browser automation in action.

   **Note**: The `-localhost=0` flag disables the localhost-only restriction and allows remote connections. Without this flag, VNC will only accept connections from localhost, which works for local testing but not for remote access.

4. **Coordinate with Agent Engine**

   ```bash
   # If Agent Engine is already running, stop it first
   pkill -f task_monitor.py

   # Start VNC server first (display :1)
   tigervncserver :1 -geometry 1920x1080 -depth 24 -xstartup /usr/bin/xterm -localhost=0

   # Then start Agent Engine (it will use the same display :1)
   cd ~/agentweb/agent-engine
   conda activate agent-engine
   export DISPLAY=:1
   python task_monitor.py
   ```

5. **Configure Firewall Rules**

   - In Google Cloud Console, go to "VPC network" > "Firewall"
   - Create a new firewall rule:
     - Name: `vnc-access`
     - Network: `default`
     - Priority: `1000`
     - Direction: `Ingress`
     - Action: `Allow`
     - Targets: `Specified target tags`
     - Target tags: `agentengine-vnc-access`
     - Source IP ranges: `0.0.0.0/0` (or your specific IP for security)
     - Protocols and ports: `tcp:5901` (for display :1)
   - Click "Create"

6. **Add Network Tag to VM Instance**

   - In Google Cloud Console, go to "Compute Engine" > "VM instances"
   - Click on your agent-engine instance
   - Click "Edit"
   - Under "Networking" section, add the network tag: `agentengine-vnc-access`
   - Click "Save"
   - The instance will be restarted to apply the network changes

7. **Connect with VNC Client**

   - **Windows**: Download RealVNC Viewer or TightVNC
   - **macOS**: Download RealVNC Viewer (https://www.realvnc.com/en/connect/download/viewer/)
     - **Note**: macOS Screen Sharing can connect but has limited keyboard input support
     - **Recommended**: Use RealVNC Viewer for full functionality
   - **Linux**: `sudo apt-get install tigervnc-viewer`
   - Connect to: `your-vm-external-ip:5901` (port 5901 for display :1)
   - Enter the VNC password you set with `vncpasswd`

8. **Test Connection**

   ```bash
   # Test if VNC port is accessible (from your local machine)
   # For display :1, use port 5901
   curl -v telnet://your-vm-external-ip:5901

   # Example:
   curl -v telnet://34.168.173.176:5901
   ```

**Note**: VNC Client (Option 1) is recommended for production use as it provides more reliable and secure access without browser limitations.

**VNC Port Mapping**:

- Display `:1` uses port `5901`
- Display `:99` uses port `5999`
- General rule: Display `:N` uses port `5900 + N`

## Repository CI/CD (GitHub Actions)

This repository includes CI (build verification) and CD (deploy) workflows for `backend` and `partner-portal` in `.github/workflows/`:

- `tests.yml` — Runs on Pull Requests touching `backend/**` or `partner-portal/**`
  - Detects which project changed and runs only the relevant jobs
  - Builds the projects to verify compilation
  - Uses the runner's default Node version (no explicit `node-version`)
  - **Staging Deployment**: After backend tests pass, automatically deploys backend to staging environment
  - **Note**: Unit tests are not run in CI - run them locally before submitting PRs (see [Testing](#testing) section)

- `deploy.yml` — Handles production deployments:
  - **Production deployment**: Runs on push to `main` or when a PR is merged to `main`
    - Detects which project changed via path filters and runs only the relevant jobs
    - No version bump required — deploys automatically when files change in `backend/` or `partner-portal/`
    - Builds production bundles and deploys to AWS Elastic Beanstalk production environments
    - Build artifacts use the naming format `<component>-yyyymmdd-pr<number>` (e.g., `backend-20260218-pr42`)
  - **Staging deployment (Backend only)**: Runs automatically after backend tests pass successfully on a Pull Request (in `tests.yml`)
    - Deploys backend to staging environment for testing before merging to `main`
    - Only deploys if tests pass - ensures code quality before staging deployment
    - Staging backend URL: `https://api-stage.agentweb.pro`
    - Version labels use the format `backend-yyyymmdd-pr<PR_NUMBER>`
    - Allows developers to test backend changes in staging
    - **Frontend testing**: Partner Portal and Customer Portal should be run locally pointing to staging backend (see [Local Development with Staging Backend](#local-development-with-staging-backend))

### Required GitHub configuration for deployments

Configure the following for GitHub Actions (Settings → Secrets and variables → Actions):

- **Secrets** (sensitive):
  - **Repository-level secrets** (used as fallback, but environment secrets take precedence):
    - `AWS_ACCESS_KEY_ID` — AWS access key for the `github-actions-deploy-backend` IAM user
    - `AWS_SECRET_ACCESS_KEY` — AWS secret key for the `github-actions-deploy-backend` IAM user
  - **Note**: Production and staging use different access keys, but both are from the same IAM user `github-actions-deploy-backend`

- **Variables** (non-sensitive, easier to manage):
  - **Production:**
    - `EB_BACKEND_APPLICATION_NAME` — Elastic Beanstalk application name for backend
    - `EB_BACKEND_ENVIRONMENT_NAME` — Elastic Beanstalk environment name for backend
    - `EB_PARTNER_APPLICATION_NAME` — Elastic Beanstalk application name for partner-portal
    - `EB_PARTNER_ENVIRONMENT_NAME` — Elastic Beanstalk environment name for partner-portal
  - **Staging:**
    - `EB_BACKEND_STAGING_APPLICATION_NAME` — Elastic Beanstalk application name for backend staging.
    - `EB_BACKEND_STAGING_ENVIRONMENT_NAME` — Elastic Beanstalk environment name for backend staging.

- **Environments** (Settings → Environments):
  - Create a `staging` environment in GitHub repository settings
    - Go to Settings → Environments → New environment
    - Name it `staging`
    - **Configure AWS Secrets in the staging environment:**
      - Click on the `staging` environment
      - Under "Environment secrets", add:
        - `AWS_ACCESS_KEY_ID` — Staging AWS access key ID for the `github-actions-deploy-backend` IAM user
        - `AWS_SECRET_ACCESS_KEY` — Staging AWS secret access key for the `github-actions-deploy-backend` IAM user
      - **Note**: These are different credentials from production, but both are from the same IAM user `github-actions-deploy-backend`
      - **Note**: Environment secrets override repository secrets, so you must configure them at the environment level when using `environment: staging`
    - Optionally configure environment protection rules
  - The `prod` environment should already exist (used by production deployments)
    - **Configure AWS Secrets in the prod environment:**
      - Click on the `prod` environment
      - Under "Environment secrets", ensure:
        - `AWS_ACCESS_KEY_ID` — Production AWS access key ID for the `github-actions-deploy-backend` IAM user
        - `AWS_SECRET_ACCESS_KEY` — Production AWS secret access key for the `github-actions-deploy-backend` IAM user
      - **Note**: These are different credentials from staging, but both are from the same IAM user `github-actions-deploy-backend`

The workflows use region `us-west-2` by default. Update `AWS_REGION` in the workflow if needed, or add a repository variable `AWS_REGION` to override.

### Production build and packaging (used by workflows)

- Partner Portal build mirrors the manual steps:
  - Environment variables set at build time via the workflow
  - Package contents: `dist`, `package.json`, `package-lock.json`

- Backend build mirrors the manual steps:
  - `npm run build`
  - Package contents: `dist`, `package.json`, `package-lock.json`, `.env.example`, `.platform` (if present)

### Deployment behavior

- **Production deployments:**
  - Version labels in Elastic Beanstalk: `<component>-yyyymmdd-pr<number>` (e.g., `backend-20260218-pr42`, `partner-20260218-pr42`)
  - Artifacts uploaded to S3 bucket: `elasticbeanstalk-<region>-992382574572/builds/*`
  - Deploys automatically when files change in `backend/` or `partner-portal/` (no version bump required)
  - Deploys to production environments configured in GitHub Actions

- **Staging deployments (Backend only):**
  - Version labels in Elastic Beanstalk: `backend-yyyymmdd-pr<PR_NUMBER>`
  - Artifacts uploaded to S3 bucket: `elasticbeanstalk-<region>-992382574572/builds/*`
  - Deploys automatically after tests pass on PR push
  - Only deploys if backend tests succeed - ensures code quality
  - Staging backend URL: `https://api-stage.agentweb.pro`
  - Allows developers to test backend changes in staging before merging to `main`
  - **Note**: Partner Portal and Customer Portal should be run locally pointing to staging backend (see [Local Development with Staging Backend](#local-development-with-staging-backend))

### Staging Deployment Workflow

When you create or update a Pull Request that touches `backend/**`:

1. **Tests Run First**: The workflow automatically runs backend tests (build verification)
2. **Staging Deployment After Tests Pass**: If tests pass successfully, the workflow automatically deploys to staging environment
3. **No Version Bump Required**: Deployments are triggered by file changes, not version bumps
4. **Test Your Backend Changes**: Once deployed, the staging backend is available at `https://api-stage.agentweb.pro`
5. **Version Labels**: Each deployment uses a unique label including the date and PR number (e.g., `backend-20260218-pr123`)
6. **Production Deployment**: After your PR is merged to `main`, production deployment will run automatically if `backend/` or `partner-portal/` files changed

**Note**: Staging deployment only runs if backend tests pass. If tests fail, staging deployment is skipped to prevent deploying broken code.

**Note**: Staging deployments use the same AWS credentials as production, but deploy to separate staging Elastic Beanstalk environments configured via GitHub repository variables.

### Local Development with Staging Backend

For frontend development (Partner Portal and Customer Portal), run the applications locally and point them to the staging backend:

#### Partner Portal - Local Development with Staging

Navigate to the partner-portal directory and run:

```bash
cd partner-portal
VITE_API_URL=https://api-stage.agentweb.pro VITE_CUSTOMER_FRONTEND_URL=http://localhost:5174 VITE_DEBUG=true npm run dev
```

The partner portal will be available at `http://localhost:5173` and will connect to the staging backend at `https://api-stage.agentweb.pro`.

#### Customer Portal - Local Development with Staging

Navigate to the customer-portal directory and run:

```bash
cd customer-portal
VITE_API_URL=https://api-stage.agentweb.pro VITE_PARTNER_PORTAL_URL=http://localhost:5173 VITE_DEBUG=true npm run dev
```

The customer portal will be available at `http://localhost:5174` and will connect to the staging backend at `https://api-stage.agentweb.pro`.

**Benefits of this approach:**
- Faster iteration: No need to wait for frontend deployments
- Easy testing: Test frontend changes immediately against staging backend
- Cost effective: No need for separate staging frontend environments
- Flexible: Developers can test different frontend configurations easily

### PRs from forks

The tests workflow requests minimal permissions so forked PRs can read PR metadata:

```
permissions:
  contents: read
  pull-requests: read
```

No additional configuration is needed in most cases.

# How to kill backend
lsof -ti:3001 | xargs kill -9 2>/dev/null && echo "✅ Backend killed" || echo "ℹ️ No backend process running on port 3001"

## PixelFlow Form Tracking Verification

How to verify that a customer's website has PixelFlow form submission tracking properly configured.

Reference: https://docs.pixelflow.so/articles/event-classes-on-html-websites-4c49z

### What to check

1. **Base script installed** - The page should load the PixelFlow snippet with a valid `apiKey`, `siteId`, and `apiEndpoint`:

```html
<script>
!(function(p,i,x,f,l,o,w){
  p["PixelFlowObject"]=f;
  p[f]=p[f]||function(){(p[f].q=p[f].q||[]).push(arguments);};
  p[f].l=1*new Date();
  o=i.createElement(x);w=i.getElementsByTagName(x)[0];
  o.src=l;o.async=1;
  p[f].apiKey="<SITE_API_KEY>";
  p[f].siteId="<SITE_ID>";
  p[f].apiEndpoint="https://api.pixelflow.so/event";
  w.parentNode.insertBefore(o,w);
})(window,document,"script","pixelFlow","https://<subdomain>.pixelflow.so/pfm.js");
</script>
```

2. **Required CSS classes on form elements** - The following PixelFlow event classes must be present in the HTML:

| Element | Required Class | Purpose |
|---|---|---|
| Form or wrapper `<div>` | `info-frm-cntr-pf` | Identifies the form container |
| Submit button | `action-btn-lead-011-pf` | Triggers the lead capture event |
| Email input | `info-cust-em-pf` | Extracts the submitted email |
| First name input | `info-cust-fn-pf` | Extracts first name (if applicable) |
| Last name input | `info-cust-ln-pf` | Extracts last name (if applicable) |
| Phone input | `info-cust-ph-pf` | Extracts phone number (if applicable) |

For registration/signup forms, use `action-btn-reg-007-pf` on the submit button instead of `action-btn-lead-011-pf`.

### How to check

1. Open the site in a browser and open DevTools (F12).
2. **Verify script is loaded**: In the Network tab, filter by `pfm.js` and confirm it loads successfully (HTTP 200).
3. **Verify event classes**: In the Elements tab, inspect the form and check that:
   - The `<form>` or its wrapper has `info-frm-cntr-pf` in its class list.
   - The submit `<button>` has `action-btn-lead-011-pf` in its class list.
   - The email `<input>` has `info-cust-em-pf` in its class list.
4. **Verify events fire**: In the Network tab, filter by `api.pixelflow.so`. Submit the form and confirm a request is sent to the event endpoint with the form data.

If any of the classes in step 3 are missing, form submissions will **not** be tracked by PixelFlow even if the base script is installed.

## Steps to Set Up a Facebook Developer App for Instagram

### 1. Create / Open Facebook Developer App

Go to the [Facebook Developer Portal](https://developers.facebook.com/).
Create a new app or open the existing one.

### 2. Add Instagram Product

If Instagram is not already added, click **"Add Product"**.
Select **Instagram** and complete the setup.

### 3. Configure Instagram API with Instagram Login

- After adding the Instagram product, you will see Instagram in the left sidebar.
- Click on **API Setup with Instagram Login**.
- Under this section, you will find:
  - **Instagram App ID**
  - **Instagram App Secret**

### 4. Update Application Secrets

Add the following values under:

```
prod/AgentWeb/MetaApp
```

Map them as:
- `instagramClientId` → Instagram App ID
- `instagramClientSecret` → Instagram App Secret

### 5. Set Up Instagram Business Login

In the **Set Up Instagram Business Login** section, configure the redirect URL:

```
{base_url}/api/oauth/instagram/callback
```
