#!/usr/bin/env python3
import asyncio
import boto3
import os
import json
import uuid
import logging
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
from web_agent import WebAgent
from botocore.exceptions import ClientError
import time
from decimal import Decimal
import humanize  # Add this import at the top of the file
from pathlib import Path
from aws_utils import get_dynamodb_resource, get_s3_client
import yaml
import random
from typing import Dict, Any, List, Optional
from deep_research_agent import DeepResearchAgentWrapper  # Import the wrapper class
from task_utils import upload_activity_log, upload_gif, check_new_information, LogSyncManager, start_log_sync  # Import utility functions
import subprocess
import tempfile
import shutil
import re
import traceback
import threading
import resource
from email_utils import get_task_subscribers
import requests

# Increase file descriptor limit
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
resource.setrlimit(resource.RLIMIT_NOFILE, (min(hard, 4096), hard))

# Custom JSON encoder to handle datetime objects
class DateTimeEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        return super().default(obj)

def json_dumps(obj):
    """Helper function to dump JSON with datetime handling"""
    return json.dumps(obj, cls=DateTimeEncoder, indent=2)

# Load environment variables
load_dotenv()

# Get table prefix based on NODE_ENV
TABLE_PREFIX = 'Dev-' if os.getenv('NODE_ENV') == 'development' else ''

# Create log directory if it doesn't exist
os.makedirs('log', exist_ok=True)

# Configure root logger
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('log/task_monitor.log')
    ]
)

# Configure browser-use logger
browser_use_logger = logging.getLogger('browser_use')
browser_use_logger.setLevel(logging.INFO)
# Ensure browser-use logs go to our handlers
for handler in logging.getLogger().handlers:
    browser_use_logger.addHandler(handler)

# Configure agent logger
agent_logger = logging.getLogger('agent')
agent_logger.setLevel(logging.INFO)
# Ensure agent logs go to our handlers
for handler in logging.getLogger().handlers:
    agent_logger.addHandler(handler)

# Set our logger
logger = logging.getLogger(__name__)

# Set environment variable for browser-use logging level
os.environ['BROWSER_USE_LOGGING_LEVEL'] = 'info'

# Initialize DynamoDB client
dynamodb = get_dynamodb_resource()

# Initialize tables with environment-specific prefixes
executions_table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskExecutions')
tasks_table = dynamodb.Table(f'{TABLE_PREFIX}AW-Tasks')
schedules_table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskSchedules')
users_table = dynamodb.Table(f'{TABLE_PREFIX}AW-Users')

logger.info(f"Initialized with environment: {os.getenv('NODE_ENV', 'production')}")
logger.info(f"Using table prefix: {TABLE_PREFIX}")

# Add last_execution_time as a module-level variable
last_execution_time = None
running_task_count = 0
running_user_ids = set()
running_task_ids = {}  # Dictionary to track running task IDs and their types
running_processes = {}  # Dictionary to track execution_id -> process handle

def get_pending_executions():
    global last_execution_time
    try:
        query_params = {
            'IndexName': 'StatusStartTimeIndex',
            'KeyConditionExpression': '#status = :status',
            'ExpressionAttributeNames': {
                '#status': 'status'
            },
            'ExpressionAttributeValues': {
                ':status': 'pending'
            }
        }

        # Add startTime condition if we have a last timestamp
        if last_execution_time:
            query_params['KeyConditionExpression'] += ' AND #startTime > :startTime'
            query_params['ExpressionAttributeNames']['#startTime'] = 'startTime'
            query_params['ExpressionAttributeValues'][':startTime'] = last_execution_time

        response = executions_table.query(**query_params)
        return response.get('Items', [])
    except ClientError as e:
        logger.error(f"Error querying pending executions: {e}")
        return []

def get_due_schedules():
    try:
        now = datetime.now(timezone.utc).isoformat()
        response = schedules_table.query(
            IndexName='StatusStartTimeIndex',
            KeyConditionExpression='#status = :status AND #nextRunTime <= :now',
            ExpressionAttributeNames={
                '#status': 'status',
                '#nextRunTime': 'nextRunTime'
            },
            ExpressionAttributeValues={
                ':status': 'active',
                ':now': now
            }
        )
        items = response.get('Items', [])
        if len(items) > 0:
            logger.info(f"Found {len(items)} due schedules: {json_dumps(items)}")
        return items
    except ClientError as e:
        logger.error(f"Error querying due schedules: {e}")
        return []

def create_execution(task_id, user_id, prompt=None, workflow_execution_id=None):
    try:
        execution_id = str(int(time.time() * 1000))  # Use timestamp as ID
        execution = {
            'executionId': execution_id,
            'taskId': task_id,
            'userId': user_id,
            'status': 'pending',
            'startTime': datetime.now(timezone.utc).isoformat(),
            'prompt': prompt
        }
        if workflow_execution_id:
            execution['workflowExecutionId'] = workflow_execution_id
        executions_table.put_item(Item=execution)
        logger.info(f"Created execution {execution_id} for task {task_id}")
        return execution_id
    except ClientError as e:
        logger.error(f"Error creating execution: {e}")
        return None

def update_schedule_next_run_time(schedule):
    try:
        now = datetime.now(timezone.utc)
        next_run = now

        # Calculate next run time based on frequency
        if schedule['frequency'] == 'daily':
            next_run = next_run + timedelta(days=1)
        elif schedule['frequency'] == 'weekly':
            next_run = next_run + timedelta(weeks=1)
        elif schedule['frequency'] == 'monthly':
            # Add one month (approximately)
            if next_run.month == 12:
                next_run = next_run.replace(year=next_run.year + 1, month=1)
            else:
                next_run = next_run.replace(month=next_run.month + 1)

        # Set to 9:00 AM
        next_run = next_run.replace(hour=9, minute=0, second=0, microsecond=0)

        # Update the schedule
        schedules_table.update_item(
            Key={'scheduleId': schedule['scheduleId']},
            UpdateExpression='SET nextRunTime = :nextRunTime',
            ExpressionAttributeValues={
                ':nextRunTime': next_run.isoformat()
            }
        )
        logger.info(f"Updated next run time for schedule {schedule['scheduleId']} to {next_run.isoformat()}")
    except ClientError as e:
        logger.error(f"Error updating schedule next run time: {e}")

