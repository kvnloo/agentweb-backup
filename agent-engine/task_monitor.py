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
from task_utils import upload_activity_log, upload_gif, check_new_information  # Import utility functions
import subprocess
import tempfile
import shutil
import re
import traceback
import threading

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

def update_execution_status(execution_id, status, result=None, error=None, details_gif=None, prompt=None, llm_name=None):
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

        # Get the execution to get the taskId and startTime
        execution = executions_table.get_item(Key={'executionId': execution_id}).get('Item')
        if execution:
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
                    from email_utils import get_task_subscribers
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
                                new_info_summary=new_info_summary
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
                            new_info_summary=new_info_summary
                        )
    except ClientError as e:
        logger.error(f"Error updating execution status: {e}")

def update_workflow_execution(workflow_execution_id: str, task_id: str, task_status: str, error: str = None, result: str = None):
    """
    Common function to update workflow execution record.
    Args:
        workflow_execution_id: ID of the workflow execution
        task_id: ID of the task being updated
        task_status: New status for the task ('running', 'completed', 'failed')
        error: Optional error message if task failed
        result: Optional result summary for completed tasks
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
                    **(({'result': result} if result else {}) if task_status == 'completed' else {})
                }
                if t['taskId'] == task_id else t 
                for t in workflow_execution['tasks']
            ]
            
            # Update workflow status if needed
            if task_status == 'failed':
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
            logger.info(f"Updated workflow execution {workflow_execution_id} - task {task_id} {task_status}")
            return True
        return False
    except Exception as e:
        logger.error(f"Error updating workflow execution: {e}")
        return False

async def run_web_agent_cli(user_id: str, llm_name: str, prompt: str, execution_id: str, is_interactive: bool, task_id: str, gif_path: str, run_user_id: str = None, is_complex_task: bool = False) -> Dict[str, Any]:
    """Run the web agent with the given parameters"""
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
            
        # Run command with output redirection
        logger.info(f"Running command: {' '.join(cmd)}")
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, 'PYTHONUNBUFFERED': '1'}  # Ensure unbuffered output
        )
        
        stdout, stderr = await process.communicate()
        
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
            
    except Exception as e:
        logger.error(f"Error in run_web_agent_cli: {e}")
        return {
            "success": False,
            "error": str(e),
            "llmName": llm_name
        }

async def execute_task(execution):
    global running_task_count, running_user_ids, running_task_ids
    
    execution_id = execution['executionId']
    task_id = execution['taskId']
    user_id = execution['userId']
    run_user_id = execution.get('run_user_id')  # Get run_user_id from the execution record
    task = None  # Initialize task variable
    prompt = None  # Initialize prompt variable
    llm_names_tried = []  # Track LLM attempts
    
    try:
        running_task_count += 1
        running_user_ids.add(user_id)
        
        # For workflow tasks, use the prompt directly from the execution record
        if 'workflowExecutionId' in execution:
            prompt = execution.get('prompt')
            if not prompt:
                raise Exception(f"No prompt found for workflow task {task_id}")
            
            # Update execution status to running
            update_execution_status(execution_id, 'running')
        else:
            # Get task details from tasks table for non-workflow tasks
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
            base_prompt = task['prompt']
            
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

        # Get LLM names from task or environment
        llm_names = []
        if task and task.get('llmName'):  # Only check task.llmName if task exists
            llm_names = [task['llmName']]
        
        # Check if this is a deep research task
        is_deep_research = task and task.get('isDeepResearch', False)
        logger.info(f"Task {task_id} isDeepResearch: {is_deep_research}")
        
        # Use different LLM list for deep research tasks
        if is_deep_research:
            env_llm_names = os.getenv('DEEP_RESEARCH_LLM_NAMES', 'azure->openai->o1-mini,azure->openai->gpt-4o')
            logger.info(f"Using deep research LLM list: {env_llm_names}")
        else:
            env_llm_names = os.getenv('LIST_FULL_LLM_NAMES', 'azure->openai->gpt-4o,aws->anthropic->anthropic.claude-3-5-sonnet-20241022-v2:0,openai->openai->gpt-4o')
            logger.info(f"Using standard LLM list: {env_llm_names}")
            
        # Add each non-empty name if not already in the list
        for name in env_llm_names.split(','):
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

        filtered_activity_log = None

        # Try each LLM in sequence until one succeeds
        for llm_name in llm_names:
            try:
                llm_names_tried.append(llm_name)  # Track attempt
                # Generate unique GIF path
                random_suffix = ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=20))
                gif_path = f"agent_history_{execution_id}_{random_suffix}.gif"
                
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
                        filtered_activity_log = result.get('output_file', None)
                        if filtered_activity_log and os.path.exists(filtered_activity_log):
                            logger.info(f"Found output file: {filtered_activity_log}")
                        else:
                            logger.warning(f"Output file not found or not specified in result")
                            filtered_activity_log = None
                            
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
                        # Set timeout from environment or default to 15 minutes
                        timeout_seconds = int(os.getenv('TASK_EXECUTION_TIMEOUT_SECONDS', '900'))
                        logger.info(f"Running web agent with timeout of {timeout_seconds} seconds")
                        
                        # Create a task for running the web agent
                        web_agent_task = asyncio.create_task(
                            run_web_agent_cli(
                                user_id,
                                llm_name,
                                prompt_with_context,
                                execution_id,
                                bool(task.get('isInteractive', False)) if task else False,
                                task_id,
                                gif_path,
                                run_user_id,
                                bool(task.get('isComplexTask', False)) if task else False
                            )
                        )
                        
                        # Wait for the web agent to complete with a timeout
                        result = await asyncio.wait_for(web_agent_task, timeout=timeout_seconds)
                        logger.info(f"Successfully completed web agent execution with {llm_name}")
                        
                    except asyncio.TimeoutError:
                        # Task execution timed out
                        logger.error(f"Task execution timed out after {timeout_seconds} seconds")
                        result = {
                            "success": False,
                            "error": f"Task execution timed out after {timeout_seconds} seconds",
                            "llm_name": llm_name
                        }
                        # Cancel the task to prevent it from continuing to run in the background
                        web_agent_task.cancel()
                        
                    except Exception as e:
                        # Other errors
                        logger.error(f"Error waiting for task execution: {str(e)}")
                        result = {
                            "success": False,
                            "error": f"Error waiting for task execution: {str(e)}",
                            "llm_name": llm_name
                        }
                        # Cancel the task if it's still running
                        if 'web_agent_task' in locals() and not web_agent_task.done():
                            web_agent_task.cancel()
                    
                    # Upload browser-use log to S3 if it exists
                    filtered_activity_log = f'logs/execution_{execution_id}_browser_use.filtered.log'

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
                            llm_name=llm_name
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
                            update_workflow_execution(execution['workflowExecutionId'], task_id, 'completed', result=result_summary)
                            logger.info(f"Updated workflow execution for task {task_id}")
                        except Exception as e:
                            logger.error(f"Error updating workflow execution: {e}", exc_info=True)
                    
                    success = True
                    break
                else:
                    last_error = result.get('error', 'Unknown error')
                    logger.warning(f"LLM {llm_name} failed with error: {last_error}")
            except Exception as e:
                last_error = str(e)
                logger.error(f"Error with LLM {llm_name}: {e}")

        # Upload activity log if it exists
        if filtered_activity_log and Path(filtered_activity_log).exists():
            upload_activity_log(filtered_activity_log, user_id, execution_id)
        
        if not success:
            error_message = f"All LLMs failed. Last error: {last_error}"
            try:
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
                    update_workflow_execution(execution['workflowExecutionId'], task_id, 'failed', error=error_message)
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
                update_workflow_execution(execution['workflowExecutionId'], task_id, 'failed', error=str(e))
                logger.info(f"Updated workflow execution status to failed for task {task_id} due to error")
            except Exception as workflow_error:
                logger.error(f"Error updating workflow execution after task error: {workflow_error}", exc_info=True)
    finally:
        running_task_count -= 1
        # Check if user_id exists in the set before removing it
        if user_id in running_user_ids:
            running_user_ids.remove(user_id)
        else:
            logger.warning(f"User ID {user_id} not found in running_user_ids set during cleanup. There could be multiple tasks running for the same user which may cause issues for cookie management.")
        # Remove task from tracking
        running_task_ids.pop(execution_id, None)
        logger.info(f"Task {execution_id} cleanup completed")

def get_pending_workflow_executions():
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

        response = dynamodb.Table(f'{TABLE_PREFIX}AW-WorkflowExecutions').query(**query_params)
        return response.get('Items', [])
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
                if dep_task.get('result'):
                    dependent_results.append(f"Result from task {dep_task_id}: {dep_task['result']}")

        # Get the task prompt from the workflow task
        task_prompt = task.get('prompt')
        if not task_prompt:
            logger.error(f"Task {task['taskId']} is missing prompt")
            return False

        # Add dependent results to prompt if any exist
        if dependent_results:
            task_prompt = f"""Previous task results:
{chr(10).join(dependent_results)}

