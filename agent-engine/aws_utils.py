import os
import boto3
from botocore.config import Config
import logging

logger = logging.getLogger(__name__)

def get_aws_credentials():
    """
    Get AWS credentials. If AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are set
    (local dev via .env), use them explicitly. Otherwise (prod), omit
    explicit keys and let boto3's default credential chain use the
    instance's attached/federated service account.
    """
    credentials = {'region_name': os.getenv('AWS_REGION', 'us-west-2')}
    if os.getenv('AWS_ACCESS_KEY_ID'):
        credentials['aws_access_key_id'] = os.getenv('AWS_ACCESS_KEY_ID')
        credentials['aws_secret_access_key'] = os.getenv('AWS_SECRET_ACCESS_KEY')
    return credentials

def get_aws_client(service_name: str, config: Config = None) -> boto3.client:
    """
    Get an AWS client for the specified service
    
    Args:
        service_name: The AWS service name (e.g., 's3', 'dynamodb', 'bedrock-runtime')
        config: Optional botocore Config object for client configuration
        
    Returns:
        boto3.client: Configured AWS client
    """
    try:
        credentials = get_aws_credentials()
        if config:
            credentials['config'] = config
        return boto3.client(service_name, **credentials)
    except Exception as e:
        logger.error(f"Error creating AWS client for {service_name}: {e}")
        raise

def get_aws_resource(service_name: str) -> boto3.resource:
    """
    Get an AWS resource for the specified service
    
    Args:
        service_name: The AWS service name (e.g., 'dynamodb', 's3')
        
    Returns:
        boto3.resource: Configured AWS resource
    """
    try:
        credentials = get_aws_credentials()
        return boto3.resource(service_name, **credentials)
    except Exception as e:
        logger.error(f"Error creating AWS resource for {service_name}: {e}")
        raise

def get_dynamodb_resource() -> boto3.resource:
    """Get a configured DynamoDB resource"""
    return get_aws_resource('dynamodb')

def get_s3_client() -> boto3.client:
    """Get a configured S3 client"""
    return get_aws_client('s3')

def get_bedrock_client() -> boto3.client:
    """Get a configured Bedrock client with no retries"""
    config = Config(retries=dict(max_attempts=1))
    return get_aws_client('bedrock-runtime', config=config) 