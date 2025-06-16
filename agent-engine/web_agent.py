#!/usr/bin/env python3
import argparse
import json
import sys
import os
import re
import uuid
import threading
from typing import Dict, Any, Optional, List, Union
import browser_use
from browser_use import Agent, Controller
from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContextConfig, BrowserContext
from langchain_aws import ChatBedrock
from langchain_openai import AzureChatOpenAI, ChatOpenAI
from pydantic import SecretStr, BaseModel
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
from task_utils import get_downloads_path, upload_task_result_files, get_llm, validate_content_format, extract_json_from_content, generate_content_hash, get_agent_code_base_path, call_github_api, run_python_code_in_sandbox, fetch_api_credentials, decrypt_password, get_all_configs, parse_json
from knowledge_base_utils import get_knowledge_base_manager
from datetime import datetime, timezone
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
global_tool_calling_method_for_azure: Optional[str] = "function_calling"

controller = Controller()

class IntegrationTestParams(BaseModel):
    app_names: List[str]
    python_code: str

class UpdateLeadListParams(BaseModel):
    """Parameters for updating lead list records."""
    records: list[dict]

class LogFilterThread(threading.Thread):
    """Thread that continuously filters the log file in real-time"""
    
    def __init__(self, 
                 source_log_file: str, 
                 filtered_log_file: str, 
                 sensitive_data: List[str],
                 llm_name: str):
        """Initialize the log filter thread
        
        Args:
            source_log_file: Path to the source log file
            filtered_log_file: Path to the filtered log file
            sensitive_data: List of sensitive data to redact
            llm_name: Name of the LLM being used
        """
        super().__init__()
        self.source_log_file = source_log_file
        self.filtered_log_file = filtered_log_file
        self.sensitive_data = sensitive_data
        self.llm_name = llm_name
        self.running = True
        self.last_position = 0
        self.daemon = True  # Make thread exit when main thread exits
        
        # Initialize filtered log file with header
        if Path(filtered_log_file).exists():
            # Add header for existing file
            with open(filtered_log_file, 'a') as f:
                f.write("\n\n")
                f.write("="*80 + "\n")
                f.write(f"New execution log at {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write(f"Using LLM: {self.llm_name}\n")
                f.write("="*80 + "\n\n")
        else:
            # Add header for new file
            with open(filtered_log_file, 'w') as f:
                f.write("="*80 + "\n")
                f.write(f"Execution log started at {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write(f"Using LLM: {self.llm_name}\n")
                f.write("="*80 + "\n\n")
        
        # Log thread creation
        logging.getLogger(__name__).info(f"Created log filter thread for {source_log_file}")
    
    def stop(self):
        """Stop the thread"""
        self.running = False
        
    def run(self):
        """Run the thread - continuously filter the log file"""
        logger = logging.getLogger(__name__)
        logger.info("Starting log filter thread")
        
        while self.running:
            try:
                if not Path(self.source_log_file).exists():
                    # Source log file doesn't exist yet, wait and try again
                    time.sleep(1)
                    continue
                
                # Get file size
                file_size = Path(self.source_log_file).stat().st_size
                
                # If file size hasn't changed, wait and try again
                if file_size <= self.last_position:
                    time.sleep(1)
                    continue
                
                # Read new content
                with open(self.source_log_file, 'r') as f:
                    f.seek(self.last_position)
                    new_content = f.read()
                
                # Filter sensitive data
                filtered_content = new_content
                for val in self.sensitive_data:
                    if val and len(val) > 3:  # Only replace if value is non-empty and reasonably long
                        filtered_content = filtered_content.replace(val, '[REDACTED]')
                
                # Append to filtered log
                with open(self.filtered_log_file, 'a') as f:
                    f.write(filtered_content)
                
                # Update last position
                self.last_position = file_size
                
            except Exception as e:
                logger.error(f"Error in log filter thread: {e}")
                
            # Sleep briefly to avoid high CPU usage
            time.sleep(0.5)
        
        logger.info("Log filter thread stopped")

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
        self.use_shared_browser = False
        self.context_dir = Path('context')
        self.context_dir.mkdir(exist_ok=True)
        self.attachments_dir = Path('attachments')
        self.attachments_dir.mkdir(exist_ok=True)
        self.cookie_sync = CookieSync() if self.user_id else None
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
        self.run_user_id = None  # Added to store run_user_id
        self.log_filter_thread = None
        self.is_agentic_dev_mode = False  # Initialize is_agentic_dev_mode property
        self.output_as_html = False # Initialize output_as_html property
        self.turn_off_headless = False  # Initialize turn_off_headless property
        self.use_knowledge_base = False  # Initialize use_knowledge_base property
        self.update_knowledge_base = False  # Initialize update_knowledge_base property
        self.update_lead_list = False  # Initialize update_lead_list property
        self.lead_list_identifier = None  # Initialize lead_list_identifier property

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
        
        # Set up the filtered log file
        filtered_log = f'logs/execution_{execution_id}_browser_use.filtered.log'
        
        # Start the log filter thread
        self.log_filter_thread = LogFilterThread(
            source_log_file=log_file,
            filtered_log_file=filtered_log,
            sensitive_data=self.sensitive_data,
            llm_name=self.llm_name
        )
        self.log_filter_thread.start()
        
        return log_file

    def cleanup_logging(self):
        """Remove the execution-specific log handlers"""
        # Stop the log filter thread if it's running
        if self.log_filter_thread and self.log_filter_thread.is_alive():
            try:
                # First set the stop flag
                self.log_filter_thread.stop()
                
                # Wait a short time for the thread to stop gracefully
                timeout = 2.0
                logger.info(f"Waiting up to {timeout}s for log filter thread to stop...")
                self.log_filter_thread.join(timeout=timeout)
                
                # Check if thread actually stopped
                if self.log_filter_thread.is_alive():
                    logger.warning("Log filter thread did not stop within timeout period")
                    # We'll continue anyway as it's a daemon thread
                else:
                    logger.info("Stopped log filter thread successfully")
            except Exception as e:
                logger.error(f"Error stopping log filter thread: {e}")
                # Continue with cleanup even if there's an error
        
        # Remove log handlers
        for log, handler in self._log_handlers:
            try:
                log.removeHandler(handler)
                handler.close()
            except Exception as e:
                logger.error(f"Error removing log handler: {e}")
        
        # Clear the handlers list
        self._log_handlers.clear()
        
        # Clear the reference to the log filter thread to help with garbage collection
        self.log_filter_thread = None

    async def execute_task(self, prompt: str, execution_id: str = None, is_interactive: bool = False, task_id: str = None, generate_gif: str = None, is_complex_task: bool = False, extract_page_content: bool = False, validate_output: bool = False, output_as_json: bool = False, is_agentic_dev_mode: bool = False, output_as_html: bool = False, use_shared_browser: bool = False, turn_off_headless: bool = False, use_knowledge_base: bool = False, update_knowledge_base: bool = False, update_lead_list: bool = False, lead_list_identifier: str = None) -> Dict[str, Any]:
        """Execute a task based on the natural language prompt"""
        log_file = None
        try:
            # Set class variables
            self.current_execution_id = execution_id
            self.current_task_id = task_id
            self.is_interactive = is_interactive
            self.generate_gif = generate_gif
            self.is_agentic_dev_mode = is_agentic_dev_mode
            self.output_as_html = output_as_html
            self.use_shared_browser = use_shared_browser
            self.turn_off_headless = turn_off_headless
            self.use_knowledge_base = use_knowledge_base
            self.update_knowledge_base = update_knowledge_base
            self.update_lead_list = update_lead_list
            self.lead_list_identifier = lead_list_identifier
            # Set up logging
            log_file = self.setup_execution_logging(execution_id)
            
            logger.info(f"Executing task with prompt: {prompt[:100]}...")
            logger.info(f"Interactive mode: {is_interactive}")
            logger.info(f"Complex task: {is_complex_task}")
            logger.info(f"Extract page content: {extract_page_content}")
            logger.info(f"Validate output: {validate_output}")
            logger.info(f"Output as JSON: {output_as_json}")
            
            # Register actions after setting is_interactive
            self._register_actions()
            
            # Add interactive mode context to the prompt if enabled
            if self.is_interactive:
                prompt = f"{prompt}\n\nNote: This task is running in interactive mode. You can ask the user questions using the 'Ask user for input' action when you need additional information."
            
            # Add JSON output instruction if enabled
            if output_as_json:
                prompt = f"{prompt}\n\nRequirement: Output result as JSON instead of free text."
            elif self.output_as_html:
                prompt = f"{prompt}\n\nRequirement: The final output for this task MUST be in well-formatted HTML5 with modern styling. You MUST use the 'Write file' action to save this HTML content into a file with an .html extension. The HTML output should include:\n1. A clean, modern layout with proper spacing and typography\n2. Visual elements like tables, charts or diagrams to represent data (using Chart.js)\n3. Clear section headers and organized content structure\n4. CSS styling for visual appeal\n5. Proper citations and references for any external sources or data"

            # Add knowledge base instruction if enabled
            if self.use_knowledge_base:
                prompt = f"{prompt}\n\nImportant: Before browsing the web, you MUST first search the knowledge base using the search_knowledge_base action to find relevant information. Only proceed with web browsing if the knowledge base search doesn't provide sufficient information."

            # Add lead list instruction if enabled
            if self.update_lead_list:
                prompt = f"{prompt}\n\nImportant: For this task, you MUST use the {'update_lead_list_json' if 'gemini' in self.llm_name.lower() else 'update_lead_list'} action to store your findings instead of reporting them in the final result. Each record should contain the identifier field {self.lead_list_identifier}. The action will handle both adding new records and updating existing ones. You can use the get_lead_list_identifiers action to get the list of existing identifiers."

            # Create task
            self.task = prompt

            # Initialize browser and controller
            await self.setup(validate_output)

            # Set max_steps based on task complexity
            if is_complex_task:
                max_steps = int(os.getenv('MAX_COMPLEX_TASK_STEPS', '100'))
            else:
                max_steps = 25
            
            logger.info(f"Running agent with max_steps={max_steps} (Complex Task: {is_complex_task})")
            result = await self.agent.run(max_steps=max_steps)
            
            task_is_done = False  # Initialize task_is_done
            agent_message = None
            if result.is_done():
                task_is_done = True
                agent_message = result.history[-1].result[-1].extracted_content

            if agent_message is None:
                agent_message = 'Oops! Something went wrong while running AgentWeb.'
            
            # If json output is required, validate the response is proper JSON
            if output_as_json and task_is_done:
                logger.info("JSON output required, validating response...")
                try:
                    # Use parse_json function to extract JSON from the response
                    json_output = parse_json(agent_message)
                    
                    if json_output is None:
                        # No valid JSON found
                        logger.error("No valid JSON found in response")
                        return {
                            "success": False,
                            "error": "The agent failed to produce a valid JSON output as requested.",
                            "llmName": self.llm_name
                        }
                    
                    logger.info(f"Valid JSON output extracted: {agent_message[:100]}...")
                
                except Exception as e:
                    logger.error(f"Error validating JSON output: {e}")
                    return {
                        "success": False,
                        "error": f"The agent failed to produce a valid JSON output: {str(e)}",
                        "llmName": self.llm_name
                    }
            
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
            """Get login credentials for a domain based on use_shared_browser mode."""
            if not self.user_id:
                return ActionResult(error="User ID not provided")
            if not domain:
                return ActionResult(error=f"Please provide a domain")

            logger.info(f"Getting login credentials for domain {domain} under user {self.user_id}, use_shared_browser: {self.use_shared_browser}")
                
            table = dynamodb.Table(f'{TABLE_PREFIX}AW-Configs')
            items = []

            if self.use_shared_browser:
                # Fetch ONLY publicly shared website configurations
                logger.info(f"use_shared_browser is True. Fetching only publicly shared credentials for domain: {domain}")
                public_response = table.query(
                    IndexName='ShareWithEveryoneIndex',
                    KeyConditionExpression='shareWithEveryone = :shareWithEveryone',
                    FilterExpression='website = :website AND (attribute_not_exists(isApiConfig) OR isApiConfig = :isApiFalse)',
                    ExpressionAttributeValues={
                        ':shareWithEveryone': 1,
                        ':website': domain,
                        ':isApiFalse': False
                    }
                )
                items.extend(public_response.get('Items', []))
                # For public credentials, sharedBy will typically be the original owner, not relevant for decryption by current user_id directly
                # Decrypt with self.user_id, assuming public means any user can use it with their "session" context
            else:
                # Fetch ONLY user's own website configurations (not shared to them by others)
                logger.info(f"use_shared_browser is False. Fetching only user's own credentials for domain: {domain}")
                user_response = table.query(
                    KeyConditionExpression='userId = :userId',
                    FilterExpression='website = :website AND (attribute_not_exists(isApiConfig) OR isApiConfig = :isApiFalse)',
                    ExpressionAttributeValues={
                        ':userId': self.user_id,
                        ':website': domain,
                        ':isApiFalse': False
                    }
                )
                items.extend(user_response.get('Items', []))

            if not items:
                # If no credentials found, get all available domains for the user based on the current mode
                available_domains = set()
                # This call to get_all_configs respects use_shared_browser internally
                all_mode_visible_configs = get_all_configs(self.user_id, use_shared_browser=self.use_shared_browser)
                
                for config_item in all_mode_visible_configs:
                    if config_item.get('website') and not config_item.get('isApiConfig'):
                        available_domains.add(config_item['website'])
                
                domains_text = ""
                if available_domains:
                    domains_text = f"\nAvailable domains: {', '.join(available_domains)}"
                
                return ActionResult(error=f"No credentials found for domain: {domain}.{domains_text}")

            try:
                # In shared browser mode, any publicly shared config is fine. We'll pick the first.
                # In user-own mode, there should ideally be only one.
                # The previous complex sorting logic for combining user/shared/public is no longer needed due to stricter separation.
                config_to_use = items[0] 
                
                # 'sharedBy' is relevant for decryption if present, even for public items if the decryption key depends on original owner.
                # However, decrypt_password uses self.user_id if shared_by is None.
                # For public items, if they are truly public, their decryption should not depend on a specific 'sharedBy' that isn't the current user.
                # If use_shared_browser is True, we might need a way to decrypt public credentials that don't rely on self.user_id or a specific sharedBy.
                # For now, we assume decrypt_password can handle it or that public creds are stored differently.
                # Let's pass config_to_use.get('sharedBy') as is.
                shared_by_for_decryption = config_to_use.get('sharedBy')

                # Get the encrypted password from either encryptedPassword or legacy password field
                encrypted_password = config_to_use.get('encryptedPassword') or config_to_use.get('password')
                if not encrypted_password:
                    logger.warning(f"No password found for {config_to_use.get('website')}")
                    return ActionResult(error=f"No password found for {config_to_use.get('website')}")
                    
                decrypted_password = decrypt_password(encrypted_password, self.user_id, shared_by_for_decryption)
                
                return ActionResult(extracted_content=f"username: {config_to_use['username']}, password: {decrypted_password}")
            except Exception as e:
                logger.error(f"Error processing credentials for domain {domain}: {str(e)}")
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
                
        @self.controller.registry.action('Run integration test with API credentials, load the API credentials from environment variables with names like GITHUB_API_CREDENTIAL, STRIPE_API_CREDENTIAL, etc.', param_model=IntegrationTestParams)
        def run_integration_test(params: IntegrationTestParams) -> ActionResult:
            """Run Python code with API credentials loaded from environment variables
            
            Parameters:
            - params: IntegrationTestParams containing:
              - app_names: List of API configuration names to retrieve (e.g., ['Stripe', 'GitHub'])
                Must be provided as a list, even for a single API (e.g., ['GitHub'])
              - python_code: Valid Python code to execute with the API credentials
            
            The python_code parameter should contain complete, executable Python code that uses the API.
            
            IMPORTANT: The code should use environment variables directly to access API credentials.
            For example, use GITHUB_API_CREDENTIAL for GitHub API, STRIPE_API_CREDENTIAL for Stripe API, etc.
            
            Example for GitHub and Stripe API:
            ```python
            import requests
            import stripe
            import os
            from dotenv import load_dotenv
            
            # Load environment variables from .env file
            load_dotenv()
            
            # GitHub API
            headers = {'Authorization': f'token {os.getenv("GITHUB_API_CREDENTIAL")}'}
            response = requests.get('https://api.github.com/user/repos', headers=headers)
            
            # Stripe API
            stripe.api_key = os.getenv("STRIPE_API_CREDENTIAL")
            customers = stripe.Customer.list(limit=3)
            
            # Print results
            print("GitHub repositories:")
            if response.status_code == 200:
                repos = response.json()
                for repo in repos[:3]:
                    print(f"- {repo['name']}")
            
            print("\nStripe customers:")
            for customer in customers:
                print(f"- {customer.id}: {customer.email}")
            ```
            
            Important notes:
            - Code execution has a timeout set by SANDBOX_TIMEOUT_SECONDS environment variable
            - Standard Python libraries are available
            - External libraries like 'requests' are available
            - Return values should be printed to stdout to be returned to the agent
            - Use environment variables directly to access API credentials
            - The credentials will be loaded from environment variables at runtime
            """
            if not self.user_id:
                return ActionResult(error="User ID not provided")
            
            # Type checking for app_names
            if not isinstance(params.app_names, list):
                return ActionResult(error="app_names must be a list of strings. Example: ['GitHub'] or ['GitHub', 'Stripe']")
            
            if not params.app_names:
                return ActionResult(error="Please provide at least one API/App name in the list")
                
            # Verify all items in app_names are strings
            if not all(isinstance(name, str) for name in params.app_names):
                return ActionResult(error="All API names in app_names must be strings")
                
            if not params.python_code:
                return ActionResult(error="Please provide Python code to execute")
            
            logger.info(f"Running integration for apps: {', '.join(params.app_names)}")
            
            try:
                # Get API credentials
                api_credentials, api_key_names = fetch_api_credentials(self.user_id, params.app_names)
                
                if not api_credentials:
                    return ActionResult(error=f"Failed to retrieve API credentials for {', '.join(params.app_names)}")
                
                # Check if we got all the requested credentials
                missing_apps = [app for app in params.app_names if app not in api_credentials]
                if missing_apps:
                    return ActionResult(error=f"No API configuration found for: {', '.join(missing_apps)}")
                
                # Create environment variables for the credentials
                env_vars = {}
                header_parts = []
                for app_name, cred_info in api_credentials.items():
                    env_var_name = f"{app_name.upper()}_API_CREDENTIAL"
                    env_vars[env_var_name] = cred_info["value"]
                    header_parts.append(f"# App: {app_name}")
                    header_parts.append(f"# API credential field name: {api_key_names[app_name]}")
                    header_parts.append(f"# Environment variable: {env_var_name}")
                    header_parts.append("")
                
                header_comment = "\n".join(header_parts).strip()
                
                # Execute the Python code in a sandboxed environment using the utility function
                return run_python_code_in_sandbox(
                    python_code=params.python_code,
                    execution_id=self.current_execution_id,
                    user_id=self.user_id,
                    script_type="integration",
                    header_comment=header_comment,
                    additional_env_vars=env_vars
                )

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

        @self.controller.registry.action('Get approved Python code')
        async def get_approved_python_code() -> ActionResult:
            """
            Retrieve a list of available Python code from GitHub that the agent is allowed to run.
            
            This action searches the GitHub repository and returns a list of available Python code files.
            
            Returns:
                A list of available Python code files with their filenames.
                You should use just the filename when calling run_approved_python_code or submit_python_code.
            """
            try:
                # Check if user_id is available
                if not self.user_id:
                    return ActionResult(error="User ID not available")
                
                # Get the base path using the utility function
                base_path = get_agent_code_base_path(self.user_id, self.current_task_id)
                
                # Create the GitHub API endpoint
                endpoint = f"repos/john-the-dev/agentweb-agentcode/contents/{base_path}"
                
                # Call GitHub API
                status, content, error = await call_github_api("get", endpoint)
                
                if status == 404:
                    # Special handling for 404 - no files available yet
                    message = "No Python code files are available yet for this user/task."
                    return ActionResult(extracted_content=message)
                elif error:
                    return ActionResult(error=f"Failed to fetch code list: {status}. Path {base_path} may not exist.")
                
                # Filter for Python files only
                python_files = [
                    {
                        "name": item["name"],
                        "size": item["size"]
                    }
                    for item in content if item["name"].endswith(".py")
                ]
                
                # Format the result
                if python_files:
                    result_text = "Available Python code:\n\n"
                    for file in python_files:
                        result_text += f"  Filename: {file['name']}\n"
                        result_text += f"  Size: {file['size']} bytes\n\n"
                    
                    result_text += "Note: Use only the filename when calling run_approved_python_code or submit_python_code."
                else:
                    result_text = f"No Python code files found"
                
                logger.info(f"Found {len(python_files)} Python files")
                return ActionResult(extracted_content=result_text)
                
            except Exception as e:
                logger.error(f"Error retrieving Python code list: {str(e)}")
                return ActionResult(error=f"Failed to retrieve Python code list: {str(e)}")

        @self.controller.registry.action('Run approved Python code')
        async def run_approved_python_code(code_file_name: str) -> ActionResult:
            """
            Run Python code identified by the provided filename.
            
            The function retrieves the code from GitHub and executes it in a sandboxed environment.
            API credentials will be loaded from environment variables.
            
            Parameters:
                code_file_name: The filename of the Python code to run (e.g., "script.py").
                               Do not include any path information, just the filename.
                
            Returns:
                The output of the executed Python code
            """
            try:
                # Check if user_id is available
                if not self.user_id:
                    return ActionResult(error="User ID not available")
                
                # Validate that code_file_name is just a filename, not a path
                if "/" in code_file_name or "\\" in code_file_name:
                    return ActionResult(error="Invalid filename. Please provide just the filename without any path (e.g., 'script.py')")
                
                # Ensure filename ends with .py
                if not code_file_name.endswith('.py'):
                    return ActionResult(error="Invalid filename. The file must have a .py extension")
                
                # Get the base path using the utility function
                base_path = get_agent_code_base_path(self.user_id, self.current_task_id)
                full_path = f"{base_path}/{code_file_name}"
                
                logger.info(f"Using filename: {code_file_name}, full path: {full_path}")
                
                # Create GitHub API endpoint
                endpoint = f"repos/john-the-dev/agentweb-agentcode/contents/{full_path}"
                
                # Call GitHub API to get file content
                status, content, error = await call_github_api("get", endpoint)
                
                # Return error if file not found
                if status == 404:
                    return ActionResult(error=f"File '{code_file_name}' not found")
                elif error:
                    return ActionResult(error=f"Failed to fetch code: {status}")
                
                # Decode content from base64
                if content.get("encoding") == "base64" and content.get("content"):
                    python_code = base64.b64decode(content["content"]).decode("utf-8")
                else:
                    return ActionResult(error="Invalid content format received from GitHub")
                
                # Create header comment with metadata
                header_parts = [
                    f"# GitHub code execution from {code_file_name}",
                    f"# Executed at: {time.strftime('%Y-%m-%d %H:%M:%S')}"
                ]
                
                # Get all API credentials
                try:
                    # Get all available API credentials
                    api_credentials, api_key_names = fetch_api_credentials(self.user_id)
                    
                    if api_credentials:
                        # Create environment variables for the credentials
                        env_vars = {}
                        for app_name, cred_info in api_credentials.items():
                            env_var_name = f"{app_name.upper()}_API_CREDENTIAL"
                            env_vars[env_var_name] = cred_info["value"]
                            header_parts.append(f"# API credential available: {app_name}")
                            header_parts.append(f"# API credential field name: {api_key_names[app_name]}")
                            header_parts.append(f"# Environment variable: {env_var_name}")
                            header_parts.append("")
                        
                        header_parts.append("# Note: API credentials are available as environment variables")
                except Exception as e:
                    logger.warning(f"Error processing API credentials: {str(e)}")
                    # Continue without credential setup

                # Create a header comment for the script
                header_comment = "\n".join(header_parts)

                # Execute the Python code in a sandboxed environment using the utility function
                return run_python_code_in_sandbox(
                    python_code=python_code,
                    execution_id=self.current_execution_id,
                    user_id=self.user_id,
                    script_type="approved",
                    header_comment=header_comment,
                    additional_env_vars=env_vars
                )
                
            except Exception as e:
                logger.error(f"Error running Python code: {str(e)}")
                return ActionResult(error=f"Failed to run Python code: {str(e)}")

        @self.controller.registry.action('Submit Python code')
        async def submit_python_code(python_code: str, code_file_name: str, is_new_file: bool = False) -> ActionResult:
            """
            Submit Python code to GitHub as a pull request.
            
            The function creates or updates a file in the GitHub repository via a PR.
            
            Parameters:
                python_code: The Python code to submit
                code_file_name: The filename to use. Should be just a filename (e.g., "script.py") without any path.
                                This parameter is required.
                is_new_file: Boolean indicating whether to create a new file (True) or update an existing one (False).
                             If set to True and a file with the same name already exists, a new file with a timestamp
                             will be created instead.
                
            Returns:
                The URL of the created pull request
            """
            try:
                # Check if user_id is available
                if not self.user_id:
                    return ActionResult(error="User ID not available")
                
                # Get the base path using the utility function
                base_path = get_agent_code_base_path(self.user_id, self.current_task_id)
                
                # GitHub API endpoints
                api_base = "https://api.github.com"
                
                # Validate that code_file_name is just a filename, not a path
                if "/" in code_file_name or "\\" in code_file_name:
                    return ActionResult(error="Invalid filename. Please provide just the filename without any path (e.g., 'script.py')")
                
                # Ensure filename ends with .py
                if not code_file_name.endswith('.py'):
                    code_file_name += '.py'
                
                # Construct the full path
                full_path = f"{base_path}/{code_file_name}"
                logger.info(f"Using filename: {code_file_name}, full path: {full_path}")
                
                # Create a unique branch name for the PR
                timestamp = int(time.time())
                random_suffix = ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=6))
                branch_name = f"agent-code-submission-{timestamp}-{random_suffix}"
                
                # 1. Get the default branch (usually 'main' or 'master')
                repo_endpoint = "repos/john-the-dev/agentweb-agentcode"
                repo_status, repo_info, repo_error = await call_github_api("get", repo_endpoint)
                
                if repo_error:
                    return ActionResult(error=f"Failed to get repository info: {repo_status}")
                
                default_branch = repo_info["default_branch"]
                
                # 2. Get the latest commit SHA on the default branch
                ref_endpoint = f"repos/john-the-dev/agentweb-agentcode/git/ref/heads/{default_branch}"
                ref_status, ref_data, ref_error = await call_github_api("get", ref_endpoint)
                
                if ref_error:
                    return ActionResult(error=f"Failed to get reference: {ref_status}")
                
                sha = ref_data["object"]["sha"]
                
                # 3. Create a new branch
                branch_endpoint = "repos/john-the-dev/agentweb-agentcode/git/refs"
                branch_data = {
                    "ref": f"refs/heads/{branch_name}",
                    "sha": sha
                }
                
                branch_status, branch_result, branch_error = await call_github_api("post", branch_endpoint, json_data=branch_data)
                
                if branch_error:
                    return ActionResult(error=f"Failed to create branch: {branch_status}")
                
                logger.info(f"Created branch: {branch_name}")
                
                # 4. Check if file exists to get its SHA (for updates)
                file_sha = None
                file_exists = False
                
                check_file_endpoint = f"repos/john-the-dev/agentweb-agentcode/contents/{full_path}"
                file_status, file_info, file_error = await call_github_api("get", check_file_endpoint)
                
                if file_status == 200:
                    file_exists = True
                    file_sha = file_info.get("sha")
                    logger.info(f"Existing file found, SHA: {file_sha}")
                
                # If is_new_file is True and file exists, create a new filename with timestamp
                if is_new_file and file_exists:
                    return ActionResult(error=f"File '{code_file_name}' already exists. Please choose a different filename or set is_new_file to False to update the existing file.")
                
                # If file exists and is_new_file is False, we need the SHA to update
                if not is_new_file and not file_exists:
                    return ActionResult(error=f"File '{code_file_name}' does not exist. Please choose an existing filename from get_approved_python_code or set is_new_file to True to create a new file.")
                
                # 5. Create or update the file
                # Add header comment with metadata
                python_code_with_header = f"""#!/usr/bin/env python3
# Agent-generated Python code
# Generated at: {time.strftime('%Y-%m-%d %H:%M:%S')}
# Description: Code submitted by AgentWeb

{python_code}
"""
                
                file_data = {
                    "message": f"Agent submission: {code_file_name}",
                    "content": base64.b64encode(python_code_with_header.encode()).decode(),
                    "branch": branch_name
                }
                
                if file_sha:
                    file_data["sha"] = file_sha
                
                put_file_endpoint = f"repos/john-the-dev/agentweb-agentcode/contents/{full_path}"
                put_status, put_result, put_error = await call_github_api("put", put_file_endpoint, json_data=file_data)
                
                if put_error:
                    return ActionResult(error=f"Failed to create/update file: {put_status}")
                
                logger.info(f"Successfully {'created' if not file_sha else 'updated'} file: {code_file_name}")
                
                # 6. Create a pull request
                pr_endpoint = "repos/john-the-dev/agentweb-agentcode/pulls"
                pr_data = {
                    "title": f"Agent Code Submission: {code_file_name}",
                    "body": "This PR contains Python code generated or submitted by the AgentWeb agent.\n\nPlease review the code carefully before merging.",
                    "head": branch_name,
                    "base": default_branch
                }
                
                pr_status, pr_info, pr_error = await call_github_api("post", pr_endpoint, json_data=pr_data)
                
                if pr_error:
                    return ActionResult(error=f"Failed to create PR: {pr_status}")
                
                pr_html_url = pr_info["html_url"]
                logger.info(f"Created PR: {pr_html_url}")
                
                result_message = f"""
Python code successfully submitted to GitHub.
                
Filename: {code_file_name}
Branch: {branch_name}
Pull Request: {pr_html_url}
Operation: {'Created new file' if (is_new_file or not file_exists) else 'Updated existing file'}

Once the PR is approved and merged, this code will be available through the 'Run approved Python code' action using the filename: {code_file_name}
"""
                
                return ActionResult(extracted_content=result_message)
                
            except Exception as e:
                logger.error(f"Error submitting Python code: {str(e)}")
                return ActionResult(error=f"Failed to submit Python code: {str(e)}")

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

        # Add agentic dev mode actions
        if self.is_agentic_dev_mode:
            @self.controller.registry.action('Get current page content')
            async def get_current_page_content(browser: BrowserContext) -> ActionResult:
                """Get the HTML content of the current page."""
                try:
                    page = await browser.get_current_page()
                    content = await page.content()
                    return ActionResult(extracted_content=content)
                except Exception as e:
                    logger.error(f"Error getting page content: {str(e)}")
                    return ActionResult(error=f"Failed to get page content: {str(e)}")
            
            @self.controller.registry.action('Run JavaScript on current page')
            async def run_javascript_on_current_page(script: str, browser: BrowserContext) -> ActionResult:
                """Run JavaScript code on the current page and return the result."""
                try:
                    page = await browser.get_current_page()
                    result = await page.evaluate(script)
                    
                    # Convert result to string if it's not already
                    if not isinstance(result, str):
                        try:
                            result = json.dumps(result, default=str)
                        except:
                            result = str(result)
                    
                    return ActionResult(extracted_content=result)
                except Exception as e:
                    logger.error(f"Error running JavaScript: {str(e)}")
                    return ActionResult(error=f"Failed to run JavaScript: {str(e)}")

        if self.use_knowledge_base:
            @self.controller.registry.action('Search knowledge base')
            def search_knowledge_base(query: str) -> ActionResult:
                """Search the knowledge base for relevant information"""              
                try:
                    # Search both public and private knowledge bases
                    public_kb = get_knowledge_base_manager('public')
                    public_results = public_kb.search_knowledge(query)
                    
                    private_results = []
                    # Only search private knowledge base if user is authenticated
                    if self.user_id:
                        private_kb = get_knowledge_base_manager('private', self.user_id)
                        private_results = private_kb.search_knowledge(query)
                    
                    # Combine results
                    all_results = public_results + private_results
                    
                    # Format results with source information
                    formatted_results = []
                    for i, result in enumerate(all_results):
                        source = "public" if i < len(public_results) else "private"
                        formatted_results.append(f"Result {i+1} (Source: {source}):\n{result['content']}")
                    
                    return ActionResult(
                        extracted_content=f"Found {len(all_results)} results for query '{query}':\n\n" + 
                        "\n\n".join(formatted_results)
                    )
                except Exception as e:
                    return ActionResult(error=f"Failed to search knowledge base: {str(e)}")

        # Add lead list actions if update_lead_list is enabled
        if self.update_lead_list:
            @self.controller.registry.action('Get lead list identifiers')
            def get_lead_list_identifiers(limit: int = 1000) -> ActionResult:
                """Get the list of lead list identifiers for the current task
                
                Parameters:
                - limit: Maximum number of identifiers to return (default: 1000)
                
                Returns:
                - ActionResult with list of identifiers
                """
                if not self.lead_list_identifier:
                    logger.error("Lead list identifier is not configured for this task")
                    return ActionResult(error="Lead list identifier is not configured for this task")
                
                try:
                    logger.info(f"Getting lead list identifiers for task {self.current_task_id} with limit {limit}")
                    lead_list_table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskLeadList')
                    response = lead_list_table.query(
                        KeyConditionExpression='taskId = :taskId',
                        ExpressionAttributeValues={
                            ':taskId': self.current_task_id
                        },
                        Limit=limit
                    )
                    items = response.get('Items', [])
                    
                    if not items:
                        logger.warning(f"No lead list records found for task {self.current_task_id}")
                        return ActionResult(error="No lead list records found")
                    
                    identifiers = [item['identifier'] for item in items]
                    
                    return ActionResult(
                        extracted_content=json.dumps({
                            'message': f"Found {len(identifiers)} lead list identifiers",
                            'identifier_name': self.lead_list_identifier,
                            'identifiers': identifiers
                        }, indent=2)
                    )
                except Exception as e:
                    logger.error(f"Failed to retrieve lead list identifiers: {str(e)}", exc_info=True)
                    return ActionResult(error=f"Failed to retrieve lead list identifiers: {str(e)}")

            # Helper function to process lead list updates
            async def _process_lead_list_update(records: list) -> ActionResult:
                """Process lead list updates for both JSON and non-JSON inputs"""
                try:
                    if not self.lead_list_identifier:
                        return ActionResult(error="Lead list identifier is not configured for this task")
                    
                    # Get the lead list table
                    lead_list_table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskLeadList')

                    # Track new and merged records
                    added_records = []
                    merged_records = []
                    identical_records = []

                    # Validate that each record is a dictionary
                    for record in records:
                        if not isinstance(record, dict):
                            return ActionResult(error=f"Each record must be a dictionary, got {type(record).__name__}")
                        
                        if self.lead_list_identifier not in record:
                            return ActionResult(error=f"Record is missing required identifier field '{self.lead_list_identifier}'")
                        
                        # Check if record with this identifier value exists
                        response = lead_list_table.query(
                            KeyConditionExpression='taskId = :taskId AND identifier = :identifier',
                            ExpressionAttributeValues={
                                ':taskId': self.current_task_id,
                                ':identifier': record.get(self.lead_list_identifier)
                            }
                        )
                        
                        if response.get('Items'):
                            # Get existing record data
                            existing_record = response['Items'][0]
                            existing_data = existing_record.get('data', {})
                            
                            # Check if data is different
                            if existing_data != record:
                                # Merge old and new data, with new data taking precedence
                                merged_data = {**existing_data, **record}
                                
                                # Update the record with merged data
                                lead_list_table.update_item(
                                    Key={
                                        'taskId': self.current_task_id,
                                        'identifier': record.get(self.lead_list_identifier)
                                    },
                                    UpdateExpression='SET #data = :data, updatedAt = :updatedAt',
                                    ExpressionAttributeNames={
                                        '#data': 'data'
                                    },
                                    ExpressionAttributeValues={
                                        ':data': merged_data,
                                        ':updatedAt': datetime.now(timezone.utc).isoformat()
                                    }
                                )
                                merged_records.append(merged_data)
                            else:
                                # Data is identical, track it
                                identical_records.append({
                                    'identifier': record.get(self.lead_list_identifier),
                                    'data': record
                                })
                        else:
                            # Add new record
                            new_record = {
                                'taskId': self.current_task_id,
                                'identifier': record.get(self.lead_list_identifier),
                                'data': record,
                                'createdAt': datetime.now(timezone.utc).isoformat(),
                                'updatedAt': datetime.now(timezone.utc).isoformat()
                            }
                            lead_list_table.put_item(Item=new_record)
                            added_records.append(record)
                    
                    # Build response message
                    response_parts = []
                    if added_records:
                        response_parts.append(f"Successfully added {len(added_records)} new records to the lead list.")
                    if merged_records:
                        response_parts.append(f"Found {len(merged_records)} records with the same identifier and merged them.")
                    if identical_records:
                        response_parts.append(f"{len(identical_records)} records that were identical to existing records and were not added.")
                    
                    return ActionResult(
                        extracted_content="\n".join(response_parts)
                    )
                    
                except Exception as e:
                    logger.error(f"Error appending to lead list: {str(e)}")
                    return ActionResult(error=f"Failed to append to lead list: {str(e)}")

            if "gemini" in self.llm_name.lower():
                @self.controller.registry.action('Update records in lead list using JSON string. For new records, they will be appended. For existing records with the same identifier, they will be merged with existing data.')
                async def update_lead_list_json(records_json: str) -> ActionResult:
                    """Update records in the lead list using a JSON string. For new records, they will be appended. For existing records with the same identifier, they will be merged with existing data.
                    
                    Parameters:
                    - records_json: JSON string containing an array of records to update
                    
                    Returns:
                    - ActionResult with summary of added, updated records.
                    """
                    try:
                        records = json.loads(records_json)
                        if not isinstance(records, list):
                            return ActionResult(error="Input must be a JSON array of records")
                        return await _process_lead_list_update(records)
                    except json.JSONDecodeError as e:
                        return ActionResult(error=f"Invalid JSON format: {str(e)}")
            else:
                @self.controller.registry.action('Update records in lead list. For new records, they will be appended. For existing records with the same identifier, they will be merged with existing data.', param_model=UpdateLeadListParams)
                async def update_lead_list(params: UpdateLeadListParams) -> ActionResult:
                    """Update records in the lead list. For new records, they will be appended. For existing records with the same identifier, they will be merged with existing data.
                    
                    Parameters:
                    - params: UpdateLeadListParams containing the list of records to update
                    
                    Returns:
                    - ActionResult with summary of added, updated records.
                    """
                    return await _process_lead_list_update(params.records)
            
    def _get_cookies_path(self):
        """Get the path to the user's cookies file"""
        if not self.user_id:
            return None
        if self.use_shared_browser:
            return str(self.context_dir / f"shared_cookies.json")
        else:
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
            effective_user_id_for_download = "SHARED_USER_ID" if self.use_shared_browser else self.user_id
            if not effective_user_id_for_download: # Should only happen if self.user_id is None and not shared_browser
                 logger.warning("Cannot download cookies: user_id is None and not in shared browser mode.")
            else:
                self.cookie_sync.download_cookies(effective_user_id_for_download, cookies_path)
            
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
        
        # If turn_off_headless is set, force headless to false
        if self.turn_off_headless:
            logger.info("Turn Off Headless is enabled. Setting headless=false.")
            headless = False
            
        # If run_user_id is set, force headless to false to allow admin interaction
        if self.run_user_id:
            logger.info(f"Task run by user {self.run_user_id} who is not the owner. Setting headless=false to allow admin interaction.")
            headless = False
            
        browser_config = BrowserConfig(new_context_config=context_config, headless=headless)
        self.browser = Browser(config=browser_config)
        
        # Get all credentials for log filtering
        if self.user_id:
            try:
                # Get all configurations for the user
                all_configs = get_all_configs(self.user_id, use_shared_browser=self.use_shared_browser)
                
                for config in all_configs:
                    try:
                        # Get the encrypted password from either encryptedPassword or legacy password field
                        encrypted_password = config.get('encryptedPassword') or config.get('password')
                        if not encrypted_password:
                            logger.warning(f"No password found for {config.get('configId')}")
                            continue
                            
                        decrypted_password = decrypt_password(encrypted_password, self.user_id, config.get('sharedBy'))
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

        agent_kwargs = {
            "task": self.task,
            "llm": self.llm,
            "controller": self.controller,
            "browser": self.browser,
            "use_vision": global_use_vision,
            "max_failures": 5,
            "retry_delay": 60,
            "generate_gif": self.generate_gif,
            "validate_output": validate_output
        }

        # Conditionally add tool_calling_method for Azure OpenAI LLMs
        # self.llm_name is available from __init__ (e.g., "azure->openai->gpt-4o")
        if self.llm_name and "azure->openai" in self.llm_name.lower() and global_tool_calling_method_for_azure:
            agent_kwargs["tool_calling_method"] = global_tool_calling_method_for_azure
            logger.info(f"Using tool_calling_method '{global_tool_calling_method_for_azure}' for Azure OpenAI LLM.")
        
        self.agent = Agent(**agent_kwargs)
        logger.info("Agent initialized successfully.")

    async def cleanup(self):
        """Clean up browser resources and sync cookies"""
        try:
            if self.browser:
                # Save cookies before closing
                cookies_path = self._get_cookies_path()
                if cookies_path:
                    if self.cookie_sync:
                        # Upload cookies
                        effective_user_id_for_upload = "SHARED_USER_ID" if self.use_shared_browser else self.user_id
                        if not effective_user_id_for_upload:
                            logger.warning("Cannot upload cookies: user_id is None and not in shared browser mode.")
                        else:
                            self.cookie_sync.upload_cookies(effective_user_id_for_upload, cookies_path)
                        logger.info("Cookies uploaded to S3")
                    Path(cookies_path).unlink(missing_ok=True)
                    logger.info(f"Deleted cookie file at local: {cookies_path}")
                
                await self.browser.close()
            
            # Clean up logging handlers (which also stops the log filter thread)
            self.cleanup_logging()

            # No need to filter and save browser-use log anymore, as it's now done in real-time
            # But we should clean up the original unfiltered log file
            browser_use_log = f'logs/execution_{self.current_execution_id}_browser_use.log'
            if Path(browser_use_log).exists():
                try:
                    # Remove the original unfiltered log file
                    Path(browser_use_log).unlink()
                    logger.info(f"Removed original unfiltered log file: {browser_use_log}")
                except Exception as e:
                    logger.error(f"Error removing original log file: {e}")
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")
            raise

    def get_action_history(self):
        """Get the list of actions performed by the agent"""
        if not self.agent:
            return []
        return self.agent.action_history