Current task:
{task_prompt}"""

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

        # Update workflow task status to running
        update_workflow_execution(execution_id, task['taskId'], 'running')
        logger.info(f"Created execution {task_execution_id} for task {task['taskId']} in workflow {execution_id}")

        return True
    except Exception as e:
        logger.error(f"Error executing workflow task: {e}")
        return False

async def process_workflow_executions():
    try:
        pending_workflows = get_pending_workflow_executions()
        
        for workflow in pending_workflows:
            try:
                # Get tasks that are ready to execute (pending and dependencies met)
                pending_tasks = [
                    task for task in workflow['tasks'] 
                    if task['status'] == 'pending'
                ]

                # Sort tasks by order
                pending_tasks.sort(key=lambda x: x['order'])

                # Try to execute each pending task
                for task in pending_tasks:
                    await execute_workflow_task(workflow['executionId'], task)

            except Exception as e:
                logger.error(f"Error processing workflow {workflow['executionId']}: {e}")
                
    except Exception as e:
        logger.error(f"Error in process_workflow_executions: {e}")

async def monitor_executions():
    global last_execution_time

    INTERVAL = 5
    MAX_CONCURRENT = int(os.getenv('MAX_CONCURRENT_TASKS', '3'))
    logger.info(f"Starting execution monitor with interval of {INTERVAL} seconds, max concurrent tasks: {MAX_CONCURRENT}...")
    
    while True:
        try:
            # First, process schedules to create new executions
            await process_schedules()
            
            # Then process workflow executions
            await process_workflow_executions()
            
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