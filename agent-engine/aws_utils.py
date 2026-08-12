import os
import boto3
from botocore.config import Config
import logging
import secrets_manager

logger = logging.getLogger(__name__)

def get_aws_credentials():
    """
    Get AWS credentials. Env vars (local dev via .env) take precedence;
    otherwise fetch the (rotated, non-Rui) access key from GCP Secret
    Manager. There is no GCP<->AWS workload identity federation for this
    VM, so a stored access key — not an instance/federated identity — is
    the actual credential source in prod.
    """
    return {
        'region_name': secrets_manager.get_aws_region(),
        'aws_access_key_id': secrets_manager.get_aws_access_key_id(),
        'aws_secret_access_key': secrets_manager.get_aws_secret_access_key(),
    }

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