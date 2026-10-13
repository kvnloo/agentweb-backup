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


# ENG-273: asking for approval on a customer's connected channel when the task has no
# Slack channel. Slack and WhatsApp are separate features and a customer connects one of
# them, so "no Slack channel" does not mean "nobody to ask". `send_task_approval_request`
# above is deliberately untouched: tasks that have a Slack channel take exactly the path
# they always did.
APPROVAL_SENT = 'sent'
APPROVAL_NO_CHANNEL = 'no_channel'
APPROVAL_FAILED = 'failed'


def request_task_approval_without_slack(task_id, execution_id, asset_url, filename, asset_type, user_id):
    """
    Ask the task owner for approval on whichever channel they have connected (e.g.
    WhatsApp), via the channel-neutral backend endpoint.

    Returns one of three outcomes, because the caller must treat them differently:

      APPROVAL_SENT        the request reached the customer. Hold the results.
      APPROVAL_NO_CHANNEL  the account has no channel to be asked on at all (HTTP 409
                           no_channel). Carry on as tasks without approval always have.
      APPROVAL_FAILED      anything else, including a send that failed for a customer who
                           HAS a channel (HTTP 502 delivery_failed). The caller must hold
                           the results: treating a reachable customer as unreachable would
                           email unreviewed output to subscribers, which is what holding
                           is for. This is the same thing that happens when a Slack send
                           fails.
    """
    try:
        backend_url = os.getenv('BACKEND_URL', 'http://localhost:3001')

        jwt_token = create_jwt_token(user_id)
        if not jwt_token:
            logger.error(f"Failed to create JWT token for user {user_id}")
            return APPROVAL_FAILED

        if asset_type == 'image':
            note = 'An image has been generated. Please review and approve.'
        else:
            note = f'A {asset_type} has been generated. Please review and approve. Once approved, results will be automatically sent to all task subscribers. You can manage subscribers at: {os.getenv("CUSTOMER_FRONTEND_URL", "http://localhost:5174")}/tasks/{task_id}#subscribers'

        response = requests.post(
            f'{backend_url}/api/approval-requests',
            json={
                'assetUrl': asset_url,
                'filename': filename,
                'assetType': asset_type,
                'executionId': execution_id,
                'note': note,
            },
            headers={
                'Authorization': f'Bearer {jwt_token}',
                'Content-Type': 'application/json'
            },
            timeout=30
        )

        if response.status_code == 200:
            if response.json().get('success'):
                logger.info(f"Approval request sent for task {task_id} on the customer's connected channel")
                return APPROVAL_SENT
            logger.error(f"Backend reported failure sending approval request for task {task_id}")
            return APPROVAL_FAILED

        if response.status_code == 404 and 'Cannot POST /api/approval-requests' in (response.text or ''):
            # The backend does not have this endpoint yet: the engine was deployed ahead of
            # it. An older backend cannot ask on any channel but Slack and has no WhatsApp
            # customers, so there is nobody this could be holding output for. Treat it as no
            # channel — what happened before this existed — rather than as a failed send,
            # which would hold the results of every task that requires approval and has no
            # Slack channel until the backend catches up.
            logger.warning(f"Approval endpoint not found (backend not yet deployed?); continuing without approval for task {task_id}")
            return APPROVAL_NO_CHANNEL
        # Any OTHER 404 (a proxy, a wrong BACKEND_URL, a rolled-back route table) is not the
        # backend telling us nobody can be asked, so it falls through to FAILED and the
        # output is held rather than emailed unreviewed.

        if response.status_code == 409:
            try:
                code = response.json().get('code')
            except ValueError:
                code = None
            if code == 'no_channel':
                logger.info(f"No approval channel connected for task {task_id}; continuing without approval")
                return APPROVAL_NO_CHANNEL

        logger.error(f"Failed to send approval request for task {task_id}. Status: {response.status_code}, Response: {response.text}")
        return APPROVAL_FAILED

    except Exception as e:
        logger.error(f"Error sending approval request for task {task_id}: {e}")
        return APPROVAL_FAILED


def should_hold_results_for_approval(requires_approval, slack_channel, outcome_without_slack):
    """
    Whether a task's results are held back from its subscribers while approval is pending.

    A task with a Slack channel holds its results whether or not the Slack post succeeded.
    That is the behaviour it always had, and is unchanged.

    A task WITHOUT one holds them when the customer was asked on another channel, and also
    when asking was attempted and FAILED: a customer who can be reached and was not asked
    must not have unreviewed output mailed out. Only a customer with no channel at all
    (APPROVAL_NO_CHANNEL), or a task where nothing was attempted (None), is released, as
    tasks with no approval channel always were.
    """
    if not requires_approval:
        return False
    if slack_channel:
        return True
    return outcome_without_slack in (APPROVAL_SENT, APPROVAL_FAILED)
