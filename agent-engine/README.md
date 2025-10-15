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

The agent engine includes comprehensive unit tests to ensure functionality works as expected. All test files are organized under the `tests/` directory.

#### Prerequisites

1. Activate the conda environment:
```bash
conda activate agent-engine
```

2. Ensure all dependencies are installed:
```bash
pip install -r requirements.txt
```

#### Running All Tests

Run the complete test suite:
```bash
# Run the test runner script (recommended)
python run_tests.py

# Or run all tests with verbose output
python -m unittest discover tests/ -v
```

**Note**: Some tests may require specific environment variables or external dependencies. Use the test runner script for better error handling and organized output.

#### Running Specific Test Categories

**Browser-Use Integration Tests:**
```bash
# Test browser-use library integration and compatibility
python -m unittest tests.test_browser_use_integration -v

# Verify browser-use upgrade
python tests/verify_browser_use_upgrade.py
```

**Core Functionality Tests:**
```bash
# Test task monitoring functionality
python -m unittest tests.test_task_monitor -v

# Test task utilities
python -m unittest tests.test_task_utils -v

# Test content validation
python -m unittest tests.test_validate_content_format -v
```

**AI Model Integration Tests:**
```bash
# Test Gemini integration
python tests/test_gemini.py

# Test Gemini with browser automation
python tests/test_gemini.py --browser-use

# Test Azure GPT image generation
python -m unittest tests.test_azure_gpt_image -v

# Test image generation
python -m unittest tests.test_image_generation -v
```

**File Processing Tests:**
```bash
# Test file upload functionality
python -m unittest tests.test_file_upload -v

# Test downloads functionality
python -m unittest tests.test_downloads -v

# Test SVG conversion
python -m unittest tests.test_svg_conversion -v
```

**Standalone Tests (No Dependencies):**
```bash
# Run standalone content validation tests
python tests/test_validate_content_format_standalone.py
```

#### Available Test Files

**Core Functionality:**
- `test_task_monitor.py`: Tests for task monitoring and scheduling
- `test_task_utils.py`: Tests for task utility functions
- `test_validate_content_format.py`: Tests for content format validation
- `test_validate_content_format_standalone.py`: Standalone validation tests

**Browser-Use Integration:**
- `test_browser_use_integration.py`: Comprehensive browser-use library tests
- `test_browser_use_upgrade.py`: Browser-use upgrade verification
- `verify_browser_use_upgrade.py`: Conda environment verification

**AI Model Integration:**
- `test_gemini.py`: Google Gemini model integration tests
- `test_azure_gpt_image.py`: Azure GPT image generation tests
- `test_image_generation.py`: Image generation functionality tests
- `test_image_model.py`: Image model configuration tests
- `test_pld_deepseek.py`: DeepSeek model integration tests

**File Processing:**
- `test_file_upload.py`: File upload functionality tests
- `test_downloads.py`: Download functionality tests
- `test_svg_conversion.py`: SVG conversion tests
- `test_file_has_relative_images.py`: Relative image handling tests

**Other Features:**
- `test_knowledge_base.py`: Knowledge base functionality tests
- `test_autogen.py`: AutoGen integration tests
- `test_extract_page_content.py`: Page content extraction tests
- `test_extract_json_from_content.py`: JSON extraction tests

#### Test Configuration

**Environment Variables for Testing:**
```bash
# Required for AI model tests
export GEMINI_API_KEY=your_gemini_api_key
export AZURE_OPENAI_API_KEY=your_azure_api_key
export AZURE_OPENAI_ENDPOINT=your_azure_endpoint

# Required for backend integration tests
export BACKEND_URL=http://localhost:3001

# Optional for email tests
export RESEND_API_KEY=your_resend_api_key
```

**Test Data:**
- Test files and sample data are located in the `tests/` directory
- Mock data is generated automatically for most tests
- Some tests require specific test files (see individual test files for details)

#### Adding New Tests

To add new tests:

1. Create a new test file in the `tests/` directory:
```bash
touch tests/test_new_feature.py
```

2. Follow the existing test patterns:
```python
import unittest
from unittest.mock import Mock, patch
import sys
import os

# Add the parent directory to the path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

class TestNewFeature(unittest.TestCase):
    def setUp(self):
        """Set up test fixtures."""
        pass
    
    def test_feature_functionality(self):
        """Test the new feature."""
        # Your test code here
        self.assertTrue(True)
    
    def tearDown(self):
        """Clean up after tests."""
        pass

if __name__ == '__main__':
    unittest.main()
```

