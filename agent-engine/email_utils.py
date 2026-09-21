#!/usr/bin/env python3
import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import logging
from dotenv import load_dotenv
from datetime import datetime
import secrets_manager
from aws_utils import get_dynamodb_resource
from task_utils import check_new_information
import requests # Added for fetching HTML content
import json
from resend_service import resend_service

# Load environment variables
load_dotenv()

# Get table prefix based on NODE_ENV
NODE_ENV = os.getenv('NODE_ENV', 'production')
TABLE_PREFIX = 'Dev-' if NODE_ENV == 'development' else ''
logger = logging.getLogger(__name__)

# Initialize DynamoDB client with credentials
dynamodb = get_dynamodb_resource()

# Initialize tables with environment-specific prefixes
subscribers_table = dynamodb.Table(f'{TABLE_PREFIX}AW-Subscribers')
users_table = dynamodb.Table(f'{TABLE_PREFIX}AW-Users')
executions_table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskExecutions')

def get_task_subscribers(task_id):
    """
    Get all active subscribers for a given task.
    """
    try:
        response = subscribers_table.query(
            KeyConditionExpression='taskId = :taskId',
            FilterExpression='attribute_not_exists(unsubscribed) OR unsubscribed = :unsubscribed',
            ExpressionAttributeValues={
                ':taskId': task_id,
                ':unsubscribed': False
            }
        )
        return [item['email'] for item in response.get('Items', [])]
    except Exception as e:
        logger.error(f"Failed to get task subscribers: {e}")
        return []

def get_effective_email_sender_config(task_id):
    """
    Get the effective email sender configuration with account-level fallback.
    Returns (email_sender, from_name, sender_type)
    """
    try:
        # Validate task_id
        if not task_id:
            logger.error("task_id is None or empty")
            return None, None, 'default'
        
        if not isinstance(task_id, str):
            logger.error(f"task_id is not a string: {type(task_id)}")
            return None, None, 'default'
        
        # Get task details
        try:
            task_response = dynamodb.Table(f'{TABLE_PREFIX}AW-Tasks').get_item(
                Key={'taskId': task_id}
            )
            task = task_response.get('Item', {})
            
            if not task:
                logger.warning(f"Task not found: {task_id}")
                return None, None, 'default'
                
        except Exception as db_error:
            logger.error(f"DynamoDB error getting task {task_id}: {db_error}")
            return None, None, 'default'
        
        # Priority 1: Task-level configuration
        task_email_sender = task.get('emailSender')
        task_from_name = task.get('fromName')
        
        if task_email_sender and task_from_name:
            return task_email_sender, task_from_name, 'task'
        
        # Priority 2: Account-level configuration
        user_id = task.get('userId')
        
        if user_id:
            try:
                # Use UserIdIndex to query by userId (same as backend)
                user_response = dynamodb.Table(f'{TABLE_PREFIX}AW-Users').query(
                    IndexName='UserIdIndex',
                    KeyConditionExpression='userId = :userId',
                    ExpressionAttributeValues={
                        ':userId': user_id
                    }
                )
                users = user_response.get('Items', [])
                
                if not users:
                    logger.warning(f"User not found: {user_id}")
                    return None, None, 'default'
                
                user = users[0]  # Get the first (and should be only) user
                    
            except Exception as db_error:
                logger.error(f"DynamoDB error getting user {user_id}: {db_error}")
                return None, None, 'default'
            
            user_email_domain = user.get('emailDomain')
            user_default_sender_username = user.get('defaultSenderUsername')
            user_from_name = user.get('fromName')
            
            if user_email_domain and user_default_sender_username and user_from_name:
                account_email_sender = f"{user_default_sender_username}@{user_email_domain}"
                return account_email_sender, user_from_name, 'account'
        
        # Priority 3: Default SMTP
        return None, None, 'default'
        
    except Exception as e:
        logger.error(f"Error getting effective email sender config: {e}")
        import traceback
        try:
            logger.error(traceback.format_exc())
        except Exception as tb_error:
            logger.error(f"Could not format traceback: {tb_error}")
        return None, None, 'default'

