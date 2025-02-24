# Agent Engine

This is the web automation engine for AgentWeb, powered by the browser-use library. It executes web automation tasks based on natural language prompts.

## Setup

### Using Conda (Recommended)

1. Create and activate the Conda environment:
```bash
# Create the environment from environment.yml
conda env create -f environment.yml

# Activate the environment
conda activate agent-engine
```

2. Make the agent script executable:
```bash
chmod +x web_agent.py
```

### Alternative Setup (pip)

If you prefer not to use Conda, you can install dependencies directly with pip:
```bash
pip install -r requirements.txt
```

### Production Deployment on EC2

1. Launch an EC2 instance:
   - Recommended: t2.medium or larger
   - Ubuntu Server AMI
   - Security Group: Allow inbound SSH (port 22)

2. Install system dependencies:
```bash
# Access the instance using SSH
ssh -i agent-engine/agent-engine-keypair.pem ubuntu@54.201.66.162

# Update system packages
sudo apt-get update -y
sudo apt-get upgrade -y

# Install Python and development tools
sudo apt-get install -y python3.12-venv python3-pip git

# Install Playwright system dependencies
sudo apt-get install -y libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2t64 libatspi2.0-0t64 libxcursor1 libgtk-3-0t64 libpangocairo-1.0-0 \
    libcairo-gobject2 libgdk-pixbuf-2.0-0 libgtk-4-1 libvulkan1 libgraphene-1.0-0 \
    libwoff1 libvpx9 libevent-2.1-7t64 libopus0 gstreamer1.0-alsa gstreamer1.0-gl \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly flite1-dev libwebp7 libavif16 libharfbuzz-icu0 \
    libwebpmux3 libenchant-2-2 libsecret-1-0 libhyphen0 libmanette-0.2-0 libgles2
```

3. Set up Python environment and install Playwright:
```bash
# Create and activate virtual environment
python3 -m venv ~/venv
source ~/venv/bin/activate

# Install Playwright
pip install playwright
playwright install
```

4. Clone and setup the repository:
```bash
# Clone the repository
git clone https://github.com/john-the-dev/agentweb.git
cd agentweb/agent-engine

# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

5. Configure environment variables:
```bash
# Copy example env file
cp .env.example .env

# Edit the .env file with your production credentials
nano .env
```

6. Setup systemd service for automatic startup:
```bash
# Create systemd service file
sudo tee /etc/systemd/system/agent-engine.service << EOF
[Unit]
Description=Agent Engine Service
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/agentweb/agent-engine
Environment=PATH=/home/ubuntu/venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/ubuntu/venv/bin/python task_monitor.py
Restart=always
RestartSec=10

# Resource controls
CPUQuota=80%
CPUWeight=50
MemoryLimit=1G
TasksMax=100

# Nice value to lower CPU priority (higher number = lower priority)
Nice=10

[Install]
WantedBy=multi-user.target
EOF

# Start and enable the service
sudo systemctl daemon-reload
sudo systemctl start agent-engine
sudo systemctl enable agent-engine
```

7. Monitor the service:
```bash
# Check service status
sudo systemctl status agent-engine

# View logs
sudo journalctl -u agent-engine -f

# Monitor CPU usage
top -p $(pgrep -f "task_monitor.py")
```

8. Performance Tuning:
   - Monitor CPU usage with `top` or `htop`
   - Adjust CPUQuota in the service file if needed (50% to 80% recommended)
   - Use `nice` command to lower process priority if running manually:
     ```bash
     nice -n 10 python3 task_monitor.py
     ```
   - Consider using process pools for parallel task execution
   - Implement rate limiting for task processing
   - Add appropriate sleep intervals between task checks

9. Additional Production Considerations:
   - Set up CloudWatch monitoring for the EC2 instance
   - Configure automated backups
   - Set up alerts for service failures
   - Use AWS Secrets Manager for sensitive credentials
   - Consider using an Elastic IP for stable addressing
   - Set up log rotation for service logs

## Architecture

The agent engine consists of:

1. **Web Agent Script** (`web_agent.py`)
   - Handles browser automation using browser-use
   - Parses natural language prompts into actions
   - Executes actions in sequence
   - Reports results back to the main application

2. **Action Types**
   - Login: Handle website authentication
   - Search: Perform search operations
   - Download: Download files and content

## Usage

The agent is typically called from the main application, but you can also test it directly:

```bash
./web_agent.py --task_id <task_id> --prompt "your task prompt here"
```

## Development

To extend the agent's capabilities:

1. Add new action types in `web_agent.py`
2. Enhance the prompt parsing logic
3. Add error recovery mechanisms
4. Implement new browser automation features

### Environment Management

To update dependencies:

1. Add new packages to `environment.yml`
2. Update the environment:
```bash
conda env update -f environment.yml
```

## Integration

The agent engine integrates with the main application through:

1. Command-line interface
2. JSON-formatted output
3. Status updates via exit codes
4. Detailed error reporting

## Components

### Task Monitor (`task_monitor.py`)

The task monitor is responsible for:
1. Monitoring pending task executions
2. Processing scheduled tasks
3. Managing task execution lifecycle
4. Sending notifications to task owners and subscribers

Key features:
- Queries for pending executions using timestamp optimization
- Handles scheduled tasks (daily, weekly, monthly)
- Updates execution statuses and results
- Comprehensive error handling and logging
- Sends different types of notifications:
  - Simple completion notifications to task owners
  - Detailed run results to task subscribers

Example usage:
```python
# The monitor runs continuously, checking for:
# 1. Due schedules to create new executions
# 2. Pending executions to process
python task_monitor.py
```

### Performance Optimization

To manage CPU usage and system resources:

1. **Sleep Intervals**
```python
# Add appropriate sleep intervals between checks
import time

