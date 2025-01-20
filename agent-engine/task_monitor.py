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

# Initialize DynamoDB client and resource
dynamodb = boto3.client('dynamodb',
    region_name=os.getenv('AWS_REGION', 'us-west-2'),
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
)
dynamodb_resource = boto3.resource('dynamodb',
    region_name=os.getenv('AWS_REGION', 'us-west-2'),
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
)

async def process_stream_record(record):
    """Process a single DynamoDB Stream record"""
    if record['eventName'] != 'INSERT':
        return

    # Get the new task data
    new_task = record['dynamodb']['NewImage']
    task_id = new_task['taskId']['S']
    
    # Check if status is pending or not set
    status = new_task.get('status', {}).get('S', 'pending')
    if status != 'pending':
        return

    logger.info(f"Processing new task: {task_id}")
    
    try:
        # Try to atomically update status from pending to running
        dynamodb.update_item(
            TableName='AW-Tasks',
            Key={'taskId': {'S': task_id}},
            UpdateExpression='SET #status = :new_status, updatedAt = :updatedAt',
            ConditionExpression='attribute_not_exists(#status) OR #status = :old_status',
            ExpressionAttributeNames={
                '#status': 'status'
            },
            ExpressionAttributeValues={
                ':old_status': {'S': 'pending'},
                ':new_status': {'S': 'running'},
                ':updatedAt': {'S': datetime.now(timezone.utc).isoformat()}
            }
        )
        # Execute the task
        await execute_task(new_task)
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            logger.info(f"Task {task_id} is being processed by another worker")
        else:
            logger.error(f"Error processing task {task_id}: {str(e)}", exc_info=True)
    except Exception as e:
        logger.error(f"Error processing task {task_id}: {str(e)}", exc_info=True)

async def monitor_stream():
    """Monitor DynamoDB Stream for new tasks"""
    logger.info("Starting DynamoDB Stream monitor...")
    
    try:
        # Get the table
        table = dynamodb_resource.Table('AW-Tasks')
        
        # Get the latest stream ARN
        stream_arn = table.latest_stream_arn
        if not stream_arn:
            raise Exception("Stream not enabled on AW-Tasks table")
            
        logger.info(f"Found stream ARN: {stream_arn}")
            
        # Create a stream client
        stream_client = boto3.client('dynamodbstreams',
            region_name=os.getenv('AWS_REGION', 'us-west-2'),
            aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
        )
        
        # Get stream description
        stream = stream_client.describe_stream(StreamArn=stream_arn)
        logger.info(f"Stream description: {json_dumps(stream['StreamDescription'])}")
        
        shard_id = stream['StreamDescription']['Shards'][0]['ShardId']
        logger.info(f"Using shard ID: {shard_id}")
        
        # Get shard iterator
        iterator_response = stream_client.get_shard_iterator(
            StreamArn=stream_arn,
            ShardId=shard_id,
            ShardIteratorType='LATEST'
        )
        shard_iterator = iterator_response['ShardIterator']
        logger.info("Successfully got shard iterator")
        
        logger.info(f"Monitoring stream: {stream_arn}")
        
        while True:
            # Get records from stream
            response = stream_client.get_records(ShardIterator=shard_iterator)
            
            # Log record count
            record_count = len(response.get('Records', []))
            if record_count > 0:
                logger.info(f"Received {record_count} records")
                logger.info(f"Records: {json_dumps(response['Records'])}")
            
            # Process records
            for record in response['Records']:
                logger.info(f"Processing record: {json_dumps(record)}")
                await process_stream_record(record)
            
            # Update shard iterator
            shard_iterator = response['NextShardIterator']
            
            # Wait before next poll
            await asyncio.sleep(1)
            
    except Exception as e:
        logger.error(f"Error in stream monitor: {str(e)}", exc_info=True)
        raise