async def process_schedules():
    try:
        due_schedules = get_due_schedules()
        
        for schedule in due_schedules:
            try:
                # Create execution for the scheduled task
                execution_id = create_execution(schedule['taskId'], schedule['userId'])
                if execution_id:
                    logger.info(f"Created execution {execution_id} for scheduled task {schedule['taskId']}")
                    
                    # Update the schedule's next run time
                    update_schedule_next_run_time(schedule)
            except Exception as e:
                logger.error(f"Error processing schedule {schedule['scheduleId']}: {e}")
                
    except Exception as e:
        logger.error(f"Error in process_schedules: {e}")

def update_execution_status(execution_id, status, result=None, error=None, details_gif=None, prompt=None, llm_name=None, output_as_json=False):
    try:
        update_expression = "SET #status = :status"
        expression_values = {
            ':status': status
        }
        expression_names = {
            '#status': 'status'
        }

        if status in ['completed', 'failed']:
            end_time = datetime.now(timezone.utc)
            update_expression += ", completedAt = :completedAt"
            expression_values[':completedAt'] = end_time.isoformat()

        if result is not None:
            update_expression += ", #result = :result"
            expression_values[':result'] = result
            expression_names['#result'] = 'result'

        if error is not None:
            update_expression += ", #error = :error"
            expression_values[':error'] = error
            expression_names['#error'] = 'error'

        if details_gif is not None:
            update_expression += ", details_gif = :detailsGif"
            expression_values[':detailsGif'] = details_gif

        if prompt is not None:
            update_expression += ", prompt = :prompt"
            expression_values[':prompt'] = prompt

        if llm_name is not None:
            update_expression += ", llmName = :llmName"
            expression_values[':llmName'] = llm_name
            
        if output_as_json is not None:
            update_expression += ", outputAsJson = :outputAsJson"
            expression_values[':outputAsJson'] = output_as_json

        # Get the execution to get the taskId and startTime
        execution = executions_table.get_item(Key={'executionId': execution_id}).get('Item')
        if execution:
            # If current status is 'killed', don't update status as it's a final state
            if execution.get('status') == 'killed':
                logger.info(f"Execution {execution_id} is already killed. Not updating status to {status}")
                return
            
            # Update the execution
            executions_table.update_item(
                Key={'executionId': execution_id},
                UpdateExpression=update_expression,
                ExpressionAttributeNames=expression_names,
                ExpressionAttributeValues=expression_values
            )

            # Send notifications if task is completed or failed
            if status in ['completed', 'failed']:
                # Get task details
                task = tasks_table.get_item(
                    Key={'taskId': execution['taskId']},
                    ProjectionExpression='userId, #n, emailNotification',
                    ExpressionAttributeNames={'#n': 'name'}
                ).get('Item')
                
                if task:
                    # Parse timestamps
                    start_time = datetime.fromisoformat(execution['startTime'].replace('Z', '+00:00'))
                    end_time = datetime.fromisoformat(expression_values[':completedAt'].replace('Z', '+00:00'))
                    
                    # Check if we need to calculate new_info_summary
                    need_new_info_check = False
                    new_info_summary = None
                    
                    # Check if email notification is enabled
                    email_notification_enabled = task.get('emailNotification', False)
                    
                    # Check if there are subscribers
                    subscribers = get_task_subscribers(execution['taskId'])
                    has_subscribers = len(subscribers) > 0
                    
                    # Only calculate new_info_summary if needed
                    if (email_notification_enabled or has_subscribers) and status == 'completed' and result:
                        logger.info(f"Checking for new information as notifications are enabled for task {execution['taskId']}")
                        try:
                            # Get previous execution using the function from email_utils
                            from email_utils import get_previous_execution
                            previous_execution = get_previous_execution(execution['taskId'], execution_id)
                            
                            # Check for new information
                            if previous_execution and previous_execution.get('result') and previous_execution.get('result') != result:
                                has_new_info, new_info_summary = check_new_information(previous_execution.get('result'), result)
                                logger.info(f"New information check for task {execution['taskId']}: {has_new_info}, summary: {new_info_summary}")
                        except Exception as e:
                            logger.error(f"Error checking for new information: {e}")
                    else:
                        logger.info(f"Skipping new information check as no notifications are needed for task {execution['taskId']}")

                    # Send simple notification to task owner if emailNotification is enabled
                    if email_notification_enabled:
                        # Get user's email from AW-Users table using UserIdIndex
                        user_response = users_table.query(
                            IndexName='UserIdIndex',
                            KeyConditionExpression='userId = :userId',
                            ExpressionAttributeValues={
                                ':userId': task['userId']
                            }
                        )
                        user = user_response.get('Items', [])[0] if user_response.get('Items') else None
                        
                        if user and user.get('email'):
                            # Send simple notification to owner
                            from email_utils import send_task_notification
                            send_task_notification(
                                to_email=user['email'],
                                task_name=task['name'],
                                task_id=execution['taskId'],
                                execution_status=status,
                                execution_id=execution_id,
                                result=result,
                                error=error,
                                new_info_summary=new_info_summary,
                                llm_name=llm_name # Pass llm_name
                            )
                        else:
                            logger.error(f"User email not found for userId: {task['userId']}")
                    
                    # Send detailed results to all subscribers
                    if has_subscribers:
                        from email_utils import notify_task_subscribers
                        notify_task_subscribers(
                            task_id=execution['taskId'],
                            task_name=task['name'],
                            execution_status=status,
                            execution_id=execution_id,
                            result=result,
                            error=error,
                            start_time=start_time,
                            end_time=end_time,
                            new_info_summary=new_info_summary,
                            result_files=execution.get('result_files', []),
                            llm_name=llm_name
                        )
    except ClientError as e:
        logger.error(f"Error updating execution status: {e}")

