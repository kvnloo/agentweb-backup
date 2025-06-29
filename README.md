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

### Frontend Setup for Development

1. Install dependencies:
```bash
cd partner-portal
npm install
```

2. Configure environment variables:
- Create a `.env` file in the `partner-portal` directory:
```
VITE_API_URL=http://localhost:3001
```

3. Start the development server:
```bash
npm run dev
```

The frontend development server will be available at:
- Local access: http://localhost:5173
- Network access: http://[your-ip-address]:5173

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
└── partner-portal/
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

## Deployment to AWS Elastic Beanstalk

### Prerequisites
- AWS Account with Elastic Beanstalk permissions
- AWS Management Console access

### Frontend Deployment

1. Build the production version and create deployment package:
```bash
cd partner-portal && \
VITE_API_URL=https://api.agentweb.pro \
VITE_DEBUG=false \
VITE_LIST_FULL_LLM_NAMES="azure->openai->gpt-4.1,google->google->gemini-2.5-pro-preview-05-06,azure->openai->gpt-4o,aws->anthropic->anthropic.claude-3-5-sonnet-20241022-v2:0,openai->openai->gpt-4o,aws->anthropic->us.anthropic.claude-3-7-sonnet-20250219-v1:0,google->google->gemini-2.0-flash,google->google->gemini-2.5-pro-preview-03-25" \
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

1. Build the production version and create deployment package:
```bash
cd customer-portal && \
VITE_API_URL=https://api.agentweb.pro \
VITE_DEBUG=false \
npm run build && \
VERSION="0.1" && \
mkdir -p builds && \
zip -r "builds/deploy_v${VERSION}.zip" dist package.json package-lock.json server.js
```

2. Create a new application in Elastic Beanstalk:
   - Go to AWS Management Console > Elastic Beanstalk
   - Click "Create application"
   - Enter application name (e.g., "agentweb-customer-portal")
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

2. Configure HTTPS in Elastic Beanstalk:
   - In your environment, go to Configuration
   - Under "Load balancer" (for load-balanced environments) or under "Network listener" (for single instances), click "Edit"
   - Add listener on port 443 with protocol HTTPS
   - Select your existing *.agentweb.pro certificate
   - Save the configuration
   - Wait for the environment update to complete

After the changes propagate, both http://api-stage.agentweb.pro and https://api-stage.agentweb.pro should work properly.

#### 5. Updating the staging deployment

When you need to update your staging environment:

1. Use the same updated production build package
2. Go to your staging application environment in Elastic Beanstalk
3. Click "Upload and deploy"
4. Choose the same zip file used for production
5. Enter a version label (e.g., "v0.22-stage")
6. Click "Deploy"

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

```bash
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
```

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
```

#### 5. Running the Agent Engine

```bash
# Ensure you're in the correct directory and environment
cd ~/agentweb/agent-engine
conda activate agent-engine

# Set display to VNC server (display :1)
export DISPLAY=:1

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
     - Targets: `All instances in the network`
     - Source IP ranges: `0.0.0.0/0` (or your specific IP for security)
     - Protocols and ports: `tcp:5901` (for display :1)
   - Click "Create"

6. **Connect with VNC Client**
   - **Windows**: Download RealVNC Viewer or TightVNC
   - **macOS**: Download RealVNC Viewer (https://www.realvnc.com/en/connect/download/viewer/)
     - **Note**: macOS Screen Sharing can connect but has limited keyboard input support
     - **Recommended**: Use RealVNC Viewer for full functionality
   - **Linux**: `sudo apt-get install tigervnc-viewer`
   - Connect to: `your-vm-external-ip:5901` (port 5901 for display :1)
   - Enter the VNC password you set with `vncpasswd`

7. **Test Connection**
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