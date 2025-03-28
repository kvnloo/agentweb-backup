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

### Frontend Setup for Development

1. Install dependencies:
```bash
cd frontend
npm install
```

2. Configure environment variables:
- Create a `.env` file in the `frontend` directory:
```
VITE_API_URL=http://localhost:3001
```

3. Start the development server:
```bash
npm run dev
```

The application will be available at http://localhost:5173

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
├── backend/
│   ├── src/
│   │   ├── routes/      # API routes
│   │   ├── services/    # Database and business logic
│   │   └── utils/       # Utility functions
│   └── scripts/         # Database setup scripts
└── frontend/
    └── src/
        ├── components/  # React components
        ├── contexts/    # React contexts
        └── pages/       # Page components
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
SMTP_HOST=your_smtp_host
SMTP_PORT=your_smtp_port
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
FROM_EMAIL=your_from_email
ADMIN_EMAIL=your_admin_email
ADMIN_PASSWORD=your_admin_password
```

Frontend Production:
- Create a `.env` file in the `frontend` directory:
```
VITE_API_URL=https://agentweb.pro
```

## Deployment to AWS Elastic Beanstalk

### Prerequisites
- AWS Account with Elastic Beanstalk permissions
- AWS Management Console access

### Frontend Deployment

1. Build the production version and create deployment package:
```bash
cd frontend && \
VITE_API_URL=https://api.agentweb.pro \
VITE_DEBUG=false \
VITE_LIST_FULL_LLM_NAMES="azure->openai->gpt-4o,aws->anthropic->anthropic.claude-3-5-sonnet-20241022-v2:0,openai->openai->gpt-4o,aws->anthropic->us.anthropic.claude-3-7-sonnet-20250219-v1:0,google->google->gemini-2.0-flash,google->google->gemini-2.5-pro-exp-03-25" \
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

### Backend Deployment

1. Build the backend and create deployment package:
```bash
cd backend && \
npm run build && \
VERSION="0.21" && \
mkdir -p builds && \
zip -r "builds/deploy_v${VERSION}.zip" dist package.json package-lock.json .env.example
```

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

### Agent Engine Deployment

The agent engine should be deployed as a separate service using AWS ECS (Elastic Container Service) due to its Python dependencies and browser automation requirements. See the agent-engine directory for specific deployment instructions.

### Important Notes

1. CORS Configuration:
   - Update the CORS settings in the backend to allow requests from your frontend domain
   - Update the API URL in the frontend to point to your backend domain

2. Database:
   - Ensure your DynamoDB tables are created in the same region
   - Configure proper IAM roles for Elastic Beanstalk to access DynamoDB
     - Go to IAM > Roles
     - Find your Elastic Beanstalk role
     - Attach the necessary DynamoDB policies

3. Security:
   - Use environment variables for all sensitive information
   - Enable HTTPS:
     - In your environment, go to Configuration > Load balancer
     - Add a listener for port 443
     - Configure SSL certificate
   - Configure security groups through the Elastic Beanstalk environment settings

4. Monitoring:
   - Set up CloudWatch alarms through the Elastic Beanstalk monitoring page
   - Configure proper logging in the environment's configuration panel

5. Cost Management:
   - Choose t3.micro instances for development in the capacity settings
   - Configure auto-scaling rules in the capacity section
   - Monitor costs through AWS Cost Explorer

For detailed troubleshooting and advanced configuration options, refer to the [AWS Elastic Beanstalk documentation](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/Welcome.html).

## Upgrade AG2
pip install --upgrade ag2
pip install 'ag2[openai]'