def update_workflow_task_execution(workflow_execution_id: str, task_id: str, task_status: str, error: str = None, result: str = None, task_execution_id: str = None):
    """
    Update a task's status within a workflow execution.
    Args:
        workflow_execution_id: ID of the workflow execution
        task_id: ID of the task being updated
        task_status: New status for the task ('running', 'completed', 'failed')
        error: Optional error message if task failed
        result: Optional result summary for completed tasks
        task_execution_id: Optional ID of the task execution
    """
    try:
        workflow_table = dynamodb.Table(f'{TABLE_PREFIX}AW-WorkflowExecutions')
        workflow_execution = workflow_table.get_item(
            Key={'executionId': workflow_execution_id}
        ).get('Item')
        
        if workflow_execution:
            # Update the task status in the workflow
            workflow_execution['tasks'] = [
                {
                    **t, 
                    'status': task_status, 
                    'completedAt': datetime.now(timezone.utc).isoformat() if task_status in ['completed', 'failed'] else t.get('completedAt'),
                    **(({'error': error} if error else {}) if task_status == 'failed' else {}),
                    **(({'result': result} if result else {}) if task_status == 'completed' else {}),
                    **(({'executionId': task_execution_id} if task_execution_id else {}))
                }
                if t['taskId'] == task_id else t 
                for t in workflow_execution['tasks']
            ]
            
            # Update workflow status if needed
            if task_status == 'failed':
                # Only update to failed if current status is not killed
                if workflow_execution.get('status') != 'killed':
                    workflow_execution['status'] = 'failed'
                    workflow_execution['error'] = f"Task {task_id} failed: {error}"
                    workflow_execution['completedAt'] = datetime.now(timezone.utc).isoformat()
            elif task_status == 'completed':
                # Check if all tasks are completed
                all_completed = all(t['status'] == 'completed' for t in workflow_execution['tasks'])
                if all_completed:
                    workflow_execution['status'] = 'completed'
                    workflow_execution['result'] = result
                    workflow_execution['completedAt'] = datetime.now(timezone.utc).isoformat()
            
            workflow_table.put_item(Item=workflow_execution)
            logger.info(f"Updated workflow task execution {workflow_execution_id} - task {task_id} {task_status}")
            return True
        return False
    except Exception as e:
        logger.error(f"Error updating workflow task execution: {e}")
        return False

async def update_workflow_execution(workflow_id: str, execution_id: str, updates: dict):
    """
    Update a workflow execution record.
    Args:
        workflow_id: ID of the workflow
        execution_id: ID of the workflow execution
        updates: Dictionary of fields to update (status, error, completedAt, etc.)
    """
    try:
        workflow_table = dynamodb.Table(f'{TABLE_PREFIX}AW-WorkflowExecutions')
        
        # Get current execution to check status
        current_execution = workflow_table.get_item(
            Key={'executionId': execution_id}
        ).get('Item')
        
        # If current status is killed, don't update
        if current_execution and current_execution.get('status') == 'killed':
            logger.info(f"Workflow execution {execution_id} is already killed. Not updating.")
            return True
        
        # Build update expression and attribute values
        update_expression_parts = []
        expression_values = {}
        expression_names = {}
        
        for key, value in updates.items():
            update_expression_parts.append(f"#{key} = :{key}")
            expression_values[f":{key}"] = value
            expression_names[f"#{key}"] = key
        
        update_expression = f"SET {', '.join(update_expression_parts)}"
        
        # Update the workflow execution
        workflow_table.update_item(
            Key={
                'executionId': execution_id
            },
            UpdateExpression=update_expression,
            ExpressionAttributeValues=expression_values,
            ExpressionAttributeNames=expression_names
        )
        
        logger.info(f"Updated workflow execution {execution_id} with updates: {updates}")
        return True
    except Exception as e:
        logger.error(f"Error updating workflow execution: {e}")
        return False