def add_email_history(task_id, email, subject, execution_id=None, html_content_url=None, sender_type='SMTP', email_id=None):
    """
    Add email history to subscriber record via backend API.
    """
    try:
        from task_utils import create_jwt_token
        
        backend_url = os.getenv('BACKEND_URL', 'http://localhost:3001')
        api_url = f"{backend_url}/api/tasks/{task_id}/subscribers/{email}/email-history"
        
        # Get the user_id from the task_id (assuming task_id contains user info or we can get it from the task)
        # For now, we'll need to get the user_id from the task
        try:
            # Get task details to find the user_id
            task_response = dynamodb.Table(f'{TABLE_PREFIX}AW-Tasks').get_item(
                Key={'taskId': task_id}
            )
            task = task_response.get('Item', {})
            user_id = task.get('userId')
            
            if not user_id:
                logger.error(f"Could not find user_id for task {task_id}")
                return False
                
            # Create JWT token for the user
            jwt_token = create_jwt_token(user_id)
            if not jwt_token:
                logger.error(f"Failed to create JWT token for user {user_id}")
                return False
                
        except Exception as e:
            logger.error(f"Error getting user_id for task {task_id}: {e}")
            return False
        
        payload = {
            "subject": subject,
            "taskExecutionId": execution_id,
            "htmlContentUrl": html_content_url,
            "senderType": sender_type,
            "emailId": email_id
        }
        
        response = requests.post(
            api_url,
            json=payload,
            headers={
                'Authorization': f'Bearer {jwt_token}',
                'Content-Type': 'application/json'
            },
            timeout=10
        )
        
        if response.status_code == 200:
            logger.info(f"Added email history for subscriber: {email} ({sender_type})")
            return True
        else:
            logger.error(f"Failed to add email history for {email}: {response.status_code} - {response.text}")
            return False
            
    except Exception as e:
        logger.error(f"Error adding email history for {email}: {e}")
        return False

def send_task_notification(to_email, task_name, task_id, execution_status, execution_id=None, result=None, error=None, new_info_summary=None, llm_name=None):
    """
    Send an email notification about task completion.
    """
    try:
        # Get effective email sender configuration (task-level or account-level fallback)
        email_sender, from_name, sender_source = get_effective_email_sender_config(task_id)
        
        smtp_host = os.getenv('SMTP_HOST', 'smtp.gmail.com')
        smtp_port = int(os.getenv('SMTP_PORT', '587'))
        smtp_user = secrets_manager.get_smtp_user()
        smtp_pass = secrets_manager.get_smtp_pass()
        from_email = os.getenv('FROM_EMAIL')
        site_domain = os.getenv('SITE_DOMAIN', 'http://localhost:3000')

        if not all([smtp_user, smtp_pass, to_email]):
            logger.error("Missing email configuration")
            return False

        msg = MIMEMultipart()
        # Use effective email sender if available, otherwise use default
        if email_sender and from_name:
            msg['From'] = f"{from_name} <{email_sender}>"
        else:
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

        # Send email using appropriate service
        email_id = None
        sender_type = 'SMTP'
        
        if email_sender and from_name:
            # Use Resend service for custom email sender
            from resend_service import ResendService
            resend_service = ResendService()
            
            resend_result = resend_service.send_email(
                from_email=f"{from_name} <{email_sender}>",
                to_email=to_email,
                subject=msg['Subject'],
                text=body
            )
            
            if resend_result and 'id' in resend_result:
                email_id = resend_result['id']
                sender_type = 'resend'
                logger.info(f"Sent task completion notification via Resend to {to_email} (ID: {email_id})")
            else:
                logger.error("Resend failed, email not sent")
                return False
        else:
            # Use default SMTP service
            msg.attach(MIMEText(body, 'plain'))
            with smtplib.SMTP(smtp_host, smtp_port) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.send_message(msg)
            logger.info(f"Sent task completion notification via SMTP to {to_email}")
        
        # Add email history to subscriber
        add_email_history(task_id, to_email, msg['Subject'], execution_id, None, sender_type, email_id)
        
        return True

    except Exception as e:
        logger.error(f"Failed to send email notification: {e}")
        return False