3. Run your new test:
```bash
python -m unittest tests.test_new_feature -v
```

#### Test Coverage

The test suite covers:
- ✅ Core task monitoring and scheduling functionality
- ✅ Browser automation and web scraping
- ✅ AI model integrations (Gemini, Azure GPT, DeepSeek)
- ✅ File processing and upload/download functionality
- ✅ Content validation and extraction
- ✅ Error handling and edge cases
- ✅ API integrations and external services

#### Test Status

**Working Tests:**
- ✅ `test_validate_content_format_standalone.py` - Content validation tests
- ✅ `test_browser_use_integration.py` - Browser-use library integration
- ✅ `verify_browser_use_upgrade.py` - Browser-use upgrade verification

**Tests Requiring Updates:**
- ⚠️ `test_task_monitor.py` - Some tests may need environment setup
- ⚠️ `test_task_utils.py` - Function signatures may have changed
- ⚠️ AI model tests - Require API keys and external dependencies

**Running Individual Tests:**
```bash
# Run a specific working test
python -m unittest tests.test_validate_content_format_standalone -v

# Run browser-use verification
python tests/verify_browser_use_upgrade.py

# Run browser-use integration tests
python -m unittest tests.test_browser_use_integration.TestBrowserUseIntegration.test_action_result_creation -v
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

## Test Organization

All test files are organized under the `tests/` directory for better maintainability and discoverability. The test suite includes comprehensive coverage of all major functionality areas.

## Production Upgrades

### Browser-Use Library Upgrade

When upgrading the browser-use library in production, follow these steps to ensure a smooth transition:

#### 1. Pre-Upgrade Testing

Before upgrading in production, test the new version in a staging environment:

```bash
# 1. Create a backup of current environment
conda env export > environment_backup.yml

# 2. Test the upgrade in a separate environment
conda create -n agent-engine-test python=3.12
conda activate agent-engine-test
pip install -r requirements.txt

# 3. Run comprehensive tests
python run_tests.py

# 4. Test specific browser-use functionality
python -c "
from browser_use import Agent, Controller
from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContextConfig
print('✅ Browser-use imports successful')
print('✅ All components accessible')
"
```

#### 2. Production Upgrade Steps

```bash
# 1. Stop the agent engine
pkill -f task_monitor.py

# 2. Backup current environment
conda env export > environment_backup_$(date +%Y%m%d_%H%M%S).yml

# 3. Update browser-use to latest version
conda activate agent-engine
pip install --upgrade browser-use
# Note: The [memory] extra is no longer needed in browser-use 0.8.1+

# 4. Verify the upgrade
pip show browser-use | grep Version

# 5. Run tests to ensure compatibility
python run_tests.py

# 6. Restart the agent engine
python task_monitor.py
```

#### 3. Rollback Procedure

If issues occur after upgrade:

```bash
# 1. Stop the agent engine
pkill -f task_monitor.py

# 2. Rollback to previous version
pip install browser-use==<previous_version>

# 3. Restore environment if needed
conda env update -f environment_backup_<timestamp>.yml

# 4. Restart the agent engine
python task_monitor.py
```

#### 4. Monitoring After Upgrade

Monitor the following after upgrade:

- **Logs**: Check for any new warnings or errors
- **Cookie functionality**: Verify cookies are loading/saving correctly
- **Memory system**: Ensure no database errors occur
- **Task execution**: Monitor task success rates

#### 5. Known Issues and Solutions

**Issue**: Memory database errors (`old_history` table, `prev_value` column)
**Solution**: Run the memory fix script:
```bash
python memory_fix_v2.py
```

**Issue**: Cookie files not loading
**Solution**: Check cookie file paths and permissions:
```bash
# Check cookie file exists and is readable
ls -la context/*_cookies.json
```

**Issue**: Import errors after upgrade
**Solution**: Reinstall all dependencies:
```bash
pip install --force-reinstall -r requirements.txt
```

### General Package Upgrades

# Upgrade a python package
pip install --upgrade <package_name, e.g., browser use>

# To reverse a python package to a specific version
pip install <package_name, e.g., browser use>==<version>
