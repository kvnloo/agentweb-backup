#!/usr/bin/env python3
import os
import json
import logging
from dotenv import load_dotenv
from google.auth import default
from google.cloud import storage
from google.cloud import bigquery
from google.cloud import pubsub
import boto3
from botocore.exceptions import ClientError

# Load environment variables from .env file
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def get_aws_identity():
    """Get AWS identity information."""
    try:
        sts = boto3.client('sts')
        identity = sts.get_caller_identity()
        logger.info("AWS Identity:")
        logger.info(f"Account: {identity['Account']}")
        logger.info(f"User ID: {identity['UserId']}")
        logger.info(f"ARN: {identity['Arn']}")
        return identity
    except ClientError as e:
        logger.error(f"Error getting AWS identity: {e}")
        return None

def test_google_cloud_auth():
    """Test Google Cloud authentication using AWS credentials."""
    try:
        # Get credentials using the AWS configuration
        credentials, project = default()
        
        # Print the credentials info
        logger.info("Successfully obtained Google Cloud credentials!")
        
        # Get project ID from environment or config
        if not project:
            project = os.getenv('GOOGLE_CLOUD_PROJECT')
            if not project:
                # Try to get project from the config file
                config_path = os.getenv('GOOGLE_APPLICATION_CREDENTIALS')
                if config_path and os.path.exists(config_path):
                    with open(config_path, 'r') as f:
                        config = json.load(f)
                        if 'project_id' in config:
                            project = config['project_id']
        
        logger.info(f"Project: {project}")
        
        # Try to get a token
        try:
            if credentials and hasattr(credentials, 'token'):
                logger.info(f"Token available: {credentials.token[:10]}...")
            else:
                logger.info("No token available, attempting to refresh credentials...")
                if credentials:
                    credentials.refresh(None)
                    if hasattr(credentials, 'token'):
                        logger.info(f"Token obtained after refresh: {credentials.token[:10]}...")
                    else:
                        logger.warning("No token available after refresh")
                else:
                    logger.warning("No credentials object available")
        except Exception as token_error:
            logger.warning(f"Error getting token: {token_error}")
        
        return credentials, project
    except Exception as e:
        logger.error(f"Error in Google Cloud authentication: {str(e)}")
        return None, None

def test_storage_access(credentials, project):
    """Test Google Cloud Storage access."""
    if not project:
        logger.error("No project ID available for Storage test")
        return False
        
    try:
        storage_client = storage.Client(credentials=credentials, project=project)
        buckets = list(storage_client.list_buckets(max_results=5))
        
        logger.info("\nSuccessfully accessed Google Cloud Storage!")
        logger.info("Buckets found:")
        for bucket in buckets:
            logger.info(f"- {bucket.name}")
        return True
    except Exception as e:
        logger.error(f"Error accessing Storage: {str(e)}")
        return False

def test_bigquery_access(credentials, project):
    """Test BigQuery access."""
    if not project:
        logger.error("No project ID available for BigQuery test")
        return False
        
    try:
        bq_client = bigquery.Client(credentials=credentials, project=project)
        datasets = list(bq_client.list_datasets(max_results=5))
        
        logger.info("\nSuccessfully accessed BigQuery!")
        logger.info(f"Found {len(datasets)} datasets")
        for dataset in datasets:
            logger.info(f"- {dataset.dataset_id}")
        return True
    except Exception as e:
        logger.error(f"Error accessing BigQuery: {str(e)}")
        return False

def test_pubsub_access(credentials, project):
    """Test Pub/Sub access."""
    if not project:
        logger.error("No project ID available for Pub/Sub test")
        return False
        
    try:
        pubsub_client = pubsub.Client(credentials=credentials, project=project)
        topics = list(pubsub_client.list_topics(max_results=5))
        
        logger.info("\nSuccessfully accessed Pub/Sub!")
        logger.info(f"Found {len(topics)} topics")
        for topic in topics:
            logger.info(f"- {topic.name}")
        return True
    except Exception as e:
        logger.error(f"Error accessing Pub/Sub: {str(e)}")
        return False

def verify_config_file():
    """Verify the configuration file exists and is valid."""
    config_path = os.getenv('GOOGLE_APPLICATION_CREDENTIALS')
    if not config_path:
        logger.error("GOOGLE_APPLICATION_CREDENTIALS environment variable not set")
        return False
    
    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
            required_fields = ['type', 'audience', 'subject_token_type', 'token_url', 'credential_source']
            for field in required_fields:
                if field not in config:
                    logger.error(f"Missing required field in config: {field}")
                    return False
            logger.info("Configuration file is valid")
            return True
    except Exception as e:
        logger.error(f"Error reading configuration file: {str(e)}")
        return False

def main():
    """Main test function."""
    logger.info("Starting AWS to Google Cloud authentication test...")
    
    # Verify configuration
    if not verify_config_file():
        return
    
    # Test AWS identity
    aws_identity = get_aws_identity()
    if not aws_identity:
        return
    
    # Test Google Cloud authentication
    credentials, project = test_google_cloud_auth()
    if not credentials:
        logger.error("Failed to obtain Google Cloud credentials")
        return
    
    # Test various Google Cloud services
    storage_success = test_storage_access(credentials, project)
    bigquery_success = test_bigquery_access(credentials, project)
    pubsub_success = test_pubsub_access(credentials, project)
    
    # Print summary
    logger.info("\nTest Summary:")
    logger.info(f"AWS Identity: {'Success' if aws_identity else 'Failed'}")
    logger.info(f"Google Cloud Auth: {'Success' if credentials else 'Failed'}")
    logger.info(f"Storage Access: {'Success' if storage_success else 'Failed'}")
    logger.info(f"BigQuery Access: {'Success' if bigquery_success else 'Failed'}")
    logger.info(f"Pub/Sub Access: {'Success' if pubsub_success else 'Failed'}")

if __name__ == "__main__":
    main() 