async def run_web_agent_cli(user_id: str, llm_name: str, prompt: str, execution_id: str, is_interactive: bool, task_id: str, gif_path: str, run_user_id: str = None, is_complex_task: bool = False, extract_page_content: bool = False, validate_output: bool = False, output_as_json: bool = False, is_agentic_dev_mode: bool = False, output_as_html: bool = False, use_shared_browser: bool = False, turn_off_headless: bool = False, use_knowledge_base: bool = False) -> Dict[str, Any]:
    global running_processes
    log_sync_manager = None
    process = None
    
    try:
        # Create necessary directories
        os.makedirs('prompts', exist_ok=True)
        os.makedirs('logs', exist_ok=True)
        
        # Save prompt to a file
        prompt_file = f'prompts/prompt_{execution_id}.txt'
        with open(prompt_file, 'w') as f:
            f.write(prompt)
        
        # Set up log file for this execution
        log_file = f'logs/execution_{execution_id}_web_agent.log'
        filtered_activity_log = f'logs/execution_{execution_id}_browser_use.filtered.log'
        
        # Initialize filtered log file if it doesn't exist yet
        # This ensures log syncing can start immediately
        if not Path(filtered_activity_log).exists():
            with open(filtered_activity_log, 'w') as f:
                f.write(f"Execution log initialized at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            logger.info(f"Created initial log file: {filtered_activity_log}")
        
        # Start the log sync manager to upload log files in real-time
        log_sync_manager = start_log_sync(filtered_activity_log, user_id, execution_id)
        
        # Build command with logging redirection
        cmd = [
            'python3', '-u',  # -u for unbuffered output
            'web_agent.py',
            '--user_id', user_id,
            '--llm_name', llm_name,
            '--execution_id', execution_id,
            '--task_id', task_id,
            '--prompt_file', prompt_file,
            '--gif_path', gif_path
        ]
        if run_user_id:
            cmd.extend(['--run_user_id', run_user_id])
        if is_interactive:
            cmd.append('--interactive')
        if is_complex_task:
            cmd.append('--is_complex_task')
        if extract_page_content:
            cmd.append('--extract-page-content')
        if validate_output:
            cmd.append('--validate-output')
        if output_as_json:
            cmd.append('--output-as-json')
        if is_agentic_dev_mode:
            cmd.append('--agentic-dev-mode')
        if output_as_html:
            cmd.append('--output-as-html')
        if use_shared_browser:
            cmd.append('--use-shared-browser')
        if turn_off_headless:
            cmd.append('--turn-off-headless')
        if use_knowledge_base:
            cmd.append('--use-knowledge-base')
        
        # Run command with output redirection
        logger.info(f"Running command: {' '.join(cmd)}")
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, 'PYTHONUNBUFFERED': '1'}  # Ensure unbuffered output
        )
        
        # Store process immediately in global running_processes
        if execution_id:
            running_processes[execution_id] = process
            logger.info(f"Stored process handle for execution {execution_id}")
        
        # Set timeout based on complexity
        timeout_seconds = int(os.getenv('COMPLEX_TASK_EXECUTION_TIMEOUT_SECONDS', '1800')) if is_complex_task else int(os.getenv('TASK_EXECUTION_TIMEOUT_SECONDS', '900'))
        logger.info(f"Waiting for process with timeout of {timeout_seconds} seconds")
        
        try:
            # Wait for process with timeout
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
            
            # Clean up prompt file
            os.unlink(prompt_file)
            
            # Write both stdout and stderr to log file for debugging
            with open(log_file, 'a') as f:
                f.write("\n\n=== NEW EXECUTION AT " + datetime.now().strftime("%Y-%m-%d %H:%M:%S") + " ===\n")
                f.write("=== COMMAND ===\n")
                f.write(" ".join(cmd) + "\n\n")
                if stdout:
                    f.write("=== STDOUT ===\n")
                    f.write(stdout.decode())
                    f.write("\n")
                if stderr:
                    f.write("=== STDERR ===\n")
                    f.write(stderr.decode())
                    f.write("\n")
                f.write("=" * 80 + "\n")
            
            if process.returncode == 0:
                try:
                    # Try to find the JSON output in stdout
                    output = stdout.decode()
                    # Split into lines and reverse to find the last JSON object
                    lines = output.split('\n')
                    for line in reversed(lines):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            result = json.loads(line)
                            if isinstance(result, dict) and 'success' in result:
                                logger.info(f"Successfully parsed result from web_agent.py")
                                return result
                        except json.JSONDecodeError:
                            continue
                    
                    # If we get here, no valid JSON was found
                    logger.error(f"No valid JSON found in output. Full output written to {log_file}")
                    return {
                        "success": False,
                        "error": f"No valid JSON output found. Check {log_file} for details.",
                        "llmName": llm_name
                    }
                except Exception as e:
                    logger.error(f"Error parsing output: {e}")
                    return {
                        "success": False,
                        "error": f"Failed to parse output: {str(e)}. Check {log_file} for details.",
                        "llmName": llm_name
                    }
            else:
                error_msg = stderr.decode() if stderr else "Unknown error"
                logger.error(f"Process failed with error: {error_msg}")
                return {
                    "success": False,
                    "error": f"Process error: {error_msg}. Check {log_file} for details.",
                    "llmName": llm_name
                }
                
        except asyncio.TimeoutError:
            # Task execution timed out
            logger.error(f"Task execution timed out after {timeout_seconds} seconds")
            if process:
                process.kill()
            return {
                "success": False,
                "error": f"Task execution timed out after {timeout_seconds} seconds",
                "llmName": llm_name
            }
        except asyncio.CancelledError:
            # Process was cancelled (likely killed by monitor)
            logger.info(f"Task execution was cancelled for {execution_id}")
            return {
                "success": False,
                "error": "Task execution was cancelled",
                "llmName": llm_name
            }
        except BrokenPipeError as e:
            # Handle EPIPE errors gracefully
            logger.error(f"Broken pipe error during task execution: {e}")
            if process:
                try:
                    process.kill()
                except:
                    pass
            return {
                "success": False,
                "error": "Browser process was terminated unexpectedly. This may be due to a system resource limitation or browser crash.",
                "llmName": llm_name
            }
            
    except Exception as e:
        logger.error(f"Error in run_web_agent_cli: {e}")
        return {
            "success": False,
            "error": str(e),
            "llmName": llm_name
        }
    finally:
        # Safe cleanup with error handling
        try:
            # Stop log sync manager if it exists and is running
            if 'log_sync_manager' in locals() and log_sync_manager is not None:
                try:
                    log_sync_manager.stop_watching()
                except Exception as e:
                    print(f"Error stopping log sync manager in run_web_agent_cli: {e}")
                    
            # Clean up process if it's still running
            if 'process' in locals() and process is not None:
                try:
                    if process.returncode is None:
                        logger.info("Process still running, attempting to terminate it")
                        process.kill()
                    try:
                        # Wait for process without blocking indefinitely
                        await asyncio.wait_for(process.wait(), timeout=3.0)
                        logger.info("Process terminated successfully")
                    except asyncio.TimeoutError:
                        logger.warning("Timed out waiting for process to terminate after kill")
                    except Exception as wait_e:
                        # This is likely where the "Error cleaning up process" occurs
                        # The error might happen if the process resource is already gone
                        logger.warning(f"Non-critical error waiting for process: {wait_e}")
                except Exception as e:
                    # Don't just print, also log the error
                    logger.warning(f"Error cleaning up process in run_web_agent_cli: {e}")
                    # But continue execution since this is cleanup code
        except Exception as final_e:
            # Final catch-all error handling
            print(f"Critical error during run_web_agent_cli cleanup: {final_e}")
            try:
                # Try logging if still available
                logger.error(f"Critical error during run_web_agent_cli cleanup: {final_e}")
            except:
                pass

