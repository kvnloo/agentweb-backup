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
import secrets_manager
import yaml
import random
from typing import Dict, Any, List, Optional
from task_utils import get_downloads_path, upload_activity_log, upload_gif, check_new_information, LogSyncManager, start_log_sync  # Import utility functions
import subprocess
import tempfile
import shutil
import re
import traceback
import threading
import resource
from email_utils import get_task_subscribers
import requests
from google.cloud import storage
from openai import AzureOpenAI
from task_utils import get_azure_openai_llm3, create_jwt_token
from knowledge_base_utils import get_knowledge_base_manager

# Increase file descriptor limit
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
resource.setrlimit(resource.RLIMIT_NOFILE, (min(hard, 4096), hard))

# Custom JSON encoder to handle datetime objects
class DateTimeEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        elif isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)

def safe_json_dumps(obj):
    """Helper function to dump JSON with datetime and Decimal handling"""
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

def create_email_friendly_html_revision(task_id, execution_id, html_asset_url, user_id):
    """
    Create an email-friendly HTML revision using the backend revision endpoint.
    
    Args:
        task_id: The ID of the task
        execution_id: The ID of the execution
        html_asset_url: The URL of the HTML asset
        user_id: The ID of the user who owns the task
        
    Returns:
        dict: Result with success status and revised asset URL if successful
    """
    try:
        # Get backend URL from environment
        backend_url = os.getenv('BACKEND_URL', 'http://localhost:3001')
        
        # Create JWT token for the user
        jwt_token = create_jwt_token(user_id)
        if not jwt_token:
            logger.error(f"Failed to create JWT token for user {user_id}")
            return {'success': False, 'error': 'Failed to create JWT token'}
        
        # Prepare the revision request data
        revision_data = {
            'revision_prompt': 'Make this HTML report email-friendly and mobile-friendly by ensuring it uses inline CSS styles and contains no JavaScript. If any charts rely on JavaScript (e.g., Chart.js), convert them to static, email-safe charts using Charts.css (pure CSS). Choose chart types that render well in email (prefer bar charts; avoid pie charts when labels/segments are small). If a chart will not read well in email, replace it with a clear HTML table of the underlying data, or remove the chart. Preserve all existing hyperlinks and their destinations (anchor text and href) exactly; do not strip or alter links. Do not reference or rely on any web version. Ensure the layout is responsive and mobile-friendly with appropriate font sizes, spacing, and table layouts that work well on small screens. Additionally, fix email client compatibility issues: replace "display: flex" with tables or "display: inline-block" + "text-align: center", avoid "gap", "box-shadow", "border-radius" properties, use tables for layout structure instead of divs, add explicit widths to tables and images, add "display: block" to images, use absolute URLs for image sources, add "border-collapse: collapse" to table styles, add "target=\'_blank\'" to all links, add xmlns="http://www.w3.org/1999/xhtml" to <html> tag, and use <!DOCTYPE html> declaration. Ensure good left and right edges by using proper table alignment, consistent margins, and avoiding content that extends beyond the container boundaries.',
            'report_url': html_asset_url,
            'original_execution_id': execution_id
        }
        
        logger.info(f"🔄 REVISION REQUEST: Creating email-friendly revision for task {task_id}")
        logger.info(f"📄 Original HTML URL: {html_asset_url}")
        logger.info(f"🎯 Revision prompt: {revision_data['revision_prompt']}")
        
        # Send the revision request to the backend using JWT authentication
        response = requests.post(
            f'{backend_url}/api/tasks/{task_id}/executions/revision',
            json=revision_data,
            headers={
                'Authorization': f'Bearer {jwt_token}',
                'Content-Type': 'application/json'
            },
            timeout=60  # Longer timeout for AI processing
        )
        
        if response.status_code == 201:
            result = response.json()
            if result.get('success') and result.get('resultFile'):
                logger.info(f"✅ REVISION SUCCESS: Email-friendly HTML revision created for task {task_id}")
                logger.info(f"📄 Revised file: {result['resultFile']['filename']}")
                logger.info(f"🔗 Revised URL: {result['resultFile']['url']}")
                return {
                    'success': True, 
                    'revised_asset_url': result['resultFile']['url'],
                    'revised_filename': result['resultFile']['filename']
                }
            else:
                logger.error(f"❌ REVISION ERROR: Backend returned error for HTML revision: {result.get('message', 'Unknown error')}")
                return {'success': False, 'error': result.get('message', 'Unknown error')}
        else:
            logger.error(f"❌ REVISION FAILED: HTTP {response.status_code}, Response: {response.text}")
            return {'success': False, 'error': f'HTTP {response.status_code}: {response.text}'}
            
    except Exception as e:
        logger.error(f"Error creating HTML revision: {e}")
        return {'success': False, 'error': str(e)}