async def main():
    parser = argparse.ArgumentParser(description='Run the web agent.')
    parser.add_argument('--user_id', required=True, help='User ID for this execution')
    parser.add_argument('--llm_name', required=True, help='Full LLM name (e.g., azure->openai->gpt-4o)')
    parser.add_argument('--execution_id', required=True, help='Execution ID for logging and context')
    parser.add_argument('--task_id', required=True, help='Task ID for context and tracking')
    parser.add_argument('--prompt_file', required=True, help='Path to the file containing the prompt')
    parser.add_argument('--gif_path', help='Path to save the execution GIF')
    parser.add_argument('--interactive', action='store_true', help='Enable interactive mode')
    parser.add_argument('--run_user_id', help='User ID of the user who initiated the run, if different from task owner')
    parser.add_argument('--is_complex_task', action='store_true', help='Flag for complex tasks allowing more steps')
    parser.add_argument('--extract-page-content', action='store_true', help='Enable extraction of page content as JSON')
    parser.add_argument('--validate-output', action='store_true', help='Enable validation of agent output')
    parser.add_argument('--output-as-json', action='store_true', help='Output result as JSON')
    parser.add_argument('--agentic-dev-mode', action='store_true', help='Enable agentic dev mode features')
    parser.add_argument('--output-as-html', action='store_true', help='Output result as HTML5')
    parser.add_argument('--use-shared-browser', action='store_true', help='Use shared browser')
    parser.add_argument('--turn-off-headless', action='store_true', help='Turn off headless mode')
    parser.add_argument('--use-knowledge-base', action='store_true', help='Use knowledge base for task execution')
    parser.add_argument('--update-knowledge-base', action='store_true', help='Update knowledge base during task execution')
    parser.add_argument('--update-lead-list', action='store_true', help='Enable lead list updates during task execution')
    parser.add_argument('--lead-list-identifier', help='Identifier field name for lead list records')
    args = parser.parse_args()

    # Read prompt from file
    try:
        with open(args.prompt_file, 'r') as f:
            prompt_content = f.read()
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
            prompt_content,
            execution_id=args.execution_id,
            is_interactive=args.interactive,
            task_id=args.task_id,
            generate_gif=args.gif_path,
            is_complex_task=args.is_complex_task,
            extract_page_content=args.extract_page_content,
            validate_output=args.validate_output,
            output_as_json=args.output_as_json,
            is_agentic_dev_mode=args.agentic_dev_mode,
            output_as_html=args.output_as_html,
            use_shared_browser=args.use_shared_browser,
            turn_off_headless=args.turn_off_headless,
            use_knowledge_base=args.use_knowledge_base,
            update_knowledge_base=args.update_knowledge_base,
            update_lead_list=args.update_lead_list,
            lead_list_identifier=args.lead_list_identifier
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