async def execute_task(execution):
    global running_task_count, running_user_ids, running_task_ids, running_processes
    
    execution_id = execution['executionId']
    task_id = execution['taskId']
    user_id = execution['userId']
    run_user_id = execution.get('run_user_id')
    task = None
    prompt = None
    llm_names_tried = []
    research_task = None
    web_agent_task = None  # Keep this variable for cleanup
    agent = None
    filtered_activity_log = None
    log_sync_manager = None  # Initialize to None
    
    try:
        running_task_count += 1
        running_user_ids.add(user_id)
        
        # Get task details from tasks table if taskId doesn't start with 'task-'
        task_id = execution['taskId']
        if not task_id.startswith('task-'):
            task_response = tasks_table.get_item(Key={'taskId': task_id})
            task = task_response.get('Item')
            
            if not task:
                raise Exception(f"Task {task_id} not found")
                
            # Check if this is a deep research task and track it
            is_deep_research = task.get('isDeepResearch', False)
            if is_deep_research:
                running_task_ids[execution_id] = 'deep_research'
            else:
                running_task_ids[execution_id] = 'standard'

            # Get both accepted and rejected executions
            accepted_executions = executions_table.query(
                IndexName='TaskFeedbackIndex',
                KeyConditionExpression='taskId = :taskId AND feedback = :feedback',
                ExpressionAttributeValues={
                    ':taskId': task_id,
                    ':feedback': 'accepted'
                },
                ScanIndexForward=False,  # Get latest first
                Limit=1
            ).get('Items', [])

            rejected_executions = executions_table.query(
                IndexName='TaskFeedbackIndex',
                KeyConditionExpression='taskId = :taskId AND feedback = :feedback',
                ExpressionAttributeValues={
                    ':taskId': task_id,
                    ':feedback': 'rejected'
                },
                ScanIndexForward=False,  # Get latest first
                Limit=1
            ).get('Items', [])
            
            # Find the most recent feedback
            previous_feedback = None
            prev_execution = None
            
            if accepted_executions and rejected_executions:
                prev_execution = accepted_executions[0] if accepted_executions[0]['startTime'] > rejected_executions[0]['startTime'] else rejected_executions[0]
            elif accepted_executions:
                prev_execution = accepted_executions[0]
            elif rejected_executions:
                prev_execution = rejected_executions[0]
                
            if prev_execution:
                prev_time = datetime.fromisoformat(prev_execution['startTime'].replace('Z', '+00:00'))
                time_ago = humanize.naturaltime(datetime.now(timezone.utc) - prev_time)
                previous_feedback = {
                    'feedback': prev_execution['feedback'],
                    'result': prev_execution.get('result', ''),
                    'time_ago': time_ago
                }

            # Prepare the prompt with previous feedback and user_id context
            base_prompt = execution.get('prompt') or task['prompt']
            
            if previous_feedback:
                prompt = f"Task: {base_prompt}\n\nNote: Previous attempt {previous_feedback['time_ago']} was {previous_feedback['feedback']}. Previous result: {previous_feedback['result']}"
            else:
                prompt = f"Task: {base_prompt}"

            # Add attachment information if present
            if task.get('attachments'):
                attachment_list = "\n".join([f"- {attachment['filename']}" for attachment in task['attachments']])
                prompt += f"\n\nThe following files are attached to this task:\n{attachment_list}"
            
            # Update execution status to running and include the prompt
            update_execution_status(execution_id, 'running', prompt=prompt)
        else:
            # For new tasks (task- prefix), use the prompt from the execution record
            prompt = execution.get('prompt')
            if not prompt:
                raise Exception(f"No prompt found for task {task_id}")
            
            # Update execution status to running
            update_execution_status(execution_id, 'running')

        # Get LLM names from task or environment
        llm_names = []
        if task and task.get('llmName'):  # Only check task.llmName if task exists
            llm_names = [task['llmName']]
        
        # Check if this is a deep research task
        is_deep_research = task and task.get('isDeepResearch', False)
        logger.info(f"Task {task_id} isDeepResearch: {is_deep_research}")
        
        # Use different LLM list for deep research tasks
        if is_deep_research:
            default_llm_names = os.getenv('DEEP_RESEARCH_LLM_NAMES', 'azure->openai->o1-mini,azure->openai->gpt-4o').split(',')
            logger.info(f"Using deep research LLM list: {default_llm_names}")
        elif execution.get('workflowExecutionId') and task_id.startswith('task-'):
            default_llm_names = os.getenv('WORKFLOW_LLM_NAMES', 'azure->openai->gpt-4o').split(',')
            logger.info(f"Using workflow LLM list: {default_llm_names}")
        else:
            default_llm_names = os.getenv('LIST_FULL_LLM_NAMES', 'azure->openai->gpt-4o,aws->anthropic->anthropic.claude-3-5-sonnet-20241022-v2:0,openai->openai->gpt-4o').split(',')
            logger.info(f"Using default LLM list: {default_llm_names}")

            # Override for standard tasks if selectedLLMs is specified
            if task and task.get('selectedLLMs') and isinstance(task['selectedLLMs'], list) and len(task['selectedLLMs']) > 0:
                logger.info(f"Standard task override: Using selectedLLMs {task['selectedLLMs']} instead of default list.")
                default_llm_names = task['selectedLLMs'] # Replace the list
            
        # Add each non-empty name if not already in the list
        for name in default_llm_names:
            name = name.strip()
            if name and name not in llm_names:
                llm_names.append(name)
        
        if not llm_names:
            raise ValueError("No valid LLM names provided")

        logger.info(f"Will try LLMs in order: {llm_names}")
        
        last_error = None
        success = False
        
        context = f"You are executing this task at {datetime.now(timezone.utc).isoformat()}."
        prompt_with_context = f"{prompt}\n\n{context}"

        # Try each LLM in sequence until one succeeds
        for llm_name in llm_names:
            try:
                llm_names_tried.append(llm_name)  # Track attempt
                # Generate unique GIF path
                random_suffix = ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=20))
                gif_path = f"agent_history_{execution_id}_{random_suffix}.gif"

                output_as_json = bool(task.get('outputAsJson', False)) if task else False
                output_as_html = bool(task.get('outputAsHtml', False)) if task else False
                
                # Run appropriate agent based on task type
                if is_deep_research:
                    # Use DeepResearchAgentWrapper directly instead of CLI
                    try:
                        logger.info(f"Running deep research directly with LLM: {llm_name}")
                        
                        # Initialize the deep research agent with user_id and execution_id
                        agent = DeepResearchAgentWrapper(
                            user_id=user_id,
                            execution_id=execution_id,
                            full_llm_name=llm_name
                        )
                        
                        # Set up log file path for deep research logs
                        filtered_activity_log = f"logs/execution_{execution_id}_deep_activities.log"
                        
                        # Start real-time log syncing for deep research logs
                        log_sync_manager = start_log_sync(filtered_activity_log, user_id, execution_id)
                        
                        # Define a function to run the research in a separate thread
                        def run_research_in_thread(agent, prompt, max_turns):
                            try:
                                return agent.run_research(
                                    query=prompt,
                                    max_turns=max_turns,
                                    user_input=False
                                )
                            except Exception as e:
                                logger.error(f"Error in research thread: {str(e)}")
                                return {
                                    "success": False,
                                    "error": f"Research thread error: {str(e)}",
                                    "llm_name": llm_name
                                }
                        
                        # Set timeout from environment or default to 15 minutes
                        timeout_seconds = int(os.getenv('DEEP_RESEARCH_TIMEOUT_SECONDS', '900'))
                        logger.info(f"Running deep research with timeout of {timeout_seconds} seconds")
                        
                        # Use asyncio.to_thread to run the research in a separate thread without blocking
                        try:
                            # Create a task that will run the research in a separate thread
                            research_task = asyncio.create_task(
                                asyncio.to_thread(
                                    run_research_in_thread,
                                    agent,
                                    prompt_with_context,
                                    int(os.getenv('DEEP_RESEARCH_MAX_TURNS', '2'))
                                )
                            )
                            
                            # Wait for the research to complete with a timeout
                            result = await asyncio.wait_for(research_task, timeout=timeout_seconds)
                            logger.info(f"Successfully completed deep research with {llm_name}")
                            
                        except asyncio.TimeoutError:
                            # Research timed out
                            logger.error(f"Deep research timed out after {timeout_seconds} seconds")
                            result = {
                                "success": False,
                                "error": f"Deep research timed out after {timeout_seconds} seconds",
                                "llm_name": llm_name
                            }
                            # Cancel the task to prevent it from continuing to run in the background
                            research_task.cancel()
                            
                        except Exception as e:
                            # Other errors
                            logger.error(f"Error waiting for deep research: {str(e)}")
                            result = {
                                "success": False,
                                "error": f"Error waiting for deep research: {str(e)}",
                                "llm_name": llm_name
                            }
                            # Cancel the task if it's still running
                            if 'research_task' in locals() and not research_task.done():
                                research_task.cancel()
                        
                        # Get the output file path from the result
                        output_file = result.get('output_file', None)
                        if filtered_activity_log != output_file:
                            logger.error(f"Log file {output_file} is different from expected path {filtered_activity_log}. Log sync will not work.")
                            
                    except Exception as e:
                        logger.error(f"Error running deep research directly: {str(e)}")
                        result = {
                            "success": False,
                            "error": f"Deep research error: {str(e)}",
                            "llm_name": llm_name
                        }
                else:
                    # Run WebAgent via CLI for non-deep-research tasks
                    try:
                        # Set parameters for web agent execution
                        is_complex = bool(task.get('isComplexTask', False)) if task else False
                        is_interactive = bool(task.get('isInteractive', False)) if task else False
                        extract_page_content = bool(task.get('extractPageContent', False)) if task else False
                        validate_output = bool(task.get('validateOutput', False)) if task else False
                        is_agentic_dev_mode = bool(task.get('isAgenticDevMode', False)) if task else False
                        use_shared_browser = bool(task.get('useSharedBrowser', False)) if task else False
                        turn_off_headless = bool(task.get('turnOffHeadless', False)) if task else False
                        use_knowledge_base = bool(task.get('useKnowledgeBase', False)) if task else False
                        
                        # Set filtered activity log path for later reference
                        filtered_activity_log = f'logs/execution_{execution_id}_browser_use.filtered.log'
                        
                        # Run web agent directly
                        result = await run_web_agent_cli(
                            user_id,
                            llm_name,
                            prompt,
                            execution_id,
                            is_interactive,
                            task_id,
                            gif_path,
                            run_user_id,
                            is_complex,
                            extract_page_content,
                            validate_output,
                            output_as_json,
                            is_agentic_dev_mode,
                            output_as_html,
                            use_shared_browser,
                            turn_off_headless,
                            use_knowledge_base
                        )
                    except Exception as e:
                        logger.error(f"Error running web agent: {str(e)}")
                        result = {
                            "success": False,
                            "error": f"Web agent error: {str(e)}",
                            "llmName": llm_name
                        }

                # Upload GIF if it exists
                details_gif = None
                if Path(gif_path).exists():
                    details_gif = upload_gif(gif_path)
                
                if result['success']:
                    result_summary = result.get('summary', 'No summary available')

                    # Update execution status
                    try:
                        update_execution_status(
                            execution_id, 
                            'completed', 
                            result=result_summary,
                            details_gif=details_gif,
                            llm_name=llm_name,
                            output_as_json=output_as_json
                        )
                        logger.info(f"Updated execution status to completed for {execution_id}")
                    except Exception as e:
                        logger.error(f"Error updating execution status: {e}", exc_info=True)
                    
                    # Update task with successful LLM name if it's not a workflow task
                    if not execution.get('workflowExecutionId') and task and task.get('llmName') != llm_name:
                        try:
                            tasks_table.update_item(
                                Key={'taskId': task_id},
                                UpdateExpression='SET llmName = :llm_name',
                                ExpressionAttributeValues={
                                    ':llm_name': llm_name
                                }
                            )
                            logger.info(f"Updated task {task_id} with successful LLM: {llm_name}")
                        except Exception as e:
                            logger.error(f"Error updating task LLM name: {e}", exc_info=True)
                    
                    # Update workflow execution if this is a workflow task
                    if 'workflowExecutionId' in execution:
                        try:
                            update_workflow_task_execution(execution['workflowExecutionId'], task_id, 'completed', result=result_summary)
                            logger.info(f"Updated workflow execution for task {task_id}")
                        except Exception as e:
                            logger.error(f"Error updating workflow execution: {e}", exc_info=True)
                    
                    success = True
                    break
                else:
                    last_error = result.get('error', 'Unknown error')
                    logger.warning(f"LLM {llm_name} failed with error: {last_error}")
                    
                    # Check if execution was killed while we were processing
                    try:
                        execution_status = executions_table.get_item(
                            Key={'executionId': execution_id},
                            ProjectionExpression='#s',
                            ExpressionAttributeNames={'#s': 'status'}
                        ).get('Item', {}).get('status')
                        
                        if execution_status == 'killed':
                            logger.info(f"Execution {execution_id} was killed, stopping LLM attempts")
                            break
                    except Exception as e:
                        logger.error(f"Error checking execution status: {e}")
            except Exception as e:
                last_error = str(e)
                logger.error(f"Error with LLM {llm_name}: {e}")

        # Upload activity log last time and delete the file. We do this regardless of whether we were syncing with log_sync_manager or not.
        if filtered_activity_log and Path(filtered_activity_log).exists():
            upload_activity_log(filtered_activity_log, user_id, execution_id)
            Path(filtered_activity_log).unlink()
            logger.info(f"Deleted log file after stopping log_sync_manager: {filtered_activity_log}")
        
        if not success:
            error_message = f"All LLMs failed. Last error: {last_error}"
            try:
                # Check if execution was killed before sending oncall alert
                execution_status = executions_table.get_item(
                    Key={'executionId': execution_id},
                    ProjectionExpression='#s',
                    ExpressionAttributeNames={'#s': 'status'}
                ).get('Item', {}).get('status')
                
                # Only send oncall alert if task was not killed
                if execution_status != 'killed':
                    # Send oncall alert before updating status
                    from email_utils import send_oncall_alert
                    send_oncall_alert(
                        task_name=task['name'] if task else 'Unknown Task',
                        task_id=task_id,
                        error=error_message,
                        llm_names_tried=llm_names_tried
                    )
                
                update_execution_status(
                    execution_id, 
                    'failed', 
                    error=error_message
                )
                logger.info(f"Updated execution status to failed for {execution_id}")
            except Exception as e:
                logger.error(f"Error sending oncall alert: {e}")
            
            # Update workflow execution if this is a workflow task
            if 'workflowExecutionId' in execution:
                try:
                    update_workflow_task_execution(execution['workflowExecutionId'], task_id, 'failed', error=error_message)
                    logger.info(f"Updated workflow execution status to failed for task {task_id}")
                except Exception as e:
                    logger.error(f"Error updating workflow execution status to failed: {e}", exc_info=True)
        
    except Exception as e:
        logger.error(f"Error executing task: {e}", exc_info=True)
        try:
            update_execution_status(execution_id, 'failed', error=str(e))
            logger.info(f"Updated execution status to failed for {execution_id} due to error")
        except Exception as update_error:
            logger.error(f"Error updating execution status after task error: {update_error}", exc_info=True)
        
        # Update workflow execution if this is a workflow task
        if 'workflowExecutionId' in execution:
            try:
                update_workflow_task_execution(execution['workflowExecutionId'], task_id, 'failed', error=str(e))
                logger.info(f"Updated workflow execution status to failed for task {task_id} due to error")
            except Exception as workflow_error:
                logger.error(f"Error updating workflow execution after task error: {workflow_error}", exc_info=True)
    finally:
        try:
            # Stop log sync manager if it exists and is running
            if 'log_sync_manager' in locals() and log_sync_manager is not None:
                try:
                    log_sync_manager.stop_watching()
                except Exception as e:
                    print(f"Error stopping log sync manager: {e}")
            
            # Clean up tasks if they're still running
            if research_task and not research_task.done():
                try:
                    research_task.cancel()
                    await research_task
                except Exception as e:
                    print(f"Error canceling research task: {e}")
                    
            # Clean up web_agent_task if it exists and is still running
            if web_agent_task and not web_agent_task.done():
                try:
                    web_agent_task.cancel()
                    await web_agent_task
                except Exception as e:
                    print(f"Error canceling web agent task: {e}")
                    
            # Clean up agent resources
            if agent:
                try:
                    await agent.cleanup()
                    logger.info(f"Agent cleanup completed for {execution_id}")
                except Exception as e:
                    print(f"Error during agent cleanup: {e}")
                    try:
                        logger.error(f"Error during agent cleanup: {e}")
                    except:
                        pass

            # Update running counters
            running_task_count -= 1
            if user_id in running_user_ids:
                running_user_ids.remove(user_id)
            running_task_ids.pop(execution_id, None)
            
            # Clean up process handle
            if execution_id in running_processes:
                # Check if process was already terminated by the monitor thread
                proc = running_processes[execution_id]
                if proc and hasattr(proc, 'returncode') and proc.returncode is None:
                    try:
                        # Process is still running, try to terminate it
                        logger.info(f"Process for {execution_id} is still running during cleanup, terminating it")
                        proc.terminate()
                    except Exception as e:
                        logger.error(f"Error terminating process during cleanup: {e}")
                        
                # Remove from dictionary
                del running_processes[execution_id]
                logger.info(f"Removed process from tracking dictionary for {execution_id}")
                
            try:
                logger.info(f"Task {execution_id} cleanup completed")
            except:
                print(f"Task {execution_id} cleanup completed")
                
        except Exception as final_error:
            # Last resort error handling
            print(f"Critical error during task cleanup: {final_error}")
            try:
                # Try logging if still available
                logger.error(f"Critical error during task cleanup: {final_error}")
            except:
                pass

