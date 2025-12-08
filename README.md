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

#### 4. Store Credentials in AWS Secrets Manager

Store your Google Search API credentials in AWS Secrets Manager:

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
   - The agent should now use real Google search results

#### 6. API Quotas and Limits

- **Free Tier**: 100 searches per day
- **Paid Tier**: Up to 10,000 searches per day for $5
- **Rate Limits**: 10 requests per second

#### 7. Troubleshooting

**Common Issues:**

1. **"API key not valid"**:
   - Check that the API key is correct in AWS Secrets Manager
   - Ensure Custom Search API is enabled in Google Cloud Console
   - Verify API key restrictions

2. **"Search engine not found"**:
   - Verify the Search Engine ID is correct in AWS Secrets Manager
   - Check that the search engine is active in Google Custom Search Engine

3. **"Secrets Manager access denied"**:
   - Ensure your AWS credentials have permissions to access Secrets Manager
   - Check that the secret names match exactly: `dev/AgentWeb/Google/Search` or `prod/AgentWeb/Google/Search`
   - Verify the secret contains valid JSON with `apiKey` and `searchEngineId` fields

4. **"Quota exceeded"**:
   - Check your daily quota usage in Google Cloud Console
   - Consider upgrading to paid tier if needed

5. **No search results**:
   - The system will fall back to mock results if the API fails
   - Check the backend logs for error messages

**Fallback Behavior:**
- If Google Search API credentials are not found in Secrets Manager or the API fails, the system automatically falls back to mock search results
- This ensures Agent Mode continues to work even without the API configured

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
- Secret Value (JSON format, shared across all users who don’t have their own Webflow config):
```json
{
  "apiToken": "your_webflow_api_token",
  "siteId": "your_webflow_site_id",
  "collectionId": "your_webflow_collection_id"
}
```

**For Production (global):**
- Secret Name: `prod/AgentWeb/Webflow`
- Secret Value (JSON format, shared across all users who don’t have their own Webflow config):
```json
{
  "apiToken": "your_webflow_api_token",
  "siteId": "your_webflow_site_id",
  "collectionId": "your_webflow_collection_id"
}
```

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

Notes:
- When a `userId` is provided, the backend will **only** read from `dev/AgentWeb/Webflow/<user_id>` or `prod/AgentWeb/Webflow/<user_id>` and will **not** fall back to the global secret.
- When no `userId` is provided (legacy flows), the global secret (`dev/AgentWeb/Webflow` or `prod/AgentWeb/Webflow`) is used.

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
VERSION="0.21" && \
mkdir -p builds && \
zip -r "builds/deploy_v${VERSION}.zip" dist package.json package-lock.json
```

2. Create a new application in Elastic Beanstalk:
   - Go to AWS Management Console > Elastic Beanstalk
   - Click "Create application"
   - Enter application name (e.g., "agentweb-frontend")
   - Choose "Node.js" as platform
   - Upload the versioned zip file from `builds/deploy_v${VERSION}.zip`
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
VERSION="0.21" && \
mkdir -p builds && \
zip -r "builds/deploy_v${VERSION}.zip" dist package.json package-lock.json server.js
```

3. Create a new application in Elastic Beanstalk:
   - Go to AWS Management Console > Elastic Beanstalk
   - Click "Create application"
   - Enter application name (e.g., "agentweb-customer-portal")
   - Choose "Node.js" as platform
   - Upload the versioned zip file from `builds/deploy_v${VERSION}.zip`
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
VERSION="0.21" && \
mkdir -p builds && \
zip -r "builds/deploy_v${VERSION}.zip" dist package.json package-lock.json server.js
```

3. Create a new application in Elastic Beanstalk:
   - Go to AWS Management Console > Elastic Beanstalk
   - Click "Create application"
   - Enter application name (e.g., "agentweb-growth-genius-chat")
   - Choose "Node.js" as platform
   - Upload the versioned zip file from `builds/deploy_v${VERSION}.zip`
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
VERSION="0.21" && \
mkdir -p builds && \
zip -r "builds/deploy_v${VERSION}.zip" dist package.json package-lock.json .env.example .platform .ebextensions
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
   - Upload your versioned zip file from `builds/deploy_v${VERSION}.zip`
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
# The build should already exist at: builds/deploy_v${VERSION}.zip
```

