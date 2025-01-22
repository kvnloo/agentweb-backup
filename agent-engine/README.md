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

Key features:
- Queries for pending executions using timestamp optimization
- Handles scheduled tasks (daily, weekly, monthly)
- Updates execution statuses and results
- Comprehensive error handling and logging

Example usage:
```python
# The monitor runs continuously, checking for:
# 1. Due schedules to create new executions
# 2. Pending executions to process
python task_monitor.py
```

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