async def get_pending_workflow_executions():
    try:
        # Query for pending executions
        pending_params = {
            'IndexName': 'StatusStartTimeIndex',
            'KeyConditionExpression': '#status = :status',
            'ExpressionAttributeNames': {
                '#status': 'status'
            },
            'ExpressionAttributeValues': {
                ':status': 'pending'
            }
        }
        pending_response = dynamodb.Table(f'{TABLE_PREFIX}AW-WorkflowExecutions').query(**pending_params)
        pending_items = pending_response.get('Items', [])

        # Query for running executions
        running_params = {
            'IndexName': 'StatusStartTimeIndex',
            'KeyConditionExpression': '#status = :status',
            'ExpressionAttributeNames': {
                '#status': 'status'
            },
            'ExpressionAttributeValues': {
                ':status': 'running'
            }
        }
        running_response = dynamodb.Table(f'{TABLE_PREFIX}AW-WorkflowExecutions').query(**running_params)
        running_items = running_response.get('Items', [])

        # Combine both results
        return pending_items + running_items
    except ClientError as e:
        logger.error(f"Error querying pending workflow executions: {e}")
        return []

async def execute_workflow_task(execution_id: str, task: dict):
    try:
        # Update task status to running
        workflow_table = dynamodb.Table(f'{TABLE_PREFIX}AW-WorkflowExecutions')
        execution = workflow_table.get_item(Key={'executionId': execution_id}).get('Item')
        
        if not execution:
            logger.error(f"Workflow execution {execution_id} not found")
            return False

        # Check if all dependencies are completed
        dependent_results = []
        if task.get('dependsOn'):
            for dep_task_id in task['dependsOn']:
                dep_task = next((t for t in execution['tasks'] if t['taskId'] == dep_task_id), None)
                if not dep_task or dep_task['status'] != 'completed':
                    logger.info(f"Task {task['taskId']} waiting for dependency {dep_task_id}")
                    return False
                
                # Get dependent task's result and files
                result_parts = []
                if dep_task.get('result'):
                    result_parts.append(dep_task['result'])
                
                # Get dependent task's result files
                if dep_task.get('executionId'):
                    dep_execution = executions_table.get_item(Key={'executionId': dep_task['executionId']}).get('Item')
                    if dep_execution and dep_execution.get('result_files'):
                        for i, file_info in enumerate(dep_execution['result_files'], 1):
                            try:
                                # Download file content using requests in a thread
                                response = await asyncio.to_thread(requests.get, file_info.get('url'))
                                if response.status_code == 200:
                                    content = response.text
                                    result_parts.append(f"\nResult file {i} content:\n{content}")
                                    logger.info(f"Downloaded content from {file_info.get('url')}, {len(content)} bytes")
                                else:
                                    logger.error(f"Failed to download file from {file_info.get('url')}: {response.status_code}")
                            except Exception as e:
                                logger.error(f"Error downloading file from {file_info.get('url')}: {e}")
                
                if result_parts:
                    dependent_results.append(f"Task {dep_task_id}:\n{chr(10).join(result_parts)}")

        # Get the task prompt
        task_id = task['taskId']
        if not task_id.startswith('task-'):
            # For referenced tasks, fetch the prompt from the task
            task_response = tasks_table.get_item(Key={'taskId': task_id})
            task_data = task_response.get('Item')
            if not task_data:
                raise Exception(f"Referenced task {task_id} not found")
            task_prompt = task_data['prompt']
        else:
            # For new tasks, use the prompt from the workflow task
            task_prompt = task.get('prompt')

        # Add dependent results to prompt if any exist
        if dependent_results:
            task_prompt = f"""Current task:
{task_prompt}

Dependent task results:
{chr(10).join(dependent_results)}"""

        # Create task execution with prompt and workflow execution ID
        task_execution_id = create_execution(
            task['taskId'], 
            execution['userId'], 
            task_prompt,
            workflow_execution_id=execution_id
        )
        if not task_execution_id:
            logger.error(f"Failed to create execution for task {task['taskId']}")
            return False

        # Update workflow task status to running and store task execution ID
        update_workflow_task_execution(
            execution_id, 
            task['taskId'], 
            'running', 
            task_execution_id=task_execution_id
        )
        logger.info(f"Created execution {task_execution_id} for task {task['taskId']} in workflow {execution_id}")

        return True
    except Exception as e:
        logger.error(f"Error executing workflow task: {e}")
        return False