If you haven't created the production build yet, follow the build instructions in the Backend Deployment section above.

#### 2. Create a staging application in Elastic Beanstalk

1. Go to AWS Management Console > Elastic Beanstalk
2. Click "Create application"
3. Enter application name (e.g., "agentweb-backend-stage")
4. Choose "Node.js" as platform
5. Upload the same versioned zip file used for production from `builds/deploy_v${VERSION}.zip`
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
  - Version rule for PRs: the `package.json` version in the PR must be the same or higher than the base branch
  - Builds the projects to verify compilation
  - Uses the runner's default Node version (no explicit `node-version`)
  - **Staging Deployment**: After backend tests pass, automatically deploys backend to staging environment
  - **Note**: Unit tests are not run in CI - run them locally before submitting PRs (see [Testing](#testing) section)

- `deploy.yml` — Handles both production and staging deployments:
  - **Production deployment**: Runs on push to `main` or when a PR is merged to `main`
    - Detects which project changed and runs only the relevant jobs
    - Version rule for deploys: deploys only if the new version is strictly higher than the previous commit
    - Builds production bundles using the same commands documented below
    - Packages versioned zip files and deploys to AWS Elastic Beanstalk production environments
  - **Staging deployment (Backend only)**: Runs automatically after backend tests pass successfully on a Pull Request
    - Deploys backend to staging environment for testing before merging to `main`
    - Only deploys if tests pass - ensures code quality before staging deployment
    - No version bump required - deploys on any PR push with backend changes (after tests pass)
    - Staging backend URL: `https://api-stage.agentweb.pro`
    - Version labels include PR number: `backend_v<version>-staging-pr<PR_NUMBER>`
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
  - Version labels in Elastic Beanstalk:
    - Backend: `backend_v<package.json version>`
    - Partner Portal: `partner_v<package.json version>`
  - Artifacts uploaded to S3 bucket: `elasticbeanstalk-<region>-992382574572/builds/*`
  - The deploy job will no-op if the version is the same or lower than the previous commit
  - Deploys to production environments configured in GitHub Actions

- **Staging deployments (Backend only):**
  - Version labels in Elastic Beanstalk:
    - Backend: `backend_v<package.json version>-staging-pr<PR_NUMBER>`
  - Artifacts uploaded to S3 bucket: `elasticbeanstalk-<region>-992382574572/builds/*`
  - Deploys automatically after tests pass on PR push (no version bump required)
  - Only deploys if backend tests succeed - ensures code quality
  - Staging backend URL: `https://api-stage.agentweb.pro`
  - Allows developers to test backend changes in staging before merging to `main`
  - **Note**: Partner Portal and Customer Portal should be run locally pointing to staging backend (see [Local Development with Staging Backend](#local-development-with-staging-backend))

### Staging Deployment Workflow

When you create or update a Pull Request that touches `backend/**`:

1. **Tests Run First**: The workflow automatically runs backend tests (build verification, version checks)
2. **Staging Deployment After Tests Pass**: If tests pass successfully, the workflow automatically deploys to staging environment
3. **No Version Bump Required**: Unlike production, staging deployments don't require version bumps - they deploy on any PR push (after tests pass)
4. **Test Your Backend Changes**: Once deployed, the staging backend is available at `https://api-stage.agentweb.pro`
5. **Version Labels**: Each staging deployment uses a unique version label including the PR number (e.g., `backend_v1.0.0-staging-pr123`)
6. **Production Deployment**: After your PR is merged to `main`, production deployment will run automatically (if version was bumped)

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
