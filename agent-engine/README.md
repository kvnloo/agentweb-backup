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

### Environment Variables

The agent-engine supports custom email senders via Resend and scheduled chat processing. To enable these features:

1. **Resend Email Integration** - Set the `RESEND_API_KEY` environment variable:
```bash
export RESEND_API_KEY=your_resend_api_key_here
```

2. **Scheduled Chat Integration** - Set the `BACKEND_URL` environment variable:
```bash
export BACKEND_URL=http://localhost:3001
```

3. Or add them to your `.env` file:
```
RESEND_API_KEY=your_resend_api_key_here
BACKEND_URL=http://localhost:3001
```

- Get your Resend API key from [Resend API Keys](https://resend.com/api-keys)
- The `BACKEND_URL` should point to your AgentWeb backend API server

### Alternative Setup (pip)

You can install dependencies directly with pip:
```bash
pip install -r requirements.txt
```

## Running the Agent Engine

The main entry point for the agent engine is `task_monitor.py`. This script handles all task execution, scheduling, and monitoring:

```bash
# Make sure you're in the agent-engine directory
cd agent-engine

# Activate the conda environment if not already activated
conda activate agent-engine

# Start the agent engine
python task_monitor.py
```

## Scheduled Chat Processing

The agent-engine now automatically processes scheduled chats alongside regular task schedules. When the agent-engine detects scheduled chat schedules that are due to run, it will:

1. **Detect Scheduled Chats**: Query the `AW-TaskSchedules` table for schedules with `type = 'scheduled_chat'`
2. **Trigger Backend Processing**: Make an API call to the backend's `/api/agent-mode/run-scheduled-chats` endpoint
3. **Log Results**: Display detailed logs of successful and failed scheduled chat executions

### How It Works

- The agent-engine runs every 5 seconds and checks for due schedules
- Regular task schedules are processed locally by creating task executions
- Scheduled chat schedules trigger the backend API to handle the chat processing
- Both types of schedules get their `nextRunTime` updated after processing

### Configuration

Make sure to set the `BACKEND_URL` environment variable to point to your AgentWeb backend:

```bash
export BACKEND_URL=http://localhost:3001
```

## Testing Gemini Integration

The project includes a test script for Google's Gemini model integration. To run the tests:

1. Set up your Gemini API key in the environment:
```bash
# Add to your .env file
GEMINI_API_KEY=your_api_key_here
```

2. Run the basic test (tests basic Gemini functionality):
```bash
python test_gemini.py
```

3. Run the browser-use test (tests Gemini with web automation):
```bash
python test_gemini.py --browser-use
```

4. Test with a specific Gemini model:
```bash
python test_gemini.py --model "google->google->gemini-2.5-pro-exp-03-25"
```

5. Test browser-use with a specific model:
```bash
python test_gemini.py --browser-use --model "google->google->gemini-2.5-pro-exp-03-25"
```

The test script includes:
- Basic Gemini model testing
- Browser automation testing
- Function calling examples
- Support for different Gemini models

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

### Running Tests

The agent engine includes unit tests to ensure functionality works as expected. To run the tests:

1. Activate the conda environment:
```bash
conda activate agent-engine
```

2. Run all tests:
```bash
python run_tests.py
```

3. Run a specific test file:
```bash
python -m unittest tests/test_validate_content_format.py
```

4. Run standalone tests (no dependencies):
```bash
python tests/test_validate_content_format_standalone.py
```

#### Available Tests

- `test_validate_content_format.py`: Tests for the content format validation function
- `test_task_monitor.py`: Tests for the task monitoring functionality

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

# Upgrade a python package
pip install --upgrade <package_name, e.g., browser use>

# To reverse a python package to a specific version
pip install <package_name, e.g., browser use>==<version>
