#!/usr/bin/env python3
import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import logging
from dotenv import load_dotenv
from datetime import datetime
from aws_utils import get_dynamodb_resource
from task_utils import check_new_information

# Load environment variables
load_dotenv()

# Get table prefix based on NODE_ENV
TABLE_PREFIX = 'Dev-' if os.getenv('NODE_ENV') == 'development' else ''

logger = logging.getLogger(__name__)

# Initialize DynamoDB client with credentials
dynamodb = get_dynamodb_resource()

# Initialize tables with environment-specific prefixes
subscribers_table = dynamodb.Table(f'{TABLE_PREFIX}AW-Subscribers')
users_table = dynamodb.Table(f'{TABLE_PREFIX}AW-Users')
executions_table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskExecutions')

def get_task_subscribers(task_id):
    """
    Get all subscribers for a given task.
    """
    try:
        response = subscribers_table.query(
            KeyConditionExpression='taskId = :taskId',
            ExpressionAttributeValues={
                ':taskId': task_id
            }
        )
        return [item['email'] for item in response.get('Items', [])]
    except Exception as e:
        logger.error(f"Failed to get task subscribers: {e}")
        return []

def send_task_notification(to_email, task_name, task_id, execution_status, execution_id=None, result=None, error=None, new_info_summary=None):
    """
    Send an email notification about task completion.
    """
    try:
        smtp_host = os.getenv('SMTP_HOST', 'smtp.gmail.com')
        smtp_port = int(os.getenv('SMTP_PORT', '587'))
        smtp_user = os.getenv('SMTP_USER')
        smtp_pass = os.getenv('SMTP_PASS')
        from_email = os.getenv('FROM_EMAIL')
        site_domain = os.getenv('SITE_DOMAIN', 'http://localhost:3000')

        if not all([smtp_user, smtp_pass, to_email]):
            logger.error("Missing email configuration")
            return False

        msg = MIMEMultipart()
        msg['From'] = from_email
        msg['Reply-To'] = 'support@agentweb.pro'
        msg['To'] = to_email
        # Modify subject if new information was found
        if new_info_summary:
            msg['Subject'] = f"Task Run {execution_status}: {task_name} [NEW: {new_info_summary}]"
        else:
            msg['Subject'] = f"Task Run {execution_status}: {task_name}"

        # Create email body
        body = f"""
        Your task "{task_name}" has completed with status: {execution_status}

        View task details: {site_domain}/tasks/{task_id}
"""
        if result:
            body += f"\nResult:\n{result}"
        if error:
            body += f"\nError:\n{error}"

        msg.attach(MIMEText(body, 'plain'))

        # Send email
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)

        logger.info(f"Sent task completion notification to {to_email}")
        return True

    except Exception as e:
        logger.error(f"Failed to send email notification: {e}")
        return False

def send_task_results(to_email, task_name, task_id, execution_status, result=None, error=None, start_time=None, end_time=None, new_info_summary=None):
    """
    Send a detailed task results email to subscribers.
    """
    try:
        smtp_host = os.getenv('SMTP_HOST', 'smtp.gmail.com')
        smtp_port = int(os.getenv('SMTP_PORT', '587'))
        smtp_user = os.getenv('SMTP_USER')
        smtp_pass = os.getenv('SMTP_PASS')
        from_email = os.getenv('FROM_EMAIL')
        site_domain = os.getenv('SITE_DOMAIN', 'http://localhost:3000')

        if not all([smtp_user, smtp_pass, to_email]):
            logger.error("Missing email configuration")
            return False

        msg = MIMEMultipart()
        msg['From'] = from_email
        msg['Reply-To'] = 'support@agentweb.pro'
        msg['To'] = to_email
        
        # Modify subject if new information was found
        if new_info_summary:
            msg['Subject'] = f"Task Run Results: {task_name} [NEW: {new_info_summary}]"
        else:
            msg['Subject'] = f"Task Run Results: {task_name}"

        # Format timestamps if provided
        start_time_str = f"{start_time.strftime('%B %d, %Y at %I:%M %p UTC')}" if start_time else "Not available"
        end_time_str = f"{end_time.strftime('%B %d, %Y at %I:%M %p UTC')}" if end_time else "Not available"
        
        # Calculate duration if both timestamps are available
        duration_str = ""
        if start_time and end_time:
            duration = end_time - start_time
            minutes = duration.total_seconds() / 60
            if minutes < 1:
                duration_str = f"Duration: {int(duration.total_seconds())} seconds"
            else:
                duration_str = f"Duration: {int(minutes)} minutes"

        # Create a detailed and formatted email body
        body = f"""
Task Run Results for "{task_name}"
{'=' * (18 + len(task_name))}

Status: {execution_status.upper()}
Started: {start_time_str}
Completed: {end_time_str}
{duration_str}

"""
        if result:
            body += f"""
Results Summary:
---------------
{result}
"""
        
        if error:
            body += f"""
Error Details:
-------------
{error}
"""

        body += f"""

View complete task details and history:
{site_domain}/tasks/{task_id}

---
This is an automated message from AgentWeb.
You are receiving this email because you are subscribed to updates for this task.
"""

        msg.attach(MIMEText(body, 'plain'))

        # Send email
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)

        logger.info(f"Sent task run results to subscriber: {to_email}")
        return True

    except Exception as e:
        logger.error(f"Failed to send task results email: {e}")
        return False