async def request_kill_task_execution(execution_id: str):
    """Request to kill a task execution by setting killRequested flag."""
    try:
        # Update task execution to set killRequested
        executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET killRequested = :killRequested',
            ExpressionAttributeValues={
                ':killRequested': datetime.now(timezone.utc).isoformat()
            }
        )
        logger.info(f"Kill requested for task execution {execution_id}")
        return True
    except Exception as e:
        logger.error(f"Error requesting kill for task execution {execution_id}: {str(e)}")
        return False

async def process_workflow_executions():
    """Process pending workflow executions."""
    try:
        # Get pending workflow executions
        workflow_executions = await get_pending_workflow_executions()
        
        for workflow_execution in workflow_executions:
            try:
                if workflow_execution.get('status') != 'running':
                    await update_workflow_execution(
                        workflow_execution['workflowId'],
                        workflow_execution['executionId'],
                        {
                            'status': 'running'
                        }
                    )
                
                # Check if workflow execution has been requested to be killed
                if workflow_execution.get('killRequested'):
                    logger.info(f"Kill requested for workflow execution {workflow_execution['executionId']}")
                    
                    # Request kill for all running tasks in the workflow
                    for task in workflow_execution['tasks']:
                        if task.get('status') in ['running', 'pending']:
                            if task.get('executionId'):
                                # For tasks with execution ID, request kill through the execution
                                await request_kill_task_execution(task['executionId'])
                            else:
                                # For tasks without execution ID, mark them as killed directly
                                task['status'] = 'killed'
                                task['error'] = 'Task was killed before execution started'
                    
                    # Update workflow execution status to killed
                    await update_workflow_execution(
                        workflow_execution['workflowId'],
                        workflow_execution['executionId'],
                        {
                            'status': 'killed',
                            'error': 'Workflow execution was killed by user',
                            'completedAt': datetime.utcnow().isoformat(),
                            'tasks': workflow_execution['tasks']  # Include updated tasks
                        }
                    )
                    continue

                # Get tasks that are ready to execute (pending and dependencies met)
                pending_tasks = [
                    task for task in workflow_execution['tasks'] 
                    if task['status'] == 'pending'
                ]

                # Sort tasks by order
                pending_tasks.sort(key=lambda x: x['order'])

                # Try to execute each pending task
                for task in pending_tasks:
                    await execute_workflow_task(workflow_execution['executionId'], task)
                    
            except Exception as e:
                logger.error(f"Error processing workflow execution {workflow_execution.get('executionId')}: {str(e)}")
                # Update workflow execution status to failed
                await update_workflow_execution(
                    workflow_execution['workflowId'],
                    workflow_execution['executionId'],
                    {
                        'status': 'failed',
                        'error': str(e),
                        'completedAt': datetime.utcnow().isoformat()
                    }
                )
                
    except Exception as e:
        logger.error(f"Error in process_workflow_executions: {str(e)}")

