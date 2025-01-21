#!/usr/bin/env python3
import asyncio
import boto3
import os
import json
import uuid
import logging
from datetime import datetime, timezone
from dotenv import load_dotenv
from web_agent import WebAgent
from botocore.exceptions import ClientError
import time
from decimal import Decimal

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

# Configure root logger
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('task_monitor.log')
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

def get_pending_executions():
    try:
        logger.info("Querying for pending executions...")
        response = executions_table.query(
            IndexName='StatusStartTimeIndex',  # We'll need to create this GSI
            KeyConditionExpression='#status = :status',
            ExpressionAttributeNames={
                '#status': 'status'
            },
            ExpressionAttributeValues={
                ':status': 'pending'
            }
        )
        items = response.get('Items', [])
        logger.info(f"Found {len(items)} pending executions: {json_dumps(items)}")
        return items
    except ClientError as e:
        logger.error(f"Error querying pending executions: {e}")
        return []

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
            update_expression += ", completedAt = :completedAt"
            expression_values[':completedAt'] = datetime.now(timezone.utc).isoformat()

        if result is not None:
            update_expression += ", #result = :result"
            expression_values[':result'] = result
            expression_names['#result'] = 'result'

        if error is not None:
            update_expression += ", #error = :error"
            expression_values[':error'] = error
            expression_names['#error'] = 'error'

        executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression=update_expression,
            ExpressionAttributeNames=expression_names,
            ExpressionAttributeValues=expression_values
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

        # Update execution status to running
        update_execution_status(execution_id, 'running')
        
        # Initialize and run web agent
        agent = WebAgent()
        try:
            result = await agent.execute_task(task['prompt'])
            
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
            logger.info("Checking for pending executions...")
            pending_executions = get_pending_executions()
            
            for execution in pending_executions:
                logger.info(f"Processing execution {execution['executionId']}")
                await execute_task(execution)
            
            logger.info("Sleeping for 5 seconds...")
            await asyncio.sleep(5)  # Use async sleep
            
        except Exception as e:
            logger.error(f"Error in monitor loop: {e}")
            await asyncio.sleep(5)  # Use async sleep

if __name__ == "__main__":
    asyncio.run(monitor_executions()) 