def repair_image_embedding(task_id, execution_id, html_asset_url, user_id):
    """
    Repair image embeddings in HTML using the backend update-report endpoint.
    First checks if repair is needed by looking for relative image paths.
    
    Args:
        task_id: The ID of the task
        execution_id: The ID of the execution
        html_asset_url: The URL of the HTML asset
        user_id: The ID of the user who owns the task
        
    Returns:
        dict: Result with success status and updated asset URL if successful
    """
    try:
        # Check if repair is needed by checking for broken references
        execution = executions_table.get_item(
            Key={'executionId': execution_id},
            ProjectionExpression='result_files'
        ).get('Item', {})
        
        result_files = execution.get('result_files', [])
        result_urls = [file.get('url') for file in result_files if file.get('url') and file.get('url') != html_asset_url and file.get('file_type') == 'image']
        
        # Use the utility function to check if page is broken
        from task_utils import is_page_broken
        is_broken = is_page_broken(html_asset_url, result_urls)
        
        if not is_broken:
            logger.info(f"✅ NO REPAIR NEEDED: No broken references found in HTML for task {task_id}")
            return {'success': True, 'resultFile': {'url': html_asset_url}, 'no_repair_needed': True}
        
        logger.info(f"🔧 REPAIR NEEDED: Found broken references in HTML for task {task_id}")
        
        # Get backend URL from environment
        backend_url = os.getenv('BACKEND_URL', 'http://localhost:3001')
        
        # Create JWT token for the user
        jwt_token = create_jwt_token(user_id)
        if not jwt_token:
            logger.error(f"Failed to create JWT token for user {user_id}")
            return {'success': False, 'error': 'Failed to create JWT token'}
        
        # Prepare the update request data
        update_data = {
            'revision_prompt': 'Repair broken references in this HTML report. Fix two types of issues: 1) Broken image links that use relative paths (e.g., "./image.png", "images/chart.jpg", "/assets/logo.png") - replace these with full file paths from the available files list. 2) Missing references to available files - ensure all files in the available files list are properly referenced in the HTML using appropriate img src or a href attributes. If a matching file is not found in the available files list, it is fine to keep the broken reference as-is. Do not modify any other content, styling, or structure. Only fix src attributes of img tags and href attributes of a tags.',
            'report_url': html_asset_url,
            'execution_id': execution_id,
            'task_id': task_id
        }
        
        # Send the update request to the backend using JWT authentication
        response = requests.post(
            f"{backend_url}/api/tasks/executions/update-report",
            json=update_data,
            headers={
                'Authorization': f'Bearer {jwt_token}',
                'Content-Type': 'application/json'
            },
            timeout=300  # 5 minutes timeout
        )
        
        if response.status_code == 200:
            result = response.json()
            logger.info(f"✅ REPAIR SUCCESS: Image embeddings repaired for task {task_id}")
            return {'success': True, 'resultFile': result.get('resultFile')}
        else:
            logger.error(f"❌ REPAIR FAILED: HTTP {response.status_code}, Response: {response.text}")
            return {'success': False, 'error': f'HTTP {response.status_code}: {response.text}'}
            
    except Exception as e:
        logger.error(f"Error repairing image embeddings: {e}")
        return {'success': False, 'error': str(e)}

