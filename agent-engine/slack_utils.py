#!/usr/bin/env python3
import os
import requests
import logging
from dotenv import load_dotenv
from task_utils import create_jwt_token

# Load environment variables
load_dotenv()

logger = logging.getLogger(__name__)

def send_task_approval_request(task_id, task_name, execution_id, asset_url, filename, asset_type, slack_channel, user_id):
    """
    Send a task approval request to Slack via the backend API using JWT authentication.
    
    Args:
        task_id: The ID of the task
        task_name: The name of the task
        execution_id: The ID of the execution
        asset_url: The URL of the asset (HTML report or image)
        filename: The filename of the asset
        asset_type: The type of asset ('html' or 'image')
        slack_channel: The Slack channel ID to send to
        user_id: The ID of the user who owns the task
    """
    try:
        # Get backend URL from environment
        backend_url = os.getenv('BACKEND_URL', 'http://localhost:3001')
        
        # Create JWT token for the user
        jwt_token = create_jwt_token(user_id)
        if not jwt_token:
            logger.error(f"Failed to create JWT token for user {user_id}")
            return False
        
        # Prepare the approval request data with asset-type specific messaging
        if asset_type == 'image':
            note = f'An image has been generated. Please review and approve.'
        else:
            note = f'A {asset_type} has been generated. Please review and approve. Once approved, results will be automatically sent to all task subscribers. You can manage subscribers at: {os.getenv("CUSTOMER_FRONTEND_URL", "http://localhost:5174")}/tasks/{task_id}#subscribers'
        
        approval_data = {
            'channel': slack_channel,
            'channelName': slack_channel,  # Will be updated by backend
            'assetUrl': asset_url,
            'filename': filename,
            'assetType': asset_type,
            'executionId': execution_id,
            'note': note
        }
        
        # Send the approval request to the backend using JWT authentication
        response = requests.post(
            f'{backend_url}/api/slack/send-approval',
            json=approval_data,
            headers={
                'Authorization': f'Bearer {jwt_token}',
                'Content-Type': 'application/json'
            },
            timeout=30
        )
        
        if response.status_code == 200:
            result = response.json()
            if result.get('success'):
                logger.info(f"Successfully sent Slack approval request for task {task_id}")
                return True
            else:
                logger.error(f"Backend returned error for Slack approval request: {result.get('message', 'Unknown error')}")
                return False
        else:
            logger.error(f"Failed to send Slack approval request. Status: {response.status_code}, Response: {response.text}")
            return False
            
    except Exception as e:
        logger.error(f"Error sending Slack approval request: {e}")
        return False