TASK_CHECK_INTERVAL = 5  # seconds
SCHEDULE_CHECK_INTERVAL = 60  # seconds

def monitor_tasks():
    while True:
        process_pending_tasks()
        time.sleep(TASK_CHECK_INTERVAL)

def monitor_schedules():
    while True:
        process_due_schedules()
        time.sleep(SCHEDULE_CHECK_INTERVAL)
```

2. **Resource Management**
```python
# Limit concurrent tasks
MAX_CONCURRENT_TASKS = 3
TASK_TIMEOUT = 300  # seconds

# Use a process pool for parallel execution
from multiprocessing import Pool

def process_tasks(tasks):
    with Pool(MAX_CONCURRENT_TASKS) as pool:
        results = pool.map_async(execute_task, tasks)
        results.wait(timeout=TASK_TIMEOUT)
```

3. **Rate Limiting**
```python
# Implement rate limiting for API calls
from ratelimit import limits, sleep_and_retry

CALLS = 30
RATE_LIMIT_PERIOD = 60

@sleep_and_retry
@limits(calls=CALLS, period=RATE_LIMIT_PERIOD)
def rate_limited_api_call():
    # Your API call here
    pass
```

4. **Memory Management**
```python
# Clear memory periodically
import gc

def cleanup_resources():
    gc.collect()
```

5. **Monitoring**
```python
# Add resource usage logging
import psutil
import logging

def log_resource_usage():
    process = psutil.Process()
    logging.info(f"CPU Usage: {process.cpu_percent()}%")
    logging.info(f"Memory Usage: {process.memory_info().rss / 1024 / 1024} MB")
```

### Email Notifications (`email_utils.py`)

The email utilities handle different types of notifications:

1. Task Owner Notifications
   - Simple completion notifications
   - Sent when emailNotification is enabled for the task
   - Includes basic status and link to task details

2. Subscriber Notifications
   - Detailed task run results
   - Sent to all task subscribers
   - Includes:
     - Task execution timestamps
     - Run duration
     - Detailed results or error messages
     - Link to task details

Example subscriber email:
```
Task Run Results for "Your Task Name"
===================================

Status: COMPLETED
Started: January 15, 2024 at 02:30 PM UTC
Completed: January 15, 2024 at 02:35 PM UTC
Duration: 5 minutes

Results Summary:
---------------
[Detailed task results]

View complete task details and history:
http://localhost:3000/tasks/123456
```

### Azure OpenAI Configuration
- `AZURE_OPENAI_ENDPOINT`: Your Azure OpenAI service endpoint URL
- `AZURE_OPENAI_API_KEY`: Your Azure OpenAI API key
- `AZURE_OPENAI_API_VERSION`: API version (defaults to '2024-08-01-preview')
- `AZURE_OPENAI_MODEL`: Model to use (defaults to 'gpt-4o')
- `AZURE_OPENAI_DEPLOYMENT`: Optional deployment name (if not set, uses 'agentweb')

## Database Schema

### AW-TaskExecutions
- Primary Key: `executionId` (String)
- GSI: StatusStartTimeIndex
  - Hash Key: `status` (String)
  - Range Key: `startTime` (String)
- Attributes:
  - `taskId` (String)
  - `userId` (String)
  - `status` (String): pending, running, completed, failed
  - `result` (String, optional)
  - `error` (String, optional)
  - `completedAt` (String, optional)

### AW-Subscribers
- Primary Key: Composite key of `taskId` (Hash) and `email` (Range)
- Attributes:
  - `taskId` (String)
  - `email` (String)
  - `subscribedAt` (String)

### AW-TaskSchedules
- Primary Key: `scheduleId` (String)
- GSI: StatusStartTimeIndex
  - Hash Key: `status` (String)
  - Range Key: `nextRunTime` (String)
- GSI: TaskIdIndex
  - Hash Key: `taskId` (String)
- Attributes:
  - `userId` (String)
  - `frequency` (String): daily, weekly, monthly
  - `status` (String): active, paused

## Unit Tests

The test suite (`tests/test_task_monitor.py`) covers the core functionality of the task monitor:

### Running Tests
```bash
# Activate conda environment
conda activate agent-engine

# Run tests with verbose output
python -m unittest tests/test_task_monitor.py -v
```

### Test Coverage

1. Execution Monitoring
   - `test_get_pending_executions_no_last_time`: Tests basic execution querying
   - `test_get_pending_executions_with_last_time`: Tests timestamp optimization
   - `test_create_execution`: Validates execution creation
   - `test_update_execution_status`: Tests status updates for success/failure

2. Schedule Management
   - `test_get_due_schedules`: Tests schedule querying
   - `test_update_schedule_next_run_time`: Tests next run time calculations
     - Daily schedules: Next day at 9:00 AM
     - Weekly schedules: Next week at 9:00 AM
     - Monthly schedules: Next month at 9:00 AM

### Adding New Tests

To add new tests:
1. Add test methods to `TestTaskMonitor` class in `tests/test_task_monitor.py`
2. Use `@patch` decorators to mock DynamoDB interactions
3. Follow existing patterns for setup and assertions

Example:
```python
@patch('task_monitor.executions_table')
def test_new_feature(self, mock_table):
    # Setup test data
    mock_table.query.return_value = {'Items': [...]}
    
    # Call function
    result = your_function()
    
    # Verify behavior
    self.assertEqual(result, expected_result)
    mock_table.query.assert_called_once_with(...)
```