async def monitor_executions():
    global last_execution_time, running_task_count, running_user_ids, running_task_ids, running_processes

    INTERVAL = 5
    MAX_CONCURRENT = int(os.getenv('MAX_CONCURRENT_TASKS', '3'))
    logger.info(f"Starting execution monitor with interval of {INTERVAL} seconds, max concurrent tasks: {MAX_CONCURRENT}...")
    
    while True:
        try:
            # First, process schedules to create new executions
            await process_schedules()
            
            # Then process workflow executions
            await process_workflow_executions()
            
            # Check for kill requests
            for execution_id, process_handle in list(running_processes.items()):
                try:
                    # Get execution from DynamoDB
                    execution = executions_table.get_item(Key={'executionId': execution_id}).get('Item')
                    
                    # Check if kill was requested
                    if execution and execution.get('killRequested'):
                        logger.info(f"Kill requested for execution {execution_id}. Terminating process.")
                        
                        # Terminate process if it's still running
                        if process_handle and hasattr(process_handle, 'returncode') and process_handle.returncode is None:
                            try:
                                # Try graceful termination first
                                process_handle.terminate()
                                
                                # Wait briefly for termination
                                try:
                                    # For asyncio subprocess
                                    if hasattr(process_handle, 'wait') and asyncio.iscoroutinefunction(process_handle.wait):
                                        await asyncio.wait_for(process_handle.wait(), timeout=5.0)
                                    # For regular subprocess
                                    elif hasattr(process_handle, 'wait'):
                                        process_handle.wait(timeout=5)
                                except (asyncio.TimeoutError, subprocess.TimeoutExpired):
                                    # Force kill if not terminated gracefully
                                    logger.warning(f"Process for {execution_id} did not terminate gracefully, forcing kill")
                                    process_handle.kill()
                                
                                # Update execution status directly here
                                # This ensures the status is updated even if the process is killed
                                update_execution_status(
                                    execution_id, 
                                    'killed', 
                                    error='Task was terminated by user request'
                                )
                                
                                logger.info(f"Execution {execution_id} successfully terminated")
                            except Exception as e:
                                logger.error(f"Error terminating process for execution {execution_id}: {e}")
                except Exception as e:
                    logger.error(f"Error checking kill request for execution {execution_id}: {e}")
            
            # Then process pending task executions
            pending_executions = get_pending_executions()
            
            # Run up to MAX_CONCURRENT tasks, ensuring no duplicate userIds
            executed_count = 0
            if pending_executions and running_task_count < MAX_CONCURRENT:
                for execution in pending_executions:
                    user_id = execution['userId']
                    
                    if user_id not in running_user_ids and running_task_count < MAX_CONCURRENT:
                        task = asyncio.create_task(execute_task(execution))
                        executed_count += 1
                
                # Only update last_execution_time if we executed all pending executions
                if executed_count == len(pending_executions):
                    last_execution_time = max(item['startTime'] for item in pending_executions)
                    logger.info(f"Updated last_execution_time to {last_execution_time}")
            
            await asyncio.sleep(INTERVAL)

        except Exception as e:
            logger.error(f"Error in monitor loop: {e}")
            await asyncio.sleep(INTERVAL)

if __name__ == "__main__":
    asyncio.run(monitor_executions()) 