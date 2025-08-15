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
import requests # Added for fetching HTML content

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

def send_task_notification(to_email, task_name, task_id, execution_status, execution_id=None, result=None, error=None, new_info_summary=None, llm_name=None):
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
        if llm_name:
            body += f"LLM Used: {llm_name}\n"
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

def send_task_results(to_email, task_name, task_id, execution_status, result=None, error=None, start_time=None, end_time=None, new_info_summary=None, result_files=None, llm_name=None):
    """
    Send a detailed task results email to subscribers.
    Sends content as HTML only.
    Includes HTML content if available in result_files.
    """
    try:
        smtp_host = os.getenv('SMTP_HOST', 'smtp.gmail.com')
        smtp_port = int(os.getenv('SMTP_PORT', '587'))
        smtp_user = os.getenv('SMTP_USER')
        smtp_pass = os.getenv('SMTP_PASS')
        from_email = os.getenv('FROM_EMAIL')
        site_domain = os.getenv('SITE_DOMAIN', 'http://localhost:3000')

        if not all([smtp_user, smtp_pass, to_email]):
            logger.error("Missing email configuration for send_task_results")
            return False

        subject_prefix = "Task Run Results:"
        subject = f"{subject_prefix} {task_name}"
        if new_info_summary:
            subject = f"{subject_prefix} {task_name} [NEW: {new_info_summary}]"

        start_time_str = f"{start_time.strftime('%B %d, %Y at %I:%M %p UTC')}" if start_time else "Not available"
        end_time_str = f"{end_time.strftime('%B %d, %Y at %I:%M %p UTC')}" if end_time else "Not available"
        
        duration_str = ""
        if start_time and end_time:
            duration = end_time - start_time
            minutes = duration.total_seconds() / 60
            duration_value = f"{int(duration.total_seconds())} seconds" if minutes < 1 else f"{int(minutes)} minutes"
            duration_str = f"<p><strong>Duration:</strong> {duration_value}</p>"


        # --- Fetch HTML content from result_files ---
        html_content_from_file_section = ""
        if result_files:
            for file_info in result_files:
                if file_info.get('view_type') == 'html' and file_info.get('url'):
                    try:
                        response = requests.get(file_info['url'], timeout=10)
                        response.raise_for_status() # Raise an exception for HTTP errors
                        fetched_html_content = response.text
                        html_content_from_file_section = f"""<div class="html-result">
    <h3>HTML Result File:</h3>
    {fetched_html_content}
</div>"""
                        logger.info(f"Successfully fetched HTML content from {file_info['url']}")
                        break # Use the first HTML file found
                    except requests.RequestException as e:
                        logger.error(f"Failed to fetch HTML content from {file_info['url']}: {e}")
                        html_content_from_file_section = f"""<div class="html-result">
    <h3>HTML Result File:</h3>
    <p><i>Error fetching HTML content from {file_info['url']}: {e}</i></p>
</div>"""
                    except Exception as e: # Catch any other unexpected errors
                        logger.error(f"Unexpected error fetching HTML content from {file_info['url']}: {e}")
                        html_content_from_file_section = f"""<div class="html-result">
    <h3>HTML Result File:</h3>
    <p><i>Unexpected error fetching HTML content from {file_info['url']}.</i></p>
</div>"""
                    break # Process only the first HTML file found, even if error

        # --- Construct HTML Body ---
        html_body_content = f"""<html>
<head>
  <style>
    body {{ font-family: sans-serif; margin: 0; padding: 0; color: #333; background-color: #fff; }}
    .container {{ /* max-width: 800px; margin: auto; */ padding: 20px; /* border: 1px solid #ddd; border-radius: 8px; */ background-color: #fdfdfd; }}
    .header {{ font-size: 1.5em; font-weight: bold; margin-bottom: 15px; color: #2c3e50; }}
    .details {{ margin-bottom: 20px; padding: 15px; border: 1px solid #eee; background-color: #f9f9f9; border-radius: 5px; }}
    .details p {{ margin: 5px 0; }}
    .section {{ margin-top: 20px; }}
    .section h3 {{ font-size: 1.2em; margin-top: 0; border-bottom: 2px solid #ecf0f1; padding-bottom: 8px; color: #34495e; }}
    pre {{ white-space: pre-wrap; word-wrap: break-word; background: #ecf0f1; padding: 15px; border-radius: 5px; font-size: 0.9em; color: #555; }}
    .html-result {{ border: 1px solid #ddd; padding: 10px; margin-top: 15px; border-radius: 5px; }}
    .html-result h3 {{ margin-top:0; }}
    .footer {{ margin-top: 25px; font-size: 0.9em; color: #7f8c8d; }}
    a {{ color: #3498db; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">Task Run Results for "{task_name}"</div>
    <div class="details">
      <p><strong>Status:</strong> {execution_status.upper()}</p>
      <p><strong>Started:</strong> {start_time_str}</p>
      <p><strong>Completed:</strong> {end_time_str}</p>
      {f'<p><strong>LLM Used:</strong> {llm_name}</p>' if llm_name else ''}
      {duration_str}
    </div>
"""
        if result:
            html_body_content += f"""<div class="section">
    <h3>Results Summary:</h3>
    <pre>{result}</pre>
</div>"""
        if error:
            html_body_content += f"""<div class="section">
    <h3>Error Details:</h3>
    <pre>{error}</pre>
</div>"""
        
        html_body_content += html_content_from_file_section

        html_body_content += f"""
    <div class="footer">
      <p>Manage task and history at: <a href="{os.getenv('CUSTOMER_FRONTEND_URL', 'http://localhost:5174')}/tasks/{task_id}">{os.getenv('CUSTOMER_FRONTEND_URL', 'http://localhost:5174')}/tasks/{task_id}</a></p>
      <hr>
      <p><small>This is an automated message from AgentWeb. You are receiving this email because you are subscribed to updates for this task.</small></p>
    </div>
  </div>
</body></html>
"""
        
        msg = MIMEText(html_body_content, 'html')
        msg['Subject'] = subject
        msg['From'] = from_email
        msg['Reply-To'] = 'support@agentweb.pro'
        msg['To'] = to_email
        
        # Send email
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)

        logger.info(f"Sent task run results (HTML only) to subscriber: {to_email}")
        return True

    except Exception as e:
        logger.error(f"Failed to send task results email (HTML only): {e}", exc_info=True)
        return False

def notify_task_subscribers(task_id, task_name, execution_status, execution_id=None, result=None, error=None, start_time=None, end_time=None, new_info_summary=None, result_files=None, llm_name=None):
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
            new_info_summary,
            result_files=result_files,
            llm_name=llm_name
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