async def update_task_status(task_id: str, status: str, error: str = None, summary: str = None):
    """Update task status in AW-Tasks table"""
    try:
        logger.info(f"Updating task {task_id} status to {status}")
        update_expr = "SET #status = :status, updatedAt = :updatedAt"
        expr_values = {
            ':status': {'S': status},
            ':updatedAt': {'S': datetime.now(timezone.utc).isoformat()}
        }
        
        expr_names = {
            '#status': 'status'
        }
        
        if error:
            update_expr += ", #error = :error"
            expr_values[':error'] = {'S': error}
            expr_names['#error'] = 'error'
            logger.error(f"Task {task_id} error: {error}")
            
        if summary:
            update_expr += ", #summary = :summary"
            expr_values[':summary'] = {'S': summary}
            expr_names['#summary'] = 'summary'
            logger.info(f"Task {task_id} summary: {summary}")
            
        dynamodb.update_item(
            TableName='AW-Tasks',
            Key={'taskId': {'S': task_id}},
            UpdateExpression=update_expr,
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values
        )
        logger.info(f"Successfully updated task {task_id} status")
    except Exception as e:
        logger.error(f"Error updating task {task_id} status: {str(e)}", exc_info=True)

async def create_task_execution(task_id: str, task: dict):
    """Create a new task execution record"""
    execution_id = str(uuid.uuid4())
    start_time = datetime.now(timezone.utc).isoformat()
    
    try:
        logger.info(f"Creating execution record for task {task_id}")
        user_id = task.get('userId', {}).get('S', 'unknown')
        prompt = task.get('prompt', {}).get('S', '')
        logger.info(f"Task details - User: {user_id}, Prompt: {prompt}")
        
        dynamodb.put_item(
            TableName='AW-TaskExecutions',
            Item={
                'executionId': {'S': execution_id},
                'taskId': {'S': task_id},
                'startTime': {'S': start_time},
                'status': {'S': 'running'},
                'userId': {'S': user_id},
                'prompt': {'S': prompt},
                'createdAt': {'S': datetime.now(timezone.utc).isoformat()},
                'updatedAt': {'S': datetime.now(timezone.utc).isoformat()}
            }
        )
        logger.info(f"Successfully created execution record {execution_id}")
        return execution_id
    except Exception as e:
        logger.error(f"Error creating execution record for task {task_id}: {str(e)}", exc_info=True)
        return None

async def update_task_execution(execution_id: str, status: str, error: str = None, result: dict = None):
    """Update task execution status"""
    try:
        logger.info(f"Updating execution {execution_id} status to {status}")
        update_expr = "SET #status = :status, endTime = :endTime, updatedAt = :updatedAt"
        expr_values = {
            ':status': {'S': status},
            ':endTime': {'S': datetime.now(timezone.utc).isoformat()},
            ':updatedAt': {'S': datetime.now(timezone.utc).isoformat()}
        }
        
        expr_names = {
            '#status': 'status'
        }
        
        if error:
            update_expr += ", #error = :error"
            expr_values[':error'] = {'S': error}
            expr_names['#error'] = 'error'
            logger.error(f"Execution {execution_id} error: {error}")
            
        if result:
            update_expr += ", #result = :result"
            expr_values[':result'] = {'S': json.dumps(result)}
            expr_names['#result'] = 'result'
            logger.info(f"Execution {execution_id} result: {json.dumps(result)}")
            
        dynamodb.update_item(
            TableName='AW-TaskExecutions',
            Key={'executionId': {'S': execution_id}},
            UpdateExpression=update_expr,
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values
        )
        logger.info(f"Successfully updated execution {execution_id}")
    except Exception as e:
        logger.error(f"Error updating execution {execution_id}: {str(e)}", exc_info=True)

