#!/usr/bin/env python3
import argparse
import json
import sys
import os
import re
import uuid
from typing import Dict, Any, Optional, List
import browser_use
from browser_use import Agent, Controller
from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContextConfig, BrowserContext
from langchain_aws import ChatBedrock
from langchain_openai import AzureChatOpenAI, ChatOpenAI
from pydantic import SecretStr
from botocore.config import Config
from dotenv import load_dotenv
import logging
from pathlib import Path
from browser_use.agent.views import ActionResult
from cookie_sync import CookieSync
from aws_utils import get_dynamodb_resource, get_bedrock_client
import time
import asyncio
import random
import aiohttp
import base64  # Add at the top with other imports
import boto3  # Add at the top with other imports
from urllib.parse import quote
from task_utils import get_downloads_path, upload_task_result_files, get_llm, validate_content_format, extract_json_from_content, generate_content_hash
# Load environment variables
load_dotenv()

# Get table prefix based on NODE_ENV
TABLE_PREFIX = 'Dev-' if os.getenv('NODE_ENV') == 'development' else ''

# Initialize DynamoDB client
dynamodb = get_dynamodb_resource()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

global_use_vision = True

controller = Controller()

def decrypt_password(encrypted_password: str, user_id: str, shared_by: str = None) -> str:
    """Decrypt password using JWT_SECRET. For shared passwords, use the sharer's userId."""
    try:
        import jwt
        decoded = jwt.decode(encrypted_password, os.getenv('JWT_SECRET'), algorithms=['HS256'])
        # For shared passwords, verify against the original sharer's userId
        expected_user_id = shared_by if shared_by else user_id
        if shared_by:
            logger.info(f"Using shared credentials - decrypting with sharer's userId: {shared_by}")
        if decoded['userId'] != expected_user_id:
            raise Exception("Invalid user ID in encrypted password")
        return decoded['password']
    except Exception as e:
        logger.error(f"Error decrypting password: {e}")
        raise Exception("Failed to decrypt password")

