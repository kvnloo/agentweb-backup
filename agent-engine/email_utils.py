#!/usr/bin/env python3
import os
import smtplib
import boto3
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import logging
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

logger = logging.getLogger(__name__)

# Initialize DynamoDB client with credentials
dynamodb = boto3.resource('dynamodb',
    region_name=os.getenv('AWS_REGION', 'us-west-2'),
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
)
subscribers_table = dynamodb.Table('AW-Subscribers')

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

def notify_task_subscribers(task_id, task_name, execution_status, result=None, error=None):
    """
    Notify all subscribers about task completion.
    """
    subscribers = get_task_subscribers(task_id)
    logger.info(f"Found {len(subscribers)} subscribers for task {task_id}")
    
    for subscriber_email in subscribers:
        success = send_task_notification(
            subscriber_email,
            task_name,
            task_id,
            execution_status,
            result,
            error
        )
        if success:
            logger.info(f"Successfully notified subscriber: {subscriber_email}")
        else:
            logger.error(f"Failed to notify subscriber: {subscriber_email}") 