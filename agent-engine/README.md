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

2. Install dependencies:
Make sure your `requirements.txt` includes the Google Cloud libraries:
```txt
google-cloud-aiplatform
google-cloud-discoveryengine
google-cloud-storage
```
Then run:
```bash
pip install -r requirements.txt
```

### Google Cloud Knowledge Base Setup (Vertex AI Search)

To use the integrated knowledge base powered by Google Cloud Vertex AI Search, you need to perform the following setup in your Google Cloud Project and configure environment variables for the Agent Engine.

**1. Google Cloud Project Setup:**

   a.  **Create/Select a Google Cloud Project.**
   b.  **Enable APIs:**
       -   Vertex AI API
       -   Discovery Engine API
   c.  **Create a Google Cloud Storage (GCS) Bucket:** This bucket will store the raw knowledge files (e.g., `your-agentweb-kb-bucket`).
   d.  **Create a Vertex AI Search App & Datastore:**
       -   In the Google Cloud Console, navigate to Vertex AI Search.
       -   Create a new "Search App" (select "Generic" or other appropriate type).
       -   Within this app, create a new "Datastore".
           -   **Type:** Select "Unstructured data".
           -   **Datastore name:** Give it a descriptive name (e.g., `agentweb-knowledge-store`).
           -   **Data source:** Configure it to use your GCS bucket (created in step 1c) as the data source. You can specify a folder within the bucket if desired (this would correspond to `GOOGLE_KB_GCS_PREFIX`).
           -   Vertex AI Search will then start indexing your data from GCS.
       -   Note down your **Project ID**, the **Datastore ID**, and the **Location** (e.g., `global`, `us`, `eu`).
   e.  **Create a Service Account:**
       -   In IAM & Admin > Service Accounts, create a new service account.
       -   Grant this service account the following roles (or more granular permissions as needed):
           -   `Vertex AI User` (for general Vertex AI access)
           -   `Discovery Engine Viewer` (to query datastores)
           -   `Storage Object Admin` (or `Storage Object Creator` & `Storage Object Viewer`) on the GCS bucket used for the knowledge base.
       -   Download the **JSON key** for this service account.

**2. Environment Variables for Agent Engine:**

   Create or update a `.env` file in the `agent-engine` directory with the following:

   ```env
   # Google Cloud Settings for Knowledge Base
   GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/service-account-key.json"
   GOOGLE_CLOUD_PROJECT_ID="your-gcp-project-id"
   GOOGLE_VERTEX_AI_DATASTORE_ID="your-datastore-id"
   GOOGLE_VERTEX_AI_SEARCH_LOCATION="your-datastore-location" # e.g., global, us, eu
   GOOGLE_KB_GCS_BUCKET="your-agentweb-kb-bucket"
   GOOGLE_KB_GCS_PREFIX="agent_knowledge/" # Optional: folder within the bucket. Ensure it ends with a '/' if used.

   # Existing variables (ensure these are also present if needed)
   # GEMINI_API_KEY=your_gemini_api_key_if_used_directly
   # AZURE_OPENAI_ENDPOINT=...
   # AZURE_OPENAI_API_KEY=...
   # ... other S3 related env vars if used for screenshots etc.
   S3_BUCKET_NAME="your-s3-bucket-for-other-files" # If S3 is still used for screenshots/GIFs
   ```

   - Replace placeholders with your actual values.
   - Ensure the `GOOGLE_KB_GCS_PREFIX` matches the folder you configured in the Vertex AI Search Datastore if you used one.

### Alternative Setup (pip without Conda)

If not using Conda, you can install dependencies directly with pip after ensuring Python 3.8+ is installed:
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