# Initialize DynamoDB client
dynamodb = get_dynamodb_resource()

# Initialize tables with environment-specific prefixes
executions_table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskExecutions')
tasks_table = dynamodb.Table(f'{TABLE_PREFIX}AW-Tasks')
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

async def trigger_scheduled_chats():
    """Trigger scheduled chats by calling the backend API."""
    try:
        # Get the backend API URL from environment variables
        backend_url = os.getenv('BACKEND_URL', 'http://localhost:3001')
        api_url = f"{backend_url}/api/agent-mode/run-scheduled-chats"

        # Service-to-service auth (ENG-347): shared secret known to both the
        # agent-engine and the backend. Sent whenever configured; the backend
        # enforces it once its own SCHEDULED_CHATS_SERVICE_SECRET is set, so
        # set the env var here BEFORE setting it on the backend.
        headers = {'Content-Type': 'application/json'}
        service_secret = secrets_manager.get_scheduled_chats_service_secret()
        if service_secret:
            headers['x-service-secret'] = service_secret

        # Make the API call
        response = requests.post(
            api_url,
            headers=headers,
            timeout=300  # 5 minute timeout for scheduled chat processing
        )
        
        if response.status_code == 200:
            result = response.json()
            processed_count = result.get('processed', 0)
            if processed_count > 0:
                logger.info(f"Triggered {processed_count} scheduled chats")
            
            # Log individual results if available
            if 'results' in result:
                for res in result['results']:
                    if res.get('status') == 'success':
                        logger.info(f"✓ Successfully ran scheduled chat: {res.get('scheduleName', 'Unknown')}")
                    elif res.get('status') == 'started':
                        logger.info(f"→ Started scheduled chat: {res.get('scheduleName', 'Unknown')}")
                    elif res.get('status') == 'error':
                        logger.error(f"✗ Failed to run scheduled chat: {res.get('scheduleName', 'Unknown')} - {res.get('error', 'Unknown error')}")
                    else:
                        logger.info(f"→ Scheduled chat {res.get('scheduleName', 'Unknown')} status: {res.get('status', 'unknown')}")
        else:
            logger.error(f"Failed to trigger scheduled chats. Status: {response.status_code}, Response: {response.text}")
            
    except requests.exceptions.RequestException as e:
        logger.error(f"Request error when triggering scheduled chats: {e}")
    except Exception as e:
        logger.error(f"Unexpected error when triggering scheduled chats: {e}")

async def process_schedules():
    """Process scheduled chats by triggering the backend API.

    Note: The legacy task scheduling feature (recurring task executions) has been
    deprecated in favor of scheduled chats, which are fully managed by the backend.
    """
    try:
        await trigger_scheduled_chats()
    except Exception as e:
        logger.error(f"Error in process_schedules: {e}")