class WebAgent:
    def __init__(self, user_id=None, full_llm_name=None):
        logger.info(f"Initializing WebAgent for user {user_id}")
        self.browser = None
        self.agent = None
        if not full_llm_name:
            raise ValueError("full_llm_name must be provided")
        self.llm, self.llm_name = get_llm(full_llm_name)
        self.task = None
        self.action_history = []
        self.user_id = user_id
        self.context_dir = Path('context')
        self.context_dir.mkdir(exist_ok=True)
        self.attachments_dir = Path('attachments')
        self.attachments_dir.mkdir(exist_ok=True)
        self.cookie_sync = CookieSync() if user_id else None
        self.is_interactive = False  # Initialize interactive mode flag
        self.current_execution_id = None
        self.current_task_id = None
        self.controller = Controller()
        self.question_count = 0  # Track number of questions asked
        self.s3_client = boto3.client('s3')
        self.s3_bucket = os.getenv('S3_BUCKET_NAME')  # Make sure to set this in .env
        self._log_handlers = []  # Store log handlers for cleanup
        self.generate_gif = None
        self.sensitive_data = []  # List to store all credentials for log filtering
        self.cookie_tainted = False  # Flag to track if shared credentials were used
        self.run_user_id = None  # Added to store run_user_id

    def setup_execution_logging(self, execution_id: str):
        """Setup logging for the current execution"""
        # Create logs directory if it doesn't exist
        os.makedirs('logs', exist_ok=True)
        
        # Create a file handler
        log_file = f'logs/execution_{execution_id}_browser_use.log'
        file_handler = logging.FileHandler(log_file)
        file_handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
        
        # Add the file handler to browser_use logger only
        browser_use_logger = logging.getLogger('browser_use')
        browser_use_logger.addHandler(file_handler)
        self._log_handlers.append((browser_use_logger, file_handler))
        
        return log_file

    def cleanup_logging(self):
        """Remove the execution-specific log handlers"""
        for log, handler in self._log_handlers:
            log.removeHandler(handler)
            handler.close()
        self._log_handlers.clear()

    async def execute_task(self, prompt: str, execution_id: str = None, is_interactive: bool = False, task_id: str = None, generate_gif: str = None, is_complex_task: bool = False, extract_page_content: bool = False, validate_output: bool = False) -> Dict[str, Any]:
        """Execute a task based on the natural language prompt"""
        log_file = None
        try:
            # Set class variables
            self.current_execution_id = execution_id
            self.current_task_id = task_id
            self.generate_gif = generate_gif
            self.is_interactive = is_interactive

            # Configure logging for this execution
            log_file = self.setup_execution_logging(execution_id)
            
            logger.info(f"Executing task with prompt: {prompt[:100]}...")
            logger.info(f"Interactive mode: {is_interactive}")
            logger.info(f"Complex task: {is_complex_task}")
            logger.info(f"Extract page content: {extract_page_content}")
            logger.info(f"Validate output: {validate_output}")
            
            # Register actions after setting is_interactive
            self._register_actions()
            
            # Add interactive mode context to the prompt if enabled
            if self.is_interactive:
                prompt = f"{prompt}\n\nNote: This task is running in interactive mode. You can ask the user questions using the 'Ask user for input' action when you need additional information."
            
            # Create task
            self.task = prompt

            # Initialize browser and controller
            await self.setup(validate_output)

            # Set max_steps based on task complexity
            max_steps = 100 if is_complex_task else 25
            
            logger.info(f"Running agent with max_steps={max_steps} (Complex Task: {is_complex_task})")
            result = await self.agent.run(max_steps=max_steps)
            
            task_is_done = False  # Initialize task_is_done
            agent_message = None
            if result.is_done():
                task_is_done = True
                agent_message = result.history[-1].result[-1].extracted_content

            if agent_message is None:
                agent_message = 'Oops! Something went wrong while running AgentWeb.'
            
            # If task completed successfully, check for downloaded files
            result_files = []
            downloads_path = self._get_downloads_path()
            
            # Extract JSON content if enabled
            if extract_page_content:
                logger.info("Extract page content flag is enabled, extracting JSON objects...")
                # Use history.extracted_content() to get all extracted content
                all_content = result.extracted_content()
                
                json_objects = extract_json_from_content(all_content)
                
                if json_objects:
                    # Create downloads directory if it doesn't exist
                    downloads_path = Path(downloads_path)
                    downloads_path.mkdir(parents=True, exist_ok=True)
                    
                    # Save each JSON object to a file with a hash of its content as the filename
                    json_files = []
                    for json_obj in json_objects:
                        # Generate a filename based on content hash
                        content_hash = generate_content_hash(json_obj)
                        file_path = downloads_path / f"extracted_{content_hash}.json"
                        
                        # Skip if a file with this hash already exists (same content)
                        if file_path.exists():
                            logger.info(f"File with hash {content_hash} already exists, skipping duplicate content")
                            json_files.append(str(file_path))
                            continue
                        
                        # Save the JSON object to the file
                        with open(file_path, 'w') as f:
                            json.dump(json_obj, f, indent=2)
                        
                        json_files.append(str(file_path))
                    
                    logger.info(f"Extracted and saved {len(json_files)} JSON files")
                else:
                    logger.info("No JSON objects found in the extracted content")

            if self.current_execution_id:
                result_files = upload_task_result_files(downloads_path, self.current_execution_id)
            
            return {
                "success": task_is_done,
                "summary" if task_is_done else "error": agent_message,
                "llmName": self.llm_name,
                "result_files": result_files if result_files else None
            }
        except Exception as e:
            logger.error(f"Error in execute_task: {e}")
            # Clean up
            await self.cleanup()
            return {
                "success": False,
                "error": str(e),
                "llmName": self.llm_name
            }

    async def _upload_screenshot_to_s3(self, screenshot_bytes: bytes, execution_id: str) -> Optional[str]:
        """Upload screenshot to S3 and return the URL"""
        try:
            if not self.s3_bucket:
                logger.error("S3_BUCKET_NAME not configured")
                return None

            # Generate a unique filename
            timestamp = int(time.time())
            filename = f"screenshots/{execution_id}/{timestamp}.jpeg"

            # Upload to S3
            self.s3_client.put_object(
                Bucket=self.s3_bucket,
                Key=filename,
                Body=screenshot_bytes,
                ContentType='image/png'
            )

            # Generate the URL
            url = f"https://{self.s3_bucket}.s3.amazonaws.com/{filename}"
            logger.info(f"Uploaded screenshot to S3: {url}")
            return url

        except Exception as e:
            logger.error(f"Failed to upload screenshot to S3: {e}")
            return None

    async def _get_attachment_path(self, file_name: str) -> Optional[str]:
        """Get the local path for an attachment, downloading it from S3 if needed"""
        try:
            if not self.current_task_id:
                logger.error("No task ID available")
                return None

            # Get task details from DynamoDB
            tasks_table = dynamodb.Table(f'{TABLE_PREFIX}AW-Tasks')
            task = tasks_table.get_item(Key={'taskId': self.current_task_id}).get('Item')
            if not task or 'attachments' not in task:
                logger.error("No attachments found for this task")
                return None

            # Find the attachment with matching filename
            attachment = next((a for a in task['attachments'] if a['filename'] == file_name), None)
            if not attachment:
                logger.error(f"No attachment found with filename: {file_name}")
                return None

            # Create task-specific directory
            task_dir = self.attachments_dir / self.current_task_id
            task_dir.mkdir(exist_ok=True)
            local_path = task_dir / file_name

            # Download if not already present
            if not local_path.exists():
                logger.info(f"Downloading attachment {file_name} from URL")
                async with aiohttp.ClientSession() as session:
                    async with session.get(attachment['url']) as response:
                        if response.status != 200:
                            logger.error(f"Failed to download file: HTTP {response.status}")
                            return None
                        content = await response.read()
                        local_path.write_bytes(content)

            return str(local_path)
        except Exception as e:
            logger.error(f"Error getting attachment path: {e}")
            return None

    def _register_actions(self):
        @self.controller.registry.action('Get login credentials by domain')
        def get_login_credentials(domain: str) -> ActionResult:
            """Get login credentials for a domain from the database"""
            if not self.user_id:
                return ActionResult(error="User ID not provided")
            if not domain:
                return ActionResult(error=f"Please provide a domain")
            logger.info(f"Getting login credentials for domain {domain} under user {self.user_id}")
                
            table = dynamodb.Table(f'{TABLE_PREFIX}AW-Configs')
            # First get user's own configs and configs shared directly with them
            response = table.query(
                KeyConditionExpression='userId = :userId',
                FilterExpression='website = :website',
                ExpressionAttributeValues={
                    ':userId': self.user_id,
                    ':website': domain
                }
            )

            items = response.get('Items', [])
            if not items:
                # If no direct matches, check for publicly shared configs
                public_response = table.query(
                    IndexName='ShareWithEveryoneIndex',
                    KeyConditionExpression='shareWithEveryone = :shareWithEveryone',
                    FilterExpression='website = :website AND userId <> :userId',
                    ExpressionAttributeValues={
                        ':shareWithEveryone': 1,
                        ':website': domain,
                        ':userId': self.user_id
                    }
                )
                items.extend(public_response.get('Items', []))

            if not items:
                return ActionResult(error=f"No credentials found for domain: {domain}")

            try:
                # Sort items by priority:
                # 1. User's own account (no sharedBy)
                # 2. Directly shared account (has sharedBy)
                # 3. Publicly shared configs are already filtered to exclude user's own configs
                sorted_items = sorted(items, key=lambda x: (
                    0 if not x.get('sharedBy') else 1
                ))

                config = sorted_items[0]
                shared_by = config.get('sharedBy')
                decrypted_password = decrypt_password(config['password'], self.user_id, shared_by)

                if shared_by and shared_by != self.user_id:
                    logger.info(f"Using shared credentials for {domain} - shared by user: {shared_by}")
                    # Mark cookies as tainted since we're using shared credentials
                    self.cookie_tainted = True
                    logger.info("Cookies marked as tainted - will not be uploaded to S3")
                
                return ActionResult(extracted_content=f"username: {config['username']}, password: {decrypted_password}")
            except Exception as e:
                return ActionResult(error=f"Error getting credentials: {str(e)}")
                
        @self.controller.registry.action('Get integration instructions')
        def get_integration_instructions(app_name: str) -> ActionResult:
            """Get integration instructions and details for an API
            
            Parameters:
            - app_name: The name of the API configuration to retrieve (e.g., 'Stripe', 'GitHub')
            
            Returns:
            - API Name: The name of the API configuration
            - Key Name: The name of the API key as stored in the config
            - Documentation: Link to the API documentation if provided
            
            This action should be called first before using run_integration to:
            1. Verify the API configuration exists
            2. Get the API key name for reference
            3. Access documentation links for understanding how to use the API
            
            Workflow:
            1. Call get_integration_instructions with the app_name
            2. Read documentation if needed (from the returned link)
            3. Create Python code that uses the "YOUR_API_CREDENTIAL" placeholder
            4. Call run_integration with the same app_name and your Python code
            
            IMPORTANT: When creating your Python code for run_integration, 
            use "YOUR_API_CREDENTIAL" as a placeholder wherever you need to use
            the actual API credential in your code. This placeholder will be 
            automatically replaced with the real credential when the code runs.
            
            Example:
            ```python
            # GitHub API example using the placeholder
            headers = {'Authorization': f'token YOUR_API_CREDENTIAL'}
            
            # Stripe API example using the placeholder
            stripe.api_key = YOUR_API_CREDENTIAL
            ```
            """
            if not self.user_id:
                return ActionResult(error="User ID not provided")
            if not app_name:
                return ActionResult(error="Please provide an API/App name")
                
            logger.info(f"Getting integration instructions for {app_name} under user {self.user_id}")
                
            table = dynamodb.Table(f'{TABLE_PREFIX}AW-Configs')
            
            # First check user's own API configs
            user_response = table.query(
                KeyConditionExpression='userId = :userId',
                FilterExpression='isApiConfig = :isApiConfig AND appName = :appName',
                ExpressionAttributeValues={
                    ':userId': self.user_id,
                    ':isApiConfig': True,
                    ':appName': app_name
                }
            )
            
            items = user_response.get('Items', [])
            
            if not items:
                # If no direct matches, check for publicly shared API configs
                public_response = table.query(
                    IndexName='ShareWithEveryoneIndex',
                    KeyConditionExpression='shareWithEveryone = :shareWithEveryone',
                    FilterExpression='isApiConfig = :isApiConfig AND appName = :appName AND userId <> :userId',
                    ExpressionAttributeValues={
                        ':shareWithEveryone': 1,
                        ':isApiConfig': True,
                        ':appName': app_name,
                        ':userId': self.user_id
                    }
                )
                items.extend(public_response.get('Items', []))
            
            if not items:
                return ActionResult(error=f"No API configuration found for: {app_name}")
                
            try:
                # Sort items by priority (user's own first, then shared)
                sorted_items = sorted(items, key=lambda x: (
                    0 if not x.get('sharedBy') else 1
                ))
                
                config = sorted_items[0]
                
                # Create an information packet including documentation link and credential field names
                integration_info = {
                    "app_name": config['appName'],
                    "credential_field": config['username'],  # This is the API key name/field
                    "documentation_link": config.get('integrationDocLink', "No documentation link provided")
                }
                
                return ActionResult(
                    extracted_content=f"API Name: {integration_info['app_name']}\n"
                                    f"Key Name: {integration_info['credential_field']}\n"
                                    f"Documentation: {integration_info['documentation_link']}"
                )
            except Exception as e:
                return ActionResult(error=f"Error retrieving integration details: {str(e)}")
                
        @self.controller.registry.action('Run integration')
        def run_integration(app_name: str, python_code: str) -> ActionResult:
            """Run Python code with API credentials injected
            
            Parameters:
            - app_name: The name of the API configuration to use (e.g., 'Stripe', 'GitHub')
            - python_code: Valid Python code to execute with the API credentials
            
            The python_code parameter should contain complete, executable Python code that uses the API.
            
            IMPORTANT: Use 'YOUR_API_CREDENTIAL' as a placeholder in your code where you need the 
            actual API credential value. This placeholder will be automatically replaced with the 
            real credential when the code runs.
            
            Example for GitHub API:
            ```python
            import requests
            
            # Use the YOUR_API_CREDENTIAL placeholder in your code where you need the token
            headers = {'Authorization': f'token YOUR_API_CREDENTIAL'}
            response = requests.get('https://api.github.com/user/repos', headers=headers)
            
            # Print results for the agent to see
            if response.status_code == 200:
                repos = response.json()
                for repo in repos:
                    print(f"Repository: {repo['name']}")
                    print(f"Description: {repo['description']}")
                    print(f"URL: {repo['html_url']}")
                    print("-" * 40)
            else:
                print(f"Error: {response.status_code}")
                print(response.text)
            ```
            
            Important notes:
            - Code execution has a 30-second timeout
            - Standard Python libraries are available
            - External libraries like 'requests' are available
            - Return values should be printed to stdout to be returned to the agent
            - DO NOT include real credentials in your code - use YOUR_API_CREDENTIAL placeholder
            - The same placeholder text (YOUR_API_CREDENTIAL) must be used regardless of the API being used
            """
            if not self.user_id:
                return ActionResult(error="User ID not provided")
            if not app_name:
                return ActionResult(error="Please provide an API/App name")
            if not python_code:
                return ActionResult(error="Please provide Python code to execute")
            
            # Check if the placeholder is present
            if "YOUR_API_CREDENTIAL" not in python_code:
                return ActionResult(error="No 'YOUR_API_CREDENTIAL' placeholder found in code. Please include this placeholder where the API credential should be used.")
                
            logger.info(f"Running integration for {app_name}")
                
            # Get API credentials
            table = dynamodb.Table(f'{TABLE_PREFIX}AW-Configs')
            
            # First check user's own API configs
            user_response = table.query(
                KeyConditionExpression='userId = :userId',
                FilterExpression='isApiConfig = :isApiConfig AND appName = :appName',
                ExpressionAttributeValues={
                    ':userId': self.user_id,
                    ':isApiConfig': True,
                    ':appName': app_name
                }
            )
            
            items = user_response.get('Items', [])
            
            if not items:
                # If no direct matches, check for publicly shared API configs
                logger.info(f"No personal API config found for {app_name}, checking shared configs")
                public_response = table.query(
                    IndexName='ShareWithEveryoneIndex',
                    KeyConditionExpression='shareWithEveryone = :shareWithEveryone',
                    FilterExpression='isApiConfig = :isApiConfig AND appName = :appName AND userId <> :userId',
                    ExpressionAttributeValues={
                        ':shareWithEveryone': 1,
                        ':isApiConfig': True,
                        ':appName': app_name,
                        ':userId': self.user_id
                    }
                )
                items.extend(public_response.get('Items', []))
            
            if not items:
                return ActionResult(error=f"No API configuration found for: {app_name}")
                
            try:
                # Sort items by priority (user's own first, then shared)
                sorted_items = sorted(items, key=lambda x: (
                    0 if not x.get('sharedBy') else 1
                ))
                
                config = sorted_items[0]
                shared_by = config.get('sharedBy')
                
                # Decrypt the API key/secret
                api_key = decrypt_password(config['password'], self.user_id, shared_by)
                api_key_name = config['username']  # This is the API key name
                
                logger.info(f"Successfully retrieved credential for {app_name} (key name: {api_key_name})")
                
                # Execute the Python code in a safe environment with the API credentials
                import tempfile
                import subprocess
                import uuid
                
                # Create a temporary file with a random name
                temp_dir = tempfile.gettempdir()
                temp_file_path = os.path.join(temp_dir, f"integration_{uuid.uuid4()}.py")
                
                # Replace the placeholder with the actual credential
                modified_code = python_code.replace("YOUR_API_CREDENTIAL", api_key)
                
                # Add a header comment
                final_code = f"""# Integration script for {app_name}
# API credential placeholder has been replaced with the actual credential
# Original credential field name: {api_key_name}

{modified_code}
"""
                
                # Write the code to the temporary file
                with open(temp_file_path, "w") as f:
                    f.write(final_code)
                
                logger.info(f"Created temporary script at {temp_file_path}")
                
                # Execute the script with a timeout
                try:
                    logger.info(f"Executing integration script with timeout of 30 seconds")
                    result = subprocess.run(
                        ["python", temp_file_path],
                        capture_output=True,
                        text=True,
                        timeout=30  # 30 second timeout for safety
                    )
                    
                    # Clean up the temporary file
                    if os.path.exists(temp_file_path):
                        os.remove(temp_file_path)
                        logger.info("Temporary script file removed")
                    
                    # Process the result
                    if result.returncode == 0:
                        logger.info("Script executed successfully")
                        output = result.stdout
                        if not output:
                            logger.info("Script executed but produced no output")
                        return ActionResult(extracted_content=output if output else "Code executed successfully with no output")
                    else:
                        error_msg = result.stderr
                        logger.error(f"Script execution failed with error: {error_msg}")
                        return ActionResult(error=f"Execution failed: {error_msg}")
                        
                except subprocess.TimeoutExpired:
                    logger.error("Script execution timed out after 30 seconds")
                    # Clean up on timeout
                    if os.path.exists(temp_file_path):
                        os.remove(temp_file_path)
                        logger.info("Temporary script file removed after timeout")
                    return ActionResult(error="Execution timed out after 30 seconds")
                    
                except Exception as e:
                    logger.error(f"Unexpected error during script execution: {str(e)}")
                    # Clean up on any other error
                    if os.path.exists(temp_file_path):
                        os.remove(temp_file_path)
                        logger.info("Temporary script file removed after error")
                    return ActionResult(error=f"Error during execution: {str(e)}")
                    
            except Exception as e:
                logger.error(f"Error during API integration setup: {str(e)}")
                return ActionResult(error=f"Error running integration: {str(e)}")

        @self.controller.registry.action('Sleep')
        async def sleep(seconds: float) -> ActionResult:
            """Sleep for a specified number of seconds (max 5 minutes)"""
            try:
                # Convert to float and limit to 5 minutes max
                sleep_duration = min(float(seconds), 300)
                if sleep_duration <= 0:
                    return ActionResult(error="Sleep duration must be positive")
                
                logger.info(f"Sleeping for {sleep_duration} seconds")
                await asyncio.sleep(sleep_duration)
                return ActionResult(extracted_content=f"Slept for {sleep_duration} seconds")
            except ValueError:
                return ActionResult(error="Invalid sleep duration provided")
            except Exception as e:
                logger.error(f"Error in sleep: {str(e)}")
                return ActionResult(error=f"Failed to sleep: {str(e)}")

        @self.controller.registry.action('Upload file')
        async def upload_file(file_name: str, index: int, browser: BrowserContext) -> ActionResult:
            """Upload a file to a file input element on the page"""
            try:
                # Get attachment path
                file_path = await self._get_attachment_path(file_name)
                if not file_path:
                    return ActionResult(error=f"File {file_name} not found in task attachments")

                # Get the current page
                page = await browser.get_current_page()
                await page.wait_for_load_state('domcontentloaded')
                
                # Special handling for pixverse.ai
                current_url = page.url.lower()
                if 'pixverse.ai' in current_url:
                    logger.info("Detected pixverse.ai, using specific file input selector")
                    element = await page.query_selector('input[name="file"][accept*="image/png"][accept*="video/mp4"]')
                    if not element:
                        return ActionResult(error="Could not find the correct file input element")
                    
                    await element.set_input_files(file_path)

                    # Wait for upload processing
                    await page.wait_for_timeout(5000)

                    msg = f'Successfully uploaded {file_name}'
                    logger.info(msg)
                    return ActionResult(extracted_content=msg)
                
                # Default handling for other sites
                # Try iframe first, then main page
                contexts = []
                iframe = await page.query_selector('iframe')
                if iframe and (frame := await iframe.content_frame()):
                    logger.info("Found iframe, adding to contexts")
                    contexts.append(frame)
                contexts.append(page)
                
                # Try to find file input in each context
                for context in contexts:
                    # Try selectors in order of specificity
                    selectors = [
                        f'[browser-user-highlight-id="playwright-highlight-{index}"] input[type="file"]',
                        'input[type="file"]',
                        'input[accept="image/*"]'
                    ]
                    
                    for selector in selectors:
                        elements = context.locator(selector)
                        if await elements.count() > 0:
                            await elements.first.set_input_files(file_path)
                            msg = f'Successfully uploaded {file_name}'
                            logger.info(msg)
                            return ActionResult(extracted_content=msg)
                
                return ActionResult(error="Could not find file input element")
                    
            except Exception as e:
                logger.error(f'Error in upload_file: {str(e)}')
                return ActionResult(error=f'Failed to upload file: {str(e)}')

        @self.controller.registry.action('Close file dialog')
        async def close_file_dialog(browser: BrowserContext) -> ActionResult:
            """Close any open file dialog"""
            try:
                page = await browser.get_current_page()
                await page.keyboard.press('Escape')
                return ActionResult(extracted_content='File dialog closed')
            except Exception as e:
                return ActionResult(error=f'Failed to close file dialog: {str(e)}')

        @self.controller.registry.action('Download image when you have the URL')
        async def download_image(url: str, browser: BrowserContext) -> ActionResult:
            """Download an image from a URL and save it to the downloads folder."""
            try:
                # Get user-specific downloads path
                downloads_path = Path(self._get_downloads_path())
                
                # Generate a random 8-character filename
                random_name = ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=8))
                
                # Get extension from URL or default to jpg
                ext = url.split('.')[-1] if '.' in url.split('/')[-1] else 'jpg'
                filename = f"{random_name}.{ext}"
                
                filepath = downloads_path / filename
                
                # Download the image
                async with aiohttp.ClientSession() as session:
                    async with session.get(url) as response:
                        if response.status != 200:
                            raise Exception(f"Failed to download image: HTTP {response.status}")
                        
                        # Read and save the image
                        image_data = await response.read()
                        filepath.write_bytes(image_data)
                
                msg = f"Downloaded image to {filename}"
                logger.info(msg)
                return ActionResult(extracted_content=msg)
                
            except Exception as e:
                logger.error(f'Error in download_image: {str(e)}')
                return ActionResult(error=f'Failed to download image: {str(e)}')

        @self.controller.registry.action('Write file')
        async def write_file(file_name: str, extension: str, content: str) -> ActionResult:
            """Write content to a file with the specified name and extension in the downloads folder.
            
            Args:
                file_name: Name of the file without extension
                extension: File extension (without the dot)
                content: Content to write to the file in the format specified by the extension
                         (e.g., CSV format for .csv files, JSON format for .json files)
                
            Returns:
                ActionResult with the path to the created file or an error message
                
            Notes:
                The following file formats can be viewed directly in the browser:
                - Text formats: .html, .htm, .txt, .json, .csv, .xml, .md, .js, .css
                - Image formats: .jpg, .jpeg, .png, .gif, .svg, .webp
                - PDF format: .pdf
                Other formats will be downloaded when accessed.
            """
            try:
                # Get user-specific downloads path
                downloads_path = Path(self._get_downloads_path())
                
                # Sanitize file name and extension
                sanitized_name = ''.join(c for c in file_name if c.isalnum() or c in '-_')
                sanitized_ext = ''.join(c for c in extension if c.isalnum())
                
                # Create full filename with extension
                full_filename = f"{sanitized_name}.{sanitized_ext}"
                filepath = downloads_path / full_filename
                
                # Check if file already exists
                if filepath.exists():
                    return ActionResult(error=f"File {full_filename} already exists in the downloads folder. Please choose a different name.")
                
                # Validate content format based on extension
                validation_error = validate_content_format(sanitized_ext.lower(), content)
                if validation_error:
                    return ActionResult(error=validation_error)
                
                # Write content to file
                filepath.write_text(content)
                
                msg = f"Successfully wrote content to {full_filename}"
                logger.info(msg)
                return ActionResult(extracted_content=msg)
                
            except Exception as e:
                logger.error(f'Error in write_file: {str(e)}')
                return ActionResult(error=f'Failed to write file: {str(e)}')

        # Only register ask_user action if interactive mode is enabled
        if self.is_interactive:
            @self.controller.registry.action('Ask user for input')
            async def ask_user(question: str, browser: BrowserContext) -> ActionResult:
                """Ask the user a question and wait for their response. Limited to 5 questions per task."""
                try:
                    if not self.current_execution_id:
                        return ActionResult(error="No execution ID available")
                    
                    # Check if we've exceeded the question limit
                    if self.question_count >= 5:
                        return ActionResult(error="Maximum number of questions (5) has been reached for this task")
                    
                    # Increment question counter
                    self.question_count += 1
                    logger.info(f"Asking question {self.question_count}/5: {question}")
                    
                    # Take a screenshot of the current page
                    page = await browser.get_current_page()
                    screenshot_url = None
                    try:
                        # Take full page screenshot
                        screenshot_bytes = await page.screenshot(type='jpeg')
                        # Upload to S3
                        screenshot_url = await self._upload_screenshot_to_s3(
                            screenshot_bytes,
                            self.current_execution_id
                        )
                        if screenshot_url:
                            logger.info("Successfully captured and uploaded screenshot")
                    except Exception as e:
                        logger.error(f"Failed to capture or upload screenshot: {e}")
                        
                    # Get the task execution table
                    table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskExecutions')
                    
                    # Create a unique interaction ID
                    interaction_id = f"interaction_{int(time.time())}"
                    
                    # Create interaction data
                    interaction_data = {
                        'id': interaction_id,
                        'question': question,
                        'status': 'pending',
                        'timestamp': int(time.time()),
                        'question_number': self.question_count
                    }
                    
                    # Add screenshot URL if available
                    if screenshot_url:
                        interaction_data['screenshot_url'] = screenshot_url
                    
                    # Update the execution with the question and screenshot URL
                    table.update_item(
                        Key={'executionId': self.current_execution_id},
                        UpdateExpression='SET userInteractions = list_append(if_not_exists(userInteractions, :empty_list), :interaction)',
                        ExpressionAttributeValues={
                            ':empty_list': [],
                            ':interaction': [interaction_data]
                        }
                    )
                    
                    # Wait for user response with timeout
                    max_wait_time = 300  # 5 minutes timeout
                    start_time = time.time()
                    
                    while time.time() - start_time < max_wait_time:
                        response = table.get_item(Key={'executionId': self.current_execution_id})
                        execution = response.get('Item', {})
                        interactions = execution.get('userInteractions', [])
                        
                        # Find our interaction
                        for interaction in interactions:
                            if interaction['id'] == interaction_id:
                                if interaction.get('response'):
                                    logger.info(f"User responded: {interaction['response']}")
                                    return ActionResult(extracted_content=interaction['response'])
                        
                        time.sleep(2)  # Poll every 2 seconds
                    
                    return ActionResult(error="User did not respond within the timeout period")
                except Exception as e:
                    logger.error(f"Error asking user: {str(e)}")
                    return ActionResult(error=f"Error asking user: {str(e)}")

    def _get_cookies_path(self):
        """Get the path to the user's cookies file"""
        if not self.user_id:
            return None
        return str(self.context_dir / f"{self.user_id}_cookies.json")

    def _get_downloads_path(self):
        """Get the path to the downloads directory"""
        if self.current_execution_id:
            downloads_path = get_downloads_path(user_id=self.user_id, execution_id=self.current_execution_id)
        else:
            downloads_path = get_downloads_path(user_id=self.user_id)
        return downloads_path
        
    async def setup(self, validate_output=False):
        """Initialize the browser instance"""
        if not self.task:
            raise ValueError("Task must be set before setup")
        
        # Create browser context config with user-specific cookies file
        cookies_path = self._get_cookies_path()
        if cookies_path and self.cookie_sync:
            # Try to download cookies from S3 before starting
            self.cookie_sync.download_cookies(self.user_id, cookies_path)
            
        # Configure downloads path
        downloads_path = self._get_downloads_path()
        context_config = BrowserContextConfig(
            cookies_file=cookies_path,
            save_downloads_path=downloads_path
        )
        if cookies_path:
            logger.info(f"Using cookies file for user {self.user_id}: {cookies_path}")
        logger.info(f"Using downloads path: {downloads_path}")
        
        # Get headless mode from environment variable, default to False if not set
        headless = os.getenv('BROWSER_HEADLESS', 'true').lower() == 'true'
        
        # If run_user_id is set, force headless to false to allow admin interaction
        if self.run_user_id:
            logger.info(f"Task run by user {self.run_user_id} who is not the owner. Setting headless=false to allow admin interaction.")
            headless = False
            
        browser_config = BrowserConfig(new_context_config=context_config, headless=headless)
        self.browser = Browser(config=browser_config)
        
        # Get all credentials for log filtering
        if self.user_id:
            try:
                table = dynamodb.Table(f'{TABLE_PREFIX}AW-Configs')
                # Get user's own configs and configs shared directly with them
                response = table.query(
                    KeyConditionExpression='userId = :userId',
                    ExpressionAttributeValues={':userId': self.user_id}
                )
                
                # Get publicly shared configs from other users
                public_response = table.query(
                    IndexName='ShareWithEveryoneIndex',
                    KeyConditionExpression='shareWithEveryone = :shareWithEveryone',
                    FilterExpression='userId <> :userId',
                    ExpressionAttributeValues={
                        ':shareWithEveryone': 1,
                        ':userId': self.user_id
                    }
                )
                
                # Combine all configs
                all_configs = response.get('Items', []) + public_response.get('Items', [])
                
                for config in all_configs:
                    try:
                        decrypted_password = decrypt_password(config['password'], self.user_id, config.get('sharedBy'))
                        self.sensitive_data.append(decrypted_password)
                    except Exception as e:
                        logger.error(f"Error decrypting password for {config.get('website')}: {e}")
            except Exception as e:
                logger.error(f"Error fetching credentials from AW-Configs: {e}")
        logger.info(f"Loaded {len(self.sensitive_data)} sensitive values for log filtering")

        # Remove existing GIF file if it exists and generate_gif is provided
        if self.generate_gif:
            gif_path = Path(self.generate_gif)
            if gif_path.exists():
                gif_path.unlink()
            logger.info(f"GIF will be generated at: {self.generate_gif}")

        self.agent = Agent(
            task=self.task,
            llm=self.llm,
            controller=self.controller,
            browser=self.browser,
            use_vision=global_use_vision,
            max_failures=5,  # Increase max retries
            retry_delay=60,   # retry delay in seconds
            generate_gif=self.generate_gif,  # Pass GIF path from task_monitor
            validate_output=validate_output  # Pass validate_output parameter
        )

    async def cleanup(self):
        """Clean up browser resources and sync cookies"""
        try:
            if self.browser:
                # Save cookies before closing
                cookies_path = self._get_cookies_path()
                if cookies_path:
                    if self.cookie_sync and not self.cookie_tainted:
                        # Only upload cookies if they're not tainted by shared credentials
                        self.cookie_sync.upload_cookies(self.user_id, cookies_path)
                        logger.info("Cookies uploaded to S3")
                    elif self.cookie_tainted:
                        logger.info("Skipping cookie upload - cookies are tainted from using shared credentials")
                        
                    Path(cookies_path).unlink(missing_ok=True)
                    logger.info(f"Deleted cookie file at local: {cookies_path}")
                
                await self.browser.close()
            # Clean up logging handlers
            self.cleanup_logging()

            # Filter and save browser-use log if it exists
            browser_use_log = f'logs/execution_{self.current_execution_id}_browser_use.log'
            filtered_log = f'logs/execution_{self.current_execution_id}_browser_use.filtered.log'
            if Path(browser_use_log).exists():
                try:
                    # Read and filter the log file
                    filtered_lines = []
                    with open(browser_use_log, 'r') as f:
                        for line in f:
                            filtered_line = line
                            for val in self.sensitive_data:
                                filtered_line = filtered_line.replace(val, '[REDACTED]')
                            filtered_lines.append(filtered_line)

                    # Only write to filtered log if we have content to write
                    if filtered_lines:
                        file_exists = Path(filtered_log).exists()
                        with open(filtered_log, 'a' if file_exists else 'w') as f:
                            # Add separator if appending to existing file
                            if file_exists:
                                f.write("\n\n")
                                f.write("="*80 + "\n")
                                f.write(f"New execution log at {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                                f.write(f"Using LLM: {self.llm_name}\n")
                                f.write("="*80 + "\n\n")
                            else:
                                # Add header with LLM information for new file
                                f.write("="*80 + "\n")
                                f.write(f"Execution log started at {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                                f.write(f"Using LLM: {self.llm_name}\n")
                                f.write("="*80 + "\n\n")
                            f.writelines(filtered_lines)
                        logger.info("Created filtered log file")

                    # Remove the original unfiltered log file
                    Path(browser_use_log).unlink()
                    logger.info(f"Removed original unfiltered log file: {browser_use_log}")
                except Exception as e:
                    logger.error(f"Error filtering browser-use log: {e}")
                    # If anything goes wrong, ensure both files are deleted
                    if Path(browser_use_log).exists():
                        Path(browser_use_log).unlink()
                    if Path(filtered_log).exists():
                        Path(filtered_log).unlink()
                    logger.info("Removed log files after error")
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")
            raise

    def get_action_history(self):
        """Get the list of actions performed by the agent"""
        if not self.agent:
            return []
        return self.agent.action_history

async def main():
    parser = argparse.ArgumentParser(description='Web Agent for task automation')
    parser.add_argument('--task_id', required=True, help='Task ID')
    parser.add_argument('--prompt_file', required=True, help='File containing the task prompt')
    parser.add_argument('--user_id', required=True, help='User ID')
    parser.add_argument('--llm_name', required=True, help='Full LLM name in format platform->provider->model')
    parser.add_argument('--execution_id', required=True, help='Execution ID')
    parser.add_argument('--gif_path', required=True, help='Path for the GIF output')
    parser.add_argument('--interactive', action='store_true', help='Enable interactive mode')
    parser.add_argument('--run_user_id', help='ID of the user who ran the task if different from owner')
    parser.add_argument('--is_complex_task', action='store_true', help='Enable complex task mode with 100 steps')
    parser.add_argument('--extract-page-content', action='store_true', help='Extract page content as JSON files')
    parser.add_argument('--validate-output', action='store_true', help='Validate output from the agent')
    args = parser.parse_args()

    # Read prompt from file
    try:
        with open(args.prompt_file, 'r') as f:
            prompt = f.read()
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": f"Failed to read prompt file: {str(e)}",
            "llmName": args.llm_name
        }))
        sys.exit(1)

    agent = WebAgent(args.user_id, args.llm_name)
    agent.run_user_id = args.run_user_id  # Set run_user_id
    try:
        result = await agent.execute_task(
            prompt,
            execution_id=args.execution_id,
            is_interactive=args.interactive,
            task_id=args.task_id,
            generate_gif=args.gif_path,
            is_complex_task=args.is_complex_task,
            extract_page_content=args.extract_page_content,
            validate_output=args.validate_output
        )
        print(json.dumps(result))
        sys.exit(0 if result["success"] else 1)
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e),
            "llmName": args.llm_name
        }))
        sys.exit(1)
    finally:
        await agent.cleanup()

if __name__ == '__main__':
    asyncio.run(main()) 