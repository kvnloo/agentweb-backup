import boto3
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Initialize DynamoDB client
dynamodb = boto3.client('dynamodb',
    region_name=os.getenv('AWS_REGION', 'us-west-2'),
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
)

def create_task_executions_table():
    """Create AW-TaskExecutions table for tracking task execution history"""
    try:
        # Create AW-TaskExecutions table
        dynamodb.create_table(
            TableName='AW-TaskExecutions',
            AttributeDefinitions=[
                {'AttributeName': 'executionId', 'AttributeType': 'S'},
                {'AttributeName': 'taskId', 'AttributeType': 'S'},
                {'AttributeName': 'startTime', 'AttributeType': 'S'},
            ],
            KeySchema=[
                {'AttributeName': 'executionId', 'KeyType': 'HASH'},
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'TaskIdIndex',
                    'KeySchema': [
                        {'AttributeName': 'taskId', 'KeyType': 'HASH'},
                        {'AttributeName': 'startTime', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {
                        'ProjectionType': 'ALL'
                    }
                }
            ],
            BillingMode='PAY_PER_REQUEST'
        )
        print("Successfully created AW-TaskExecutions table")

    except dynamodb.exceptions.ResourceInUseException:
        print("Table AW-TaskExecutions already exists")
    except Exception as e:
        print(f"Error creating AW-TaskExecutions table: {str(e)}")
        raise

if __name__ == "__main__":
    create_task_executions_table() 