async def execute_task(task):
    """Execute a task using WebAgent directly"""
    task_id = task['taskId']['S']
    prompt = task['prompt']['S']
    
    logger.info(f"Starting execution for task {task_id}")
    logger.info(f"Task prompt: {prompt}")
    
    # Create execution record
    execution_id = await create_task_execution(task_id, task)
    if not execution_id:
        logger.error(f"Failed to create execution record for task {task_id}")
        await update_task_status(task_id, 'failed', 'Failed to create execution record')
        return
    
    try:
        # Create and run WebAgent
        logger.info(f"Initializing WebAgent for task {task_id}")
        agent = WebAgent()
        
        try:
            result = await agent.execute_task(prompt)
            logger.info(f"WebAgent execution completed: {json.dumps(result)}")
            
            # Get the last message from the agent's history
            last_message = None
            if hasattr(agent, 'agent') and hasattr(agent.agent, 'history'):
                history = agent.agent.history.history
                if history and history[-1].result:
                    # Get the extracted content from the last action result
                    action_result = history[-1].result[0]  # First result from the last action
                    if hasattr(action_result, 'is_done') and action_result.is_done:
                        last_message = action_result.extracted_content
                        logger.info(f"Agent final message: {last_message}")
                    else:
                        logger.warning(f"Last action result is not done: {action_result}")
            
            # Add summary to result
            if last_message:
                result['summary'] = last_message
                logger.info(f"Execution summary: {last_message}")
            
            if result.get('success', False):
                logger.info(f"Task {task_id} completed successfully")
                await update_task_status(task_id, 'completed', summary=last_message)
                await update_task_execution(execution_id, 'completed', result=result)
            else:
                error = result.get('error', 'Unknown error')
                logger.error(f"Task {task_id} failed: {error}")
                await update_task_status(task_id, 'failed', error=error, summary=last_message)
                await update_task_execution(execution_id, 'failed', error=error, result=result)
                
        finally:
            # Always cleanup browser resources
            await agent.cleanup()
            
    except Exception as e:
        error = str(e)
        logger.error(f"Error executing task {task_id}: {error}", exc_info=True)
        await update_task_status(task_id, 'failed', error=error)
        await update_task_execution(execution_id, 'failed', error=error)

async def scan_pending_tasks():
    """Periodically scan for pending tasks"""
    while True:
        try:
            logger.info("Scanning for pending tasks...")
            response = dynamodb.scan(
                TableName='AW-Tasks',
                FilterExpression='attribute_not_exists(#status) OR #status = :status',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':status': {'S': 'pending'}}
            )
            
            tasks = response.get('Items', [])
            logger.info(f"Found {len(tasks)} pending tasks")
            
            for task in tasks:
                task_id = task.get('taskId', {}).get('S', 'unknown')
                try:
                    # Try to atomically update status from pending to running
                    dynamodb.update_item(
                        TableName='AW-Tasks',
                        Key={'taskId': {'S': task_id}},
                        UpdateExpression='SET #status = :new_status, updatedAt = :updatedAt',
                        ConditionExpression='attribute_not_exists(#status) OR #status = :old_status',
                        ExpressionAttributeNames={
                            '#status': 'status'
                        },
                        ExpressionAttributeValues={
                            ':old_status': {'S': 'pending'},
                            ':new_status': {'S': 'running'},
                            ':updatedAt': {'S': datetime.now(timezone.utc).isoformat()}
                        }
                    )
                    # Execute the task
                    await execute_task(task)
                except ClientError as e:
                    if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                        logger.info(f"Task {task_id} is being processed by another worker")
                    else:
                        logger.error(f"Error processing task {task_id}: {str(e)}", exc_info=True)
                except Exception as e:
                    logger.error(f"Error processing task {task_id}: {str(e)}", exc_info=True)
            
            # Wait for 5 minutes before next scan
            await asyncio.sleep(300)
            
        except Exception as e:
            logger.error(f"Error in scan_pending_tasks: {str(e)}", exc_info=True)
            # Wait for 5 minutes before retry on error
            await asyncio.sleep(300)

async def main():
    """Run both stream monitor and periodic scan"""
    try:
        # Create tasks for both stream monitoring and periodic scanning
        stream_task = asyncio.create_task(monitor_stream())
        scan_task = asyncio.create_task(scan_pending_tasks())
        
        # Wait for both tasks
        await asyncio.gather(stream_task, scan_task)
    except Exception as e:
        logger.error(f"Error in main: {str(e)}", exc_info=True)
        raise

if __name__ == "__main__":
    logger.info("=== Task Monitor Starting ===")
    logger.info(f"Region: {os.getenv('AWS_REGION', 'us-west-2')}")
    asyncio.run(main()) 