def update_execution_status(execution_id, status, result=None, error=None, details_gif=None, prompt=None, llm_name=None, output_as_json=False, image_model=None):
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
            
        if image_model is not None:
            update_expression += ", imageModel = :imageModel"
            expression_values[':imageModel'] = image_model

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
                    ProjectionExpression='userId, #n, emailNotification, requireApproval, slackChannel, emailFriendlyHtml, repairImageEmbedding, htmlFormatInstructions',
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
                    
                    # Process HTML assets for repair and email-friendly features (independent of approval requirements)
                    # Determine the expected asset type from execution record
                    expected_asset_type = execution.get('approvalAssetType')
                    
                    # Find the asset matching the expected type in result_files
                    asset_file = None
                    asset_type = None
                    if execution.get('result_files'):
                        for file_info in execution['result_files']:
                            # If we have an expected asset type, look for that specific type
                            if expected_asset_type:
                                if file_info.get('view_type') == expected_asset_type:
                                    asset_file = file_info
                                    asset_type = expected_asset_type
                                    break
                            else:
                                # Fallback: Check if file is HTML using view_type
                                if file_info.get('view_type') == 'html':
                                    asset_file = file_info
                                    asset_type = 'html'
                                    break
                    
                    if asset_file:
                        revisionDone = False
                        
                        # For HTML assets, repair image embeddings first if enabled
                        # This updates the current HTML before any other processing
                        if asset_type == 'html' and task.get('repairImageEmbedding', False):
                            logger.info(f"🔧 REPAIR IMAGE EMBEDDING MODE: Repairing image embeddings for task {execution['taskId']} (repairImageEmbedding={task.get('repairImageEmbedding', False)})")
                            repair_result = repair_image_embedding(
                                task_id=execution['taskId'],
                                execution_id=execution_id,
                                html_asset_url=asset_file['url'],
                                user_id=task['userId']
                            )
                            
                            if repair_result['success']:
                                if repair_result.get('no_repair_needed'):
                                    # No repair was needed, continue with original HTML
                                    logger.info(f"✅ NO REPAIR NEEDED: HTML already has proper image links for task {execution['taskId']}")
                                else:
                                    # Repair was successful, update the asset_file URL to the repaired version
                                    asset_file['url'] = repair_result['resultFile']['url']
                            else:
                                logger.warning(f"❌ REPAIR FAILED: {repair_result['error']}. Continuing with original HTML.")
                        
                        # For HTML assets, create an email-friendly revision after repair
                        # Only if the task has emailFriendlyHtml enabled
                        if asset_type == 'html' and task.get('emailFriendlyHtml', False):
                            logger.info(f"📧 EMAIL-FRIENDLY MODE: Creating email-friendly HTML revision for task {execution['taskId']}")
                            revision_result = create_email_friendly_html_revision(
                                task_id=execution['taskId'],
                                execution_id=execution_id,
                                html_asset_url=asset_file['url'],  # This will be the repaired URL if repair was successful
                                user_id=task['userId']
                            )
                            
                            if revision_result['success']:
                                # Revision was successful; ensure subsequent emails (no-approval flow)
                                # use the email-friendly revised HTML by updating the asset reference
                                logger.info(f"✅ EMAIL-FRIENDLY SUCCESS: Revision created and approval request already sent")
                                try:
                                    revised_url = revision_result.get('revised_asset_url')
                                    revised_filename = revision_result.get('revised_filename')
                                    if revised_url:
                                        # Update only in-memory reference so email sending uses revised HTML
                                        asset_file['url'] = revised_url
                                        if revised_filename:
                                            asset_file['filename'] = revised_filename
                                except Exception as ref_err:
                                    logger.warning(f"Failed to update asset reference to revised HTML: {ref_err}")

                                revisionDone = True
                            else:
                                logger.warning(f"❌ EMAIL-FRIENDLY FAILED: {revision_result['error']}. Falling back to original HTML for approval.")
                                # revisionDone remains False, will send approval below

                        # For HTML assets, apply instruction-based revision after prior steps
                        # Only if htmlFormatInstructions is present (non-empty)
                        if asset_type == 'html' and task.get('htmlFormatInstructions'):
                            instructions = task.get('htmlFormatInstructions') or ''
                            try:
                                backend_url = os.getenv('BACKEND_URL', 'http://localhost:3001')
                                jwt_token = create_jwt_token(task['userId'])
                                if jwt_token:
                                    revision_data = {
                                        'revision_prompt': f"Apply the following formatting instructions to the current HTML. Keep links and core content unchanged. Avoid JavaScript. Ensure responsiveness.\n\n--- INSTRUCTIONS START ---\n{instructions}\n--- INSTRUCTIONS END ---\n",
                                        'report_url': asset_file['url'],
                                        'original_execution_id': execution_id
                                    }
                                    response = requests.post(
                                        f"{backend_url}/api/tasks/{execution['taskId']}/executions/revision",
                                        json=revision_data,
                                        headers={
                                            'Authorization': f'Bearer {jwt_token}',
                                            'Content-Type': 'application/json'
                                        },
                                        timeout=60
                                    )
                                    if response.status_code == 201:
                                        result = response.json()
                                        if result.get('success') and result.get('resultFile'):
                                            revised_url = result['resultFile'].get('url')
                                            revised_filename = result['resultFile'].get('filename')
                                            if revised_url:
                                                asset_file['url'] = revised_url
                                            if revised_filename:
                                                asset_file['filename'] = revised_filename
                                            logger.info("✅ FORMAT INSTRUCTIONS APPLY SUCCESS: Revised HTML created")
                                        else:
                                            logger.warning(f"❌ FORMAT INSTRUCTIONS APPLY ERROR: {result.get('message', 'Unknown error')}")
                                    else:
                                        logger.warning(f"❌ FORMAT INSTRUCTIONS APPLY FAILED HTTP {response.status_code}: {response.text}")
                                else:
                                    logger.error("Failed to create JWT token for instruction-based revision")
                            except Exception as e:
                                logger.warning(f"Failed to apply htmlFormatInstructions: {e}")
                    
                    # Check if task requires approval (regardless of subscribers)
                    # This ensures approval requests are sent even for tasks with no subscribers
                    # Use execution-level channel info if available (for revisions), otherwise use task-level
                    slack_channel = execution.get('slack_channel') or task.get('slackChannel')
                    # Use execution-level requireApproval if available (for revisions), otherwise use task-level
                    requires_approval = execution.get('requireApproval') if execution.get('requireApproval') is not None else task.get('requireApproval')
                    if requires_approval and slack_channel and asset_file:
                        # Send Slack approval request instead of emails
                        logger.info(f"Task {execution['taskId']} requires approval. Sending Slack approval request.")
                        try:
                            # Send Slack approval request if no revision was done or revision failed
                            if not revisionDone:
                                from slack_utils import send_task_approval_request
                                send_task_approval_request(
                                    task_id=execution['taskId'],
                                    task_name=task['name'],
                                    execution_id=execution_id,
                                    asset_url=asset_file['url'],
                                    filename=asset_file['filename'],
                                    asset_type=asset_type,
                                    slack_channel=slack_channel,
                                    user_id=task['userId']
                                )
                                logger.info(f"📤 APPROVAL SENT: For task {execution['taskId']} to channel {slack_channel}")
                        except Exception as e:
                            logger.error(f"Failed to send Slack approval request for task {execution['taskId']}: {e}")
                    else:
                        if requires_approval and not slack_channel:
                            logger.warning(f"Task {execution['taskId']} requires approval but no Slack channel configured")
                        elif requires_approval and not asset_file:
                            expected_msg = f" (expected: {expected_asset_type})" if expected_asset_type else ""
                            logger.warning(f"No {expected_asset_type or 'HTML report'} found for task {execution['taskId']} that requires approval{expected_msg}")
                    
                    # Send detailed results to all subscribers (if any and not requiring approval)
                    if has_subscribers and not (requires_approval and slack_channel):
                        # If an email-friendly revision was created, send only that asset file
                        files_for_email = [asset_file] if (asset_file and asset_type == 'html' and revisionDone) else (execution.get('result_files', []) or [])

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
                            result_files=files_for_email,
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