def notify_task_subscribers(task_id, task_name, execution_status, execution_id=None, result=None, error=None, start_time=None, end_time=None, new_info_summary=None):
    """
    Send detailed task results to all subscribers.
    """
    subscribers = get_task_subscribers(task_id)
    logger.info(f"Found {len(subscribers)} subscribers for task {task_id}")
    
    for subscriber_email in subscribers:
        success = send_task_results(
            subscriber_email,
            task_name,
            task_id,
            execution_status,
            result,
            error,
            start_time,
            end_time,
            new_info_summary
        )
        
        if success:
            logger.info(f"Successfully sent results to subscriber: {subscriber_email}")
        else:
            logger.error(f"Failed to send results to subscriber: {subscriber_email}")

def get_previous_execution(task_id, current_execution_id=None):
    """
    Get the most recent previous execution for a task that is not the current execution.
    
    Args:
        task_id (str): The task ID to find previous executions for
        current_execution_id (str, optional): The current execution ID to exclude
        
    Returns:
        dict: The previous execution or None if not found
    """
    try:
        # Query for completed executions for this task
        query_params = {
            'IndexName': 'TaskIdIndex',
            'KeyConditionExpression': 'taskId = :taskId',
            'FilterExpression': '#status = :status',
            'ExpressionAttributeNames': {
                '#status': 'status'
            },
            'ExpressionAttributeValues': {
                ':taskId': task_id,
                ':status': 'completed'
            },
            'ScanIndexForward': False,  # Sort by startTime in descending order (most recent first)
            'Limit': 5  # Get the latest few to find one with a different result
        }
        
        # If execution_id is provided, add it to the filter expression
        if current_execution_id:
            query_params['FilterExpression'] += ' AND executionId <> :executionId'
            query_params['ExpressionAttributeValues'][':executionId'] = current_execution_id
            logger.info(f"Excluding current execution {current_execution_id} when looking for previous executions")
        
        completed_executions = executions_table.query(**query_params).get('Items', [])
        
        if completed_executions:
            previous_execution = completed_executions[0]
            logger.info(f"Found previous execution {previous_execution.get('executionId')} for task {task_id}")
            return previous_execution
        
        return None
    except Exception as e:
        logger.error(f"Error finding previous execution: {e}")
        return None

def send_oncall_alert(task_name, task_id, error, llm_names_tried):
    """
    Send an alert to the oncall team when a task fails with all LLMs.
    """
    try:
        smtp_host = os.getenv('SMTP_HOST', 'smtp.gmail.com')
        smtp_port = int(os.getenv('SMTP_PORT', '587'))
        smtp_user = os.getenv('SMTP_USER')
        smtp_pass = os.getenv('SMTP_PASS')
        from_email = os.getenv('FROM_EMAIL')
        site_domain = os.getenv('SITE_DOMAIN', 'http://localhost:3000')
        oncall_emails = os.getenv('ONCALL_EMAIL_LIST', '').split(',')

        if not all([smtp_user, smtp_pass]) or not oncall_emails:
            logger.error("Missing email configuration or ONCALL_EMAIL_LIST")
            return False

        msg = MIMEMultipart()
        msg['From'] = from_email
        msg['Reply-To'] = 'support@agentweb.pro'
        msg['To'] = ', '.join(oncall_emails)
        msg['Subject'] = f"[URGENT] Task Failed with All LLMs: {task_name}"

        body = f"""
⚠️ ALERT: Task Failure Across All LLMs ⚠️

Task Name: {task_name}
Task ID: {task_id}

Error Details:
-------------
{error}

LLMs Attempted:
--------------
{', '.join(llm_names_tried)}

View task details: {site_domain}/tasks/{task_id}

This is an urgent alert that needs immediate assistance.
All configured LLMs have failed to execute this task.
"""

        msg.attach(MIMEText(body, 'plain'))

        # Send email to all oncall recipients
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)

        logger.info(f"Sent oncall alert to {oncall_emails}")
        return True

    except Exception as e:
        logger.error(f"Failed to send oncall alert: {e}")
        return False 