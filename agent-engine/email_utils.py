#!/usr/bin/env python3
import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import logging
from dotenv import load_dotenv
from datetime import datetime
from aws_utils import get_dynamodb_resource

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

def send_task_notification(to_email, task_name, task_id, execution_status, result=None, error=None):
    """
    Send an email notification about task completion.
    """
    try:
        smtp_host = os.getenv('SMTP_HOST', 'smtp.gmail.com')
        smtp_port = int(os.getenv('SMTP_PORT', '587'))
        smtp_user = os.getenv('SMTP_USER')
        smtp_pass = os.getenv('SMTP_PASS')
        from_email = os.getenv('FROM_EMAIL', smtp_user)
        site_domain = os.getenv('SITE_DOMAIN', 'http://localhost:3000')

        if not all([smtp_user, smtp_pass, to_email]):
            logger.error("Missing email configuration")
            return False

        msg = MIMEMultipart()
        msg['From'] = from_email
        msg['To'] = to_email
        msg['Subject'] = f"Task Run Complete: {task_name}"

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

def send_task_results(to_email, task_name, task_id, execution_status, result=None, error=None, start_time=None, end_time=None):
    """
    Send a detailed task results email to subscribers.
    """
    try:
        smtp_host = os.getenv('SMTP_HOST', 'smtp.gmail.com')
        smtp_port = int(os.getenv('SMTP_PORT', '587'))
        smtp_user = os.getenv('SMTP_USER')
        smtp_pass = os.getenv('SMTP_PASS')
        from_email = os.getenv('FROM_EMAIL', smtp_user)
        site_domain = os.getenv('SITE_DOMAIN', 'http://localhost:3000')

        if not all([smtp_user, smtp_pass, to_email]):
            logger.error("Missing email configuration")
            return False

        msg = MIMEMultipart()
        msg['From'] = from_email
        msg['To'] = to_email
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

def notify_task_subscribers(task_id, task_name, execution_status, result=None, error=None, start_time=None, end_time=None):
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
            end_time
        )
        if success:
            logger.info(f"Successfully sent results to subscriber: {subscriber_email}")
        else:
            logger.error(f"Failed to send results to subscriber: {subscriber_email}") 