def send_task_results(to_email, task_name, task_id, execution_status, result=None, error=None, start_time=None, end_time=None, new_info_summary=None, result_files=None, llm_name=None, send_html_report_only=False, execution_id=None):
    """
    Send a detailed task results email to subscribers.
    Sends content as HTML only.
    Includes HTML content if available in result_files.
    """
    try:
        # Get effective email sender configuration (task-level or account-level fallback)
        email_sender, from_name, sender_source = get_effective_email_sender_config(task_id)
        
        smtp_host = os.getenv('SMTP_HOST', 'smtp.gmail.com')
        smtp_port = int(os.getenv('SMTP_PORT', '587'))
        smtp_user = secrets_manager.get_smtp_user()
        smtp_pass = secrets_manager.get_smtp_pass()
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
        html_content_url = None
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
                        html_content_url = file_info['url']  # Capture the URL for email history
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

        # If send_html_report_only is enabled, try to find HTML content and send only that
        if send_html_report_only:
            if not result_files:
                # No result files available, don't send email
                logger.info(f"send_html_report_only enabled but no result files available for task {task_id}, skipping email to {to_email}")
                return False
            
            html_content_from_file_section = ""
            html_content_url = None
            
            for file_info in result_files:
                if file_info.get('view_type') == 'html' and file_info.get('url'):
                    try:
                        response = requests.get(file_info['url'], timeout=10)
                        response.raise_for_status()
                        fetched_html_content = response.text
                        
                        if send_html_report_only:
                            # For send_html_report_only, use raw HTML content without enhancement
                            html_content_from_file_section = fetched_html_content
                        else:
                            # For regular emails, wrap with html-result div
                            html_content_from_file_section = f"""<div class="html-result">
    {fetched_html_content}
</div>"""
                        
                        html_content_url = file_info['url']  # Capture the URL for email history
                        logger.info(f"Successfully fetched HTML content from {file_info['url']}")
                        break
                    except requests.RequestException as e:
                        logger.error(f"Failed to fetch HTML content from {file_info['url']}: {e}")
                        # Don't set html_content_from_file_section for errors
                    except Exception as e:
                        logger.error(f"Unexpected error fetching HTML content from {file_info['url']}: {e}")
                        # Don't set html_content_from_file_section for errors

            # Only send email if we successfully found and fetched HTML content
            if html_content_from_file_section:
                from datetime import datetime
                current_date = datetime.now().strftime("%b %d, %Y")
                subject = f"{task_name} - {current_date}"  # Task name with date

                # Create footer content
                footer_content = f"""
<div style="margin-top: 25px; font-size: 0.9em; padding: 20px; text-align: center;">
  {f'<p>Manage task and history at: <a href="{os.getenv("CUSTOMER_FRONTEND_URL", "http://localhost:5174")}/tasks/{task_id}">{os.getenv("CUSTOMER_FRONTEND_URL", "http://localhost:5174")}/tasks/{task_id}</a></p>' if not send_html_report_only else ''}
  {f'<p><small><strong>Note:</strong> Some visuals may not display properly in the email. <a href="{html_content_url}">View full report here</a> for the complete experience.</small></p>' if html_content_url else ''}
  <hr>
  <p><small>You're receiving this automated email because you're subscribed to the email updates</small></p>
  <p><small><a href="{os.getenv('CUSTOMER_FRONTEND_URL', 'http://localhost:5174')}/unsubscribe?taskId={task_id}&email={to_email}" style="color: #e74c3c;">Unsubscribe from future updates</a></small></p>
</div>"""
                
                # Inject footer before closing </body> tag
                simplified_html = html_content_from_file_section.replace('</body>', f'{footer_content}</body>')

                # Determine sender type and email ID
                sender_type = 'SMTP'
                email_id = None
                
                if email_sender and from_name:
                    # Use Resend service for custom email sender
                    from_email_resend = f"{from_name} <{email_sender}>"
                    resend_result = resend_service.send_email(
                        from_email=from_email_resend,
                        to_email=to_email,
                        subject=subject,
                        html=simplified_html
                    )
                    
                    if resend_result and 'id' in resend_result:
                        email_id = resend_result['id']
                        sender_type = 'resend'
                        logger.info(f"Sent simplified HTML report via Resend to subscriber: {to_email} (ID: {email_id})")
                    else:
                        logger.error("Resend failed, email not sent")
                        return False
                else:
                    # Use default SMTP service
                    msg = MIMEText(simplified_html, 'html')
                    msg['Subject'] = subject
                    msg['From'] = from_email
                    msg['Reply-To'] = 'support@agentweb.pro'
                    msg['To'] = to_email
                    
                    with smtplib.SMTP(smtp_host, smtp_port) as server:
                        server.starttls()
                        server.login(smtp_user, smtp_pass)
                        server.send_message(msg)

                    logger.info(f"Sent simplified HTML report via SMTP to subscriber: {to_email}")
                
                # Add email history to subscriber
                add_email_history(task_id, to_email, subject, execution_id, html_content_url, sender_type, email_id)
                
                return True
            else:
                # HTML content not available, don't send email
                logger.info(f"send_html_report_only enabled but no valid HTML content found for task {task_id}, skipping email to {to_email}")
                return False

        # If send_html_report_only is disabled, send the full email
        # --- Construct HTML Body ---
        html_body_content = f"""<html>
<head>
  <style>
    body {{ font-family: sans-serif; margin: 0; padding: 0; }}
    .container {{ padding: 20px; }}
    .header {{ font-size: 1.5em; font-weight: bold; margin-bottom: 15px; }}
    .details {{ margin-bottom: 20px; padding: 15px; border: 1px solid #eee; border-radius: 5px; }}
    .details p {{ margin: 5px 0; }}
    .section {{ margin-top: 20px; }}
    .section h3 {{ font-size: 1.2em; margin-top: 0; border-bottom: 2px solid #ecf0f1; padding-bottom: 8px; }}
    pre {{ white-space: pre-wrap; word-wrap: break-word; padding: 15px; border-radius: 5px; font-size: 0.9em; }}
    .html-result {{ border: 1px solid #ddd; padding: 10px; margin-top: 15px; border-radius: 5px; }}
    .footer {{ margin-top: 25px; font-size: 0.9em; }}
    a {{ text-decoration: none; }}
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
      {f'<p>Manage task and history at: <a href="{os.getenv("CUSTOMER_FRONTEND_URL", "http://localhost:5174")}/tasks/{task_id}">{os.getenv("CUSTOMER_FRONTEND_URL", "http://localhost:5174")}/tasks/{task_id}</a></p>' if not send_html_report_only else ''}
      {f'<p><small><strong>Note:</strong> Some visuals may not display properly in the email. <a href="{html_content_url}">View full report here</a> for the complete experience.</small></p>' if html_content_url else ''}
      <hr>
      <p><small>You're receiving this automated email because you're subscribed to the email updates</small></p>
      <p><small><a href="{os.getenv('CUSTOMER_FRONTEND_URL', 'http://localhost:5174')}/unsubscribe?taskId={task_id}&email={to_email}" style="color: #e74c3c;">Unsubscribe from future updates</a></small></p>
    </div>
  </div>
</body></html>
"""
        
        # Determine sender type and email ID
        sender_type = 'SMTP'
        email_id = None
        
        if email_sender and from_name:
            # Use Resend service for custom email sender
            from_email_resend = f"{from_name} <{email_sender}>"
            resend_result = resend_service.send_email(
                from_email=from_email_resend,
                to_email=to_email,
                subject=subject,
                html=html_body_content
            )
            
            if resend_result and 'id' in resend_result:
                email_id = resend_result['id']
                sender_type = 'resend'
                logger.info(f"Sent task run results via Resend to subscriber: {to_email} (ID: {email_id})")
            else:
                logger.error("Resend failed, email not sent")
                return False
        else:
            # Use default SMTP service
            msg = MIMEText(html_body_content, 'html')
            msg['Subject'] = subject
            msg['From'] = from_email
            msg['Reply-To'] = 'support@agentweb.pro'
            msg['To'] = to_email
            
            with smtplib.SMTP(smtp_host, smtp_port) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.send_message(msg)
            
            logger.info(f"Sent task run results via SMTP to subscriber: {to_email}")
        
        # Add email history to subscriber
        add_email_history(task_id, to_email, subject, execution_id, html_content_url, sender_type, email_id)
        
        return True

    except Exception as e:
        logger.error(f"Failed to send task results email (HTML only): {e}")
        logger.exception("Full traceback:")
        return False