async def run_web_agent_cli(user_id: str, llm_name: str, prompt: str, execution_id: str, is_interactive: bool, task_id: str, gif_path: str, run_user_id: str = None, is_complex_task: bool = False, extract_page_content: bool = False, validate_output: bool = False, output_as_json: bool = False, is_agentic_dev_mode: bool = False, output_as_html: bool = False, use_shared_browser: bool = False, turn_off_headless: bool = False, use_knowledge_base: bool = False, update_knowledge_base: bool = False, update_lead_list: bool = False, lead_list_identifier: str = None, has_attachments: bool = False, create_video: bool = False, video_model: str = None, image_model: str = None) -> Dict[str, Any]:
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
        if update_knowledge_base:
            cmd.append('--update-knowledge-base')
        if update_lead_list:
            cmd.append('--update-lead-list')
        if lead_list_identifier:
            cmd.extend(['--lead-list-identifier', lead_list_identifier])
        if has_attachments:
            cmd.append('--has-attachments')
        if create_video:
            cmd.append('--create-video')
        if video_model:
            cmd.extend(['--video-model', video_model])
        if image_model:
            cmd.extend(['--image-model', image_model])
        
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

            lead_list_identifier = task.get('leadListIdentifier') if task else None

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
            
            # Check if this is a revision execution
            revision_prompt = execution.get('revision_prompt')
            original_image_url = execution.get('original_image_url')
            original_report_url = execution.get('original_report_url')
            original_execution_id = execution.get('original_execution_id')
            
            if revision_prompt and (original_image_url or original_report_url):
                # This is a revision execution - use the revision prompt as the main task
                logger.info(f"Processing revision execution for task {task_id} execution {execution_id}")
                logger.info(f"Original execution: {original_execution_id}")
                
                # Get variations count for image revisions
                variations = execution.get('variations', 1)
                logger.info(f"Image revision variations requested: {variations}")
                
                if original_image_url:
                    logger.info(f"Original image: {original_image_url}")
                    # Image revision
                    prompt = f"""Task: Create {variations} image{'s' if variations > 1 else ''} based on the revision prompt and the original image. Use download_image to download reference images and generate_image to create the result images. Valid size values for generate_image include "1024x1024", "1536x1024", "1024x1536", "auto". Valid quality values for generate_image include "low", "medium", "high", "auto". DO NOT browse the internet for other images.\n\n
                    Revision Prompt: {revision_prompt}\n    
                    Original Image URL: {original_image_url}\n\n"""
                elif original_report_url:
                    logger.info(f"Original report: {original_report_url}")
                    # HTML report revision - use download_file and read_attached_file
                    prompt = f"""Task: Create a new HTML report based on the revision prompt and the original report. Use original task as context.

IMPORTANT: This is a revision of an HTML report. You must:
1. Use the 'download_file' action to download the original report from: {original_report_url}
2. Use the 'read_attached_file' action to read the raw HTML content of the downloaded file
3. Analyze the current content and create a revised version based on the revision prompt
4. Use the 'write_file' action to create the new HTML report with your improvements

Revision Prompt: {revision_prompt}

Context - Original Task: {base_prompt}"""
            else:
                # Regular execution - add user feedback if provided
                user_feedback = execution.get('feedback')
                if user_feedback:
                    base_prompt = f"{base_prompt}\n\nUser Feedback for Improvement: {user_feedback}"
                    logger.info(f"Added user feedback to task {task_id} execution {execution_id}: {user_feedback}")
                else:
                    logger.info(f"No user feedback provided for task {task_id} execution {execution_id}")
                
                if previous_feedback:
                    prompt = f"Task: {base_prompt}\n\nNote: Previous attempt {previous_feedback['time_ago']} was {previous_feedback['feedback']}. Previous result: {previous_feedback['result']}"
                else:
                    prompt = f"Task: {base_prompt}"
                
                # Add CAPTCHA/reCAPTCHA handling instruction
                prompt += "\n\nImportant: If you encounter CAPTCHA or reCAPTCHA challenges when visiting websites, immediately stop trying to access that website and seek alternative web sources instead. Do not attempt to solve or bypass CAPTCHA challenges - simply move on to other sources of information."

            # Add attachment information if present
            has_attachments = bool(task.get('attachments'))
            if has_attachments:
                attachment_list = "\n".join([f"- {attachment['filename']} (URL: {attachment['url']})" for attachment in task['attachments']])
                prompt += f"\n\nThe following files are attached to this task:\n{attachment_list}"
            
            # Check for lead list data
            try:
                lead_list_table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskLeadList')
                lead_list_response = lead_list_table.query(
                    KeyConditionExpression='taskId = :taskId',
                    ExpressionAttributeValues={
                        ':taskId': task_id
                    },
                    Select='COUNT'
                )
                lead_count = lead_list_response.get('Count', 0)
                
                if lead_count > 0:
                    prompt += f"\n\nNote: This task has a lead list with {lead_count} records. Each record is uniquely identified by field {lead_list_identifier}. You can use the perform_data_analysis action with include_lead_list=True to analyze this lead list data along with any available files."
                    logger.info(f"Task {task_id} has {lead_count} lead list records available for analysis")
            except Exception as e:
                logger.warning(f"Error checking lead list for task {task_id}: {e}")
                # Continue execution even if lead list check fails
            
            # Update execution status to running and include the prompt
            update_execution_status(execution_id, 'running', prompt=prompt)
        else:
            # For new tasks (task- prefix), use the prompt from the execution record
            prompt = execution.get('prompt')
            if not prompt:
                raise Exception(f"No prompt found for task {task_id}")
            
            # Add user feedback if provided for workflow tasks
            user_feedback = execution.get('feedback')
            if user_feedback:
                prompt = f"{prompt}\n\nUser Feedback for Improvement: {user_feedback}"
                logger.info(f"Added user feedback to workflow task {task_id} execution {execution_id}: {user_feedback}")
            else:
                logger.info(f"No user feedback provided for workflow task {task_id} execution {execution_id}")
            
            # Update execution status to running
            update_execution_status(execution_id, 'running')
            has_attachments = False

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
                    raise RuntimeError("Deep research is deprecated and no longer supported.")
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
                        update_knowledge_base = bool(task.get('updateKnowledgeBase', False)) if task else False
                        update_lead_list = bool(task.get('updateLeadList', False)) if task else False
                        create_video = bool(task.get('createVideo', False)) if task else False
                        video_model = task.get('videoModel') if task else None
                        image_model = task.get('imageModel') if task else None
                        # If no image model is set in task, use the default from environment
                        if not image_model:
                            image_model = os.getenv('DEFAULT_IMAGE_MODEL', "openai-image-1")
                        
                        # Override has_attachments for HTML report revisions to enable read_attached_file
                        if original_report_url and revision_prompt:
                            has_attachments = True
                            logger.info(f"Enabled has_attachments for HTML report revision: {execution_id}")
                        
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
                            use_knowledge_base,
                            update_knowledge_base,
                            update_lead_list,
                            lead_list_identifier,
                            has_attachments,
                            create_video,
                            video_model,
                            image_model
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
                            output_as_json=output_as_json,
                            image_model=image_model
                        )
                        logger.info(f"Updated execution status to completed for {execution_id}")

                        # Update knowledge base if enabled
                        if update_knowledge_base:
                            try:
                                logger.info(f"Starting knowledge base update for task {task_id}")
                                # Initialize clients
                                storage_client = storage.Client()
                                openai_client = get_azure_openai_llm3('gpt-5-chat')

                                # Determine which bucket to use based on knowledgeBaseType
                                bucket_type = task.get('knowledgeBaseType', 'private')
                                bucket_name = os.getenv('GCS_BUCKET_NAME') if bucket_type == 'public' else os.getenv('GCS_BUCKET_NAME_PRIVATE')
                                bucket = storage_client.bucket(bucket_name)
                                file_name = f"tasks/{task_id}/knowledge-base.txt"
                                blob = bucket.blob(file_name)

                                # Get current content if exists
                                current_content = ''
                                if blob.exists():
                                    current_content = blob.download_as_text()

                                # Process result files
                                result_files_content = ''
                                if result.get('result_files'):
                                    text_files = [f for f in result['result_files'] if f['filename'].endswith(('.html', '.txt', '.md'))]
                                    for file in text_files:
                                        try:
                                            # Get the download path for the file
                                            downloads_path = get_downloads_path(user_id=user_id, execution_id=execution_id)
                                            file_path = os.path.join(downloads_path, file['filename'])
                                            with open(file_path, 'r') as f:
                                                content = f.read()
                                                result_files_content += f"\n\nContent from {file['filename']}:\n{content}"
                                        except Exception as e:
                                            logger.error(f"Error reading file {file['filename']}: {e}")

                                # Use OpenAI to analyze the execution and suggest knowledge base updates
                                prompt = f"""Analyze the following task execution and suggest updates to the knowledge base. 
                                Current knowledge base content:
                                {current_content}
                                
                                Task execution details:
                                Task: {task['name']}
                                Prompt: {task['prompt']}
                                Result: {result.get('summary', '')}
                                Error: {result.get('error', 'None')}
                                {result_files_content if result_files_content else ''}
                                
                                Based on the above information, provide ONLY the updated markdown content for the knowledge base. Do not include any explanations, notes, or additional text. Output only the markdown content that should replace the current knowledge base content."""

                                try:
                                    # Call OpenAI to get the updated content
                                    from langchain_core.messages import HumanMessage
                                    messages = [HumanMessage(content=prompt)]
                                    completion = openai_client.invoke(messages)
                                    updated_content = completion.content or ''

                                    # Calculate knowledge base size
                                    knowledge_base_size = len(updated_content.encode('utf-8'))

                                    # Use KnowledgeBaseManager to save the content
                                    from knowledge_base_utils import get_knowledge_base_manager
                                    kb_manager = get_knowledge_base_manager(bucket_type=bucket_type, user_id=user_id)
                                    
                                    # Save updated knowledge base
                                    kb_manager.save_knowledge(
                                        content=updated_content,
                                        bucket_name=bucket_name,
                                        file_path=file_name
                                    )

                                    # Update the task record with knowledge base information
                                    try:
                                        tasks_table.update_item(
                                            Key={'taskId': task_id},
                                            UpdateExpression='SET knowledgeBase = :url, knowledgeBaseSize = :size, knowledgeBaseUpdatedAt = :updatedAt',
                                            ExpressionAttributeValues={
                                                ':url': "", # Not used
                                                ':size': knowledge_base_size,
                                                ':updatedAt': datetime.now(timezone.utc).isoformat()
                                            }
                                        )
                                    except Exception as task_update_error:
                                        logger.error(f"Failed to update task record: {str(task_update_error)}")

                                    # Update the execution record with knowledge base information
                                    try:
                                        executions_table.update_item(
                                            Key={'executionId': execution_id},
                                            UpdateExpression='SET knowledge_base_updated_at = :updatedAt',
                                            ExpressionAttributeValues={
                                                ':updatedAt': datetime.now(timezone.utc).isoformat()
                                            }
                                        )
                                    except Exception as execution_update_error:
                                        logger.error(f"Failed to update execution record: {str(execution_update_error)}")

                                    logger.info("Knowledge base update completed successfully")
                                except Exception as e:
                                    logger.error(f"Error updating knowledge base: {e}")
                                    raise
                            except Exception as e:
                                logger.error(f"Error updating execution status: {e}")
                                raise
                    except Exception as e:
                        logger.error(f"Error updating execution status: {e}")
                    
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
            if pending_executions:
                for execution in pending_executions:
                    user_id = execution['userId']
                    
                    if running_task_count < MAX_CONCURRENT:
                        # Increment the counter to reserve the slot
                        running_task_count += 1
                        running_user_ids.add(user_id)
                        logger.info(f"Running task count: {running_task_count}, user_id: {user_id}")

                        task = asyncio.create_task(execute_task(execution))

                        executed_count += 1
                    else:
                        # If we can't start more tasks, break out of the loop
                        break
                
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
