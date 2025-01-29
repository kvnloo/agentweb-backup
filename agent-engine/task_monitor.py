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
from email_utils import send_task_notification, notify_task_subscribers
import humanize  # Add this import at the top of the file

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
dynamodb = boto3.resource('dynamodb',
    region_name=os.getenv('AWS_REGION', 'us-west-2'),
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
)
executions_table = dynamodb.Table('AW-TaskExecutions')
tasks_table = dynamodb.Table('AW-Tasks')
schedules_table = dynamodb.Table('AW-TaskSchedules')
users_table = dynamodb.Table('AW-Users')

# Add last_execution_time as a module-level variable
last_execution_time = None

def get_pending_executions():
    global last_execution_time
    try:
        logger.info("Querying for pending executions...")
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
        items = response.get('Items', [])

        # Update last_execution_time if we got any items
        if items:
            last_execution_time = max(item['startTime'] for item in items)

        logger.info(f"Found {len(items)} pending executions: {json_dumps(items)}")
        return items
    except ClientError as e:
        logger.error(f"Error querying pending executions: {e}")
        return []

def get_due_schedules():
    try:
        logger.info("Querying for due schedules...")
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
        logger.info(f"Found {len(items)} due schedules: {json_dumps(items)}")
        return items
    except ClientError as e:
        logger.error(f"Error querying due schedules: {e}")
        return []

def create_execution(task_id, user_id):
    try:
        execution_id = str(int(time.time() * 1000))  # Use timestamp as ID
        execution = {
            'executionId': execution_id,
            'taskId': task_id,
            'userId': user_id,
            'status': 'pending',
            'startTime': datetime.now(timezone.utc).isoformat()
        }
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
        logger.info("Processing schedules...")
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

def update_execution_status(execution_id, status, result=None, error=None):
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

                    # Send simple notification to task owner if emailNotification is enabled
                    if task.get('emailNotification'):
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
                            send_task_notification(
                                to_email=user['email'],
                                task_name=task['name'],
                                task_id=execution['taskId'],
                                execution_status=status,
                                result=result,
                                error=error
                            )
                        else:
                            logger.error(f"User email not found for userId: {task['userId']}")
                    
                    # Send detailed results to all subscribers
                    notify_task_subscribers(
                        task_id=execution['taskId'],
                        task_name=task['name'],
                        execution_status=status,
                        result=result,
                        error=error,
                        start_time=start_time,
                        end_time=end_time
                    )
    except ClientError as e:
        logger.error(f"Error updating execution status: {e}")

async def execute_task(execution):
    execution_id = execution['executionId']
    task_id = execution['taskId']
    
    try:
        # Get task details
        task_response = tasks_table.get_item(Key={'taskId': task_id})
        task = task_response.get('Item')
        
        if not task:
            raise Exception(f"Task {task_id} not found")

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

        # Update execution status to running
        update_execution_status(execution_id, 'running')
        
        # Initialize and run web agent
        agent = WebAgent()
        try:
            # Include previous feedback in prompt if available
            prompt = task['prompt']
            if previous_feedback:
                prompt = f"{prompt}\n\nNote: Previous attempt {previous_feedback['time_ago']} was {previous_feedback['feedback']}. Previous result: {previous_feedback['result']}"
            
            result = await agent.execute_task(prompt)
            
            if result['success']:
                update_execution_status(
                    execution_id, 
                    'completed', 
                    result=result.get('summary', 'No summary available')
                )
            else:
                update_execution_status(
                    execution_id, 
                    'failed', 
                    error=result.get('error', 'Unknown error')
                )
        finally:
            await agent.cleanup()
        
    except Exception as e:
        logger.error(f"Error executing task: {e}")
        update_execution_status(execution_id, 'failed', error=str(e))

async def monitor_executions():
    logger.info("Starting execution monitor...")
    
    while True:
        try:
            # First, process schedules to create new executions
            await process_schedules()
            
            # Then process pending executions
            logger.info("Checking for pending executions...")
            pending_executions = get_pending_executions()
            
            for execution in pending_executions:
                logger.info(f"Processing execution {execution['executionId']}")
                await execute_task(execution)
            
            logger.info("Sleeping for 5 seconds...")
            await asyncio.sleep(5)  # Check every 5 seconds
            
        except Exception as e:
            logger.error(f"Error in monitor loop: {e}")
            await asyncio.sleep(5)

if __name__ == "__main__":
    asyncio.run(monitor_executions()) 