def notify_task_subscribers(task_id, task_name, execution_status, execution_id=None, result=None, error=None, start_time=None, end_time=None, new_info_summary=None, result_files=None, llm_name=None):
    """
    Send detailed task results to all subscribers.
    """
    try:
        # Get task details to check sendHtmlReportOnly setting
        task_response = dynamodb.Table(f'{TABLE_PREFIX}AW-Tasks').get_item(
            Key={'taskId': task_id}
        )
        task = task_response.get('Item', {})
        send_html_report_only = task.get('sendHtmlReportOnly', False)
        
        response = subscribers_table.query(
            KeyConditionExpression='taskId = :taskId',
            FilterExpression='attribute_not_exists(unsubscribed) OR unsubscribed = :unsubscribed',
            ExpressionAttributeValues={
                ':taskId': task_id,
                ':unsubscribed': False
            }
        )
        all_subscribers = response.get('Items', [])
        
        # Apply subscriber email limit
        email_limit = int(os.getenv('SUBSCRIBER_EMAIL_LIMIT', '1000'))
        subscribers = all_subscribers[:email_limit]
        
        logger.info(f"Found {len(all_subscribers)} subscribers for task {task_id}")
        if len(all_subscribers) > email_limit:
            logger.warning(f"Subscriber count ({len(all_subscribers)}) exceeds limit ({email_limit}). Sending to first {email_limit} subscribers only.")
        
        for subscriber in subscribers:
            email = subscriber.get('email')
            
            if email:
                success = send_task_results(
                    email,
                    task_name,
                    task_id,
                    execution_status,
                    result,
                    error,
                    start_time,
                    end_time,
                    new_info_summary,
                    result_files=result_files,
                    llm_name=llm_name,
                    send_html_report_only=send_html_report_only,
                    execution_id=execution_id
                )
                
                if success:
                    logger.info(f"Successfully sent results to subscriber: {email}")
                else:
                    logger.error(f"Failed to send results to subscriber: {email}")
    except Exception as e:
        logger.error(f"Error getting subscribers for task {task_id}: {e}")
        return False

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
        smtp_user = secrets_manager.get_smtp_user()
        smtp_pass = secrets_manager.get_smtp_pass()
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