import boto3
import logging
from botocore.exceptions import ClientError
from dotenv import load_dotenv
import os

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize DynamoDB client
dynamodb = boto3.client('dynamodb',
    region_name=os.getenv('AWS_REGION', 'us-west-2'),
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
)

def create_task_executions_table():
    """Create AW-TaskExecutions table if it doesn't exist"""
    try:
        response = dynamodb.create_table(
            TableName='AW-TaskExecutions',
            AttributeDefinitions=[
                {'AttributeName': 'executionId', 'AttributeType': 'S'},
                {'AttributeName': 'taskId', 'AttributeType': 'S'},
                {'AttributeName': 'startTime', 'AttributeType': 'S'},
                {'AttributeName': 'status', 'AttributeType': 'S'}
            ],
            KeySchema=[
                {'AttributeName': 'executionId', 'KeyType': 'HASH'}
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'TaskIdIndex',
                    'KeySchema': [
                        {'AttributeName': 'taskId', 'KeyType': 'HASH'},
                        {'AttributeName': 'startTime', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {'ProjectionType': 'ALL'}
                },
                {
                    'IndexName': 'StatusStartTimeIndex',
                    'KeySchema': [
                        {'AttributeName': 'status', 'KeyType': 'HASH'},
                        {'AttributeName': 'startTime', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {'ProjectionType': 'ALL'}
                }
            ],
            BillingMode='PAY_PER_REQUEST'
        )
        logger.info("Created AW-TaskExecutions table")
        return response
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceInUseException':
            logger.info("AW-TaskExecutions table already exists")
            
            # Add StatusStartTimeIndex if it doesn't exist
            try:
                dynamodb.update_table(
                    TableName='AW-TaskExecutions',
                    AttributeDefinitions=[
                        {'AttributeName': 'status', 'AttributeType': 'S'},
                        {'AttributeName': 'startTime', 'AttributeType': 'S'}
                    ],
                    GlobalSecondaryIndexUpdates=[
                        {
                            'Create': {
                                'IndexName': 'StatusStartTimeIndex',
                                'KeySchema': [
                                    {'AttributeName': 'status', 'KeyType': 'HASH'},
                                    {'AttributeName': 'startTime', 'KeyType': 'RANGE'}
                                ],
                                'Projection': {'ProjectionType': 'ALL'}
                            }
                        }
                    ]
                )
                logger.info("Added StatusStartTimeIndex to AW-TaskExecutions table")
            except ClientError as e:
                if e.response['Error']['Code'] == 'ResourceInUseException':
                    logger.info("StatusStartTimeIndex already exists")
                else:
                    logger.error(f"Error adding StatusStartTimeIndex: {e}")
                    raise e
        else:
            logger.error(f"Error creating AW-TaskExecutions table: {e}")
            raise e

def create_tasks_table():
    """Create AW-Tasks table if it doesn't exist"""
    try:
        response = dynamodb.create_table(
            TableName='AW-Tasks',
            AttributeDefinitions=[
                {'AttributeName': 'taskId', 'AttributeType': 'S'},
                {'AttributeName': 'userId', 'AttributeType': 'S'},
                {'AttributeName': 'createdAt', 'AttributeType': 'S'}
            ],
            KeySchema=[
                {'AttributeName': 'taskId', 'KeyType': 'HASH'}
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'UserIdIndex',
                    'KeySchema': [
                        {'AttributeName': 'userId', 'KeyType': 'HASH'},
                        {'AttributeName': 'createdAt', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {'ProjectionType': 'ALL'}
                }
            ],
            BillingMode='PAY_PER_REQUEST'
        )
        logger.info("Created AW-Tasks table")
        return response
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceInUseException':
            logger.info("AW-Tasks table already exists")
        else:
            logger.error(f"Error creating AW-Tasks table: {e}")
            raise e

def main():
    """Create all required tables"""
    create_tasks_table()
    create_task_executions_table()
    logger.info("All tables created successfully")

if __name__ == "__main__":
    main() 