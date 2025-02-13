#!/usr/bin/env python3
import argparse
import json
import sys
import os
from typing import Dict, Any, Optional
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

def get_aws_bedrock_llm(model_name: str):
    """Initialize AWS Bedrock language model"""
    try:
        # Get Bedrock client with no retries
        bedrock = get_bedrock_client()

        return ChatBedrock(
            client=bedrock,
            model_id=model_name,
            model_kwargs={"temperature": 0.0}
        )
    except Exception as e:
        if "AccessDeniedException" in str(e):
            logger.error("Error: The AWS user lacks permission to invoke Claude model in Bedrock.")
            logger.error("Please ensure the user has the necessary permissions and the model exists.")
            sys.exit(1)
        raise

def get_azure_openai_llm(model_name: str):
    """Initialize Azure OpenAI language model"""
    try:
        deployment_name = os.getenv('AZURE_OPENAI_DEPLOYMENT', 'agentweb')
        
        return AzureChatOpenAI(
            model_name=model_name,
            azure_endpoint=os.getenv('AZURE_OPENAI_ENDPOINT'),
            azure_deployment=deployment_name,
            api_key=os.getenv('AZURE_OPENAI_API_KEY'),
            api_version=os.getenv('AZURE_OPENAI_API_VERSION', '2024-08-01-preview'),
            temperature=0.0
        )
    except Exception as e:
        logger.error(f"Error initializing Azure OpenAI: {e}")
        logger.error("Please ensure all Azure OpenAI environment variables are set correctly.")
        sys.exit(1)

def get_deepseek_llm(model_name: str):
    """Initialize DeepSeek language model"""
    try:
        api_key = os.getenv('DEEPSEEK_API_KEY')
        if not api_key:
            raise ValueError('DEEPSEEK_API_KEY is not set')
            
        return ChatOpenAI(
            base_url='https://api.deepseek.com/v1',
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
    except Exception as e:
        logger.error(f"Error initializing DeepSeek: {e}")
        logger.error("Please ensure DEEPSEEK_API_KEY environment variable is set correctly.")
        sys.exit(1)

def get_openai_llm(model_name: str):
    """Initialize OpenAI language model"""
    try:
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            raise ValueError('OPENAI_API_KEY is not set')
            
        return ChatOpenAI(
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
    except Exception as e:
        logger.error(f"Error initializing OpenAI: {e}")
        logger.error("Please ensure OPENAI_API_KEY environment variable is set correctly.")
        sys.exit(1)

def get_openai_llm_think(model_name: str):
    """Initialize OpenAI language model"""
    global global_use_vision
    try:
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            raise ValueError('OPENAI_API_KEY is not set')
            
        # For think model such as o3-mini, we disable vision: https://github.com/browser-use/browser-use/issues/283
        global_use_vision = False
        logger.warning(f"Vision is disabled for {model_name}. Execution details in gif will not be available.")
        return ChatOpenAI(
            model=model_name,
            api_key=SecretStr(api_key),
            disabled_params={"parallel_tool_calls": None}
        )
    except Exception as e:
        logger.error(f"Error initializing OpenAI: {e}")
        logger.error("Please ensure OPENAI_API_KEY environment variable is set correctly.")
        sys.exit(1)

def get_llm(full_llm_name: str):
    """Get the appropriate language model based on provided configuration"""
    # Define valid platform-provider-model combinations with their initialization functions
    VALID_CONFIGURATIONS = {
        "aws": {
            "anthropic": {
                "anthropic.claude-3-5-sonnet-20241022-v2:0": get_aws_bedrock_llm
            }
        },
        "azure": {
            "openai": {
                "gpt-4o": get_azure_openai_llm
            }
        },
        "deepseek": {
            "deepseek": {
                "deepseek-reasoner": get_deepseek_llm
            }
        },
        "openai": {
            "openai": {
                "gpt-4o": get_openai_llm,
                "o3-mini": get_openai_llm_think
            }
        }
    }

    try:
        platform, provider, model_name = full_llm_name.lower().split('->')
    except ValueError:
        logger.error(f"Invalid FULL_LLM_NAME format: {full_llm_name}")
        logger.error("Format should be <platform>-><provider>-><model>")
        sys.exit(1)
    
    logger.info(f"Initializing LLM - Platform: {platform}, Provider: {provider}, Model: {model_name}")

    # Get the provider mapping for the platform
    platform_config = VALID_CONFIGURATIONS.get(platform)
    if not platform_config:
        logger.error(f"Unsupported platform: {platform}")
        logger.error(f"Valid platforms are: {list(VALID_CONFIGURATIONS.keys())}")
        sys.exit(1)

    # Get the model mapping for the provider
    provider_config = platform_config.get(provider)
    if not provider_config:
        logger.error(f"Invalid provider '{provider}' for platform '{platform}'")
        logger.error(f"Valid providers for {platform} are: {list(platform_config.keys())}")
        sys.exit(1)

    # Get the initialization function for the model
    init_func = provider_config.get(model_name)
    if not init_func:
        logger.error(f"Invalid model '{model_name}' for provider '{provider}' on platform '{platform}'")
        logger.error(f"Valid models are: {list(provider_config.keys())}")
        sys.exit(1)

    # Initialize the LLM using the mapped function
    return init_func(model_name), full_llm_name

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

    async def execute_task(self, prompt: str, execution_id: str = None, is_interactive: bool = False, task_id: str = None, generate_gif: str = None) -> Dict[str, Any]:
        """Execute a task based on the natural language prompt"""
        log_file = None
        try:
            self.is_interactive = is_interactive  # Set interactive mode
            self.current_execution_id = execution_id  # Store execution ID
            self.current_task_id = task_id  # Store task ID
            self.generate_gif = generate_gif  # Store GIF path
            
            # Setup logging for this execution
            if execution_id:
                log_file = self.setup_execution_logging(execution_id)
                logger.info(f"Logging setup complete. Logs will be written to {log_file}")
            
            # Register actions after setting is_interactive
            self._register_actions()
            
            # Add interactive mode context to the prompt if enabled
            if self.is_interactive:
                prompt = f"{prompt}\n\nNote: This task is running in interactive mode. You can ask the user questions using the 'Ask user for input' action when you need additional information."
            
            self.task = prompt  # Store the task after prompt is potentially modified
            
            await self.setup()  # Setup after we have the task
            
            # Run the agent
            result = await self.agent.run(max_steps=25)
            
            task_is_done = False  # Initialize task_is_done
            agent_message = None
            if result.is_done():
                task_is_done = True
                agent_message = result.history[-1].result[-1].extracted_content

            if agent_message is None:
                agent_message = 'Oops! Something went wrong while running AgentWeb.'
            
            # If task completed successfully, check for downloaded files
            result_files = []
            if task_is_done and self.current_execution_id:
                downloads_path = Path(self._get_downloads_path())
                if downloads_path.exists():
                    # Generate a random token for this batch of files
                    random_token = ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=20))
                    
                    for file_path in downloads_path.glob('*'):
                        if file_path.is_file():
                            try:
                                # Upload file to S3 with random token in path
                                s3_key = f"task_results/{self.current_execution_id}/{random_token}/{file_path.name}"
                                self.s3_client.upload_file(
                                    str(file_path),
                                    self.s3_bucket,
                                    s3_key,
                                    ExtraArgs={'ContentDisposition': f'attachment; filename="{file_path.name}"'}
                                )
                                # Generate URL with proper encoding
                                encoded_key = quote(s3_key)
                                url = f"https://{self.s3_bucket}.s3.amazonaws.com/{encoded_key}"
                                result_files.append({
                                    'url': url,
                                    'filename': file_path.name,
                                    'token': random_token  # Store token for potential future validation
                                })
                                logger.info(f"Uploaded result file to S3: {url}")
                            except Exception as e:
                                logger.error(f"Error uploading file {file_path} to S3: {e}")

                # Update execution record with result files if any were uploaded
                if result_files:
                    try:
                        table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskExecutions')
                        table.update_item(
                            Key={'executionId': self.current_execution_id},
                            UpdateExpression='SET result_files = :files',
                            ExpressionAttributeValues={
                                ':files': result_files
                            }
                        )
                        logger.info(f"Updated execution record with {len(result_files)} result files")
                    except Exception as e:
                        logger.error(f"Error updating execution record with result files: {e}")
            
            return {
                "success": task_is_done,
                "summary" if task_is_done else "error": agent_message,
                "llmName": self.llm_name,
                "result_files": result_files if result_files else None
            }
        except Exception as e:
            logger.error(f"Error in execute_task: {e}")
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
        """Get the path to the downloads directory for the current execution"""
        if not self.current_execution_id:
            # Fallback to user directory if no execution ID
            base_path = Path('downloads') / (self.user_id or 'default')
        else:
            # Create execution-specific directory
            base_path = Path('downloads') / (self.user_id or 'default') / self.current_execution_id
        
        base_path.mkdir(parents=True, exist_ok=True)
        return str(base_path)

    async def setup(self):
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
        browser_config = BrowserConfig(new_context_config=context_config, headless=headless)
        self.browser = Browser(config=browser_config)

        # Get credentials from AW-Configs
        sensitive_data = {}
        if self.user_id:
            try:
                table = dynamodb.Table(f'{TABLE_PREFIX}AW-Configs')
                response = table.scan(
                    FilterExpression='userId = :userId',
                    ExpressionAttributeValues={':userId': self.user_id}
                )
                for config in response.get('Items', []):
                    try:
                        decrypted_password = decrypt_password(config['password'], self.user_id, config.get('sharedBy'))
                        domain = config['website']
                        sensitive_data[f"{domain}_username"] = config['username']
                        sensitive_data[f"{domain}_password"] = decrypted_password
                    except Exception as e:
                        logger.error(f"Error decrypting password for {config.get('website')}: {e}")
            except Exception as e:
                logger.error(f"Error fetching credentials from AW-Configs: {e}")
        logger.info(f"Sensitive data: {sensitive_data.keys()}")

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
            sensitive_data=sensitive_data,  # Pass all decrypted credentials
            generate_gif=self.generate_gif  # Pass GIF path from task_monitor
        )

    async def cleanup(self):
        """Clean up browser resources and sync cookies"""
        try:
            if self.browser:
                # Save cookies before closing
                cookies_path = self._get_cookies_path()
                if cookies_path and self.cookie_sync:
                    # Upload cookies to S3 after task completion
                    self.cookie_sync.upload_cookies(self.user_id, cookies_path)
                
                await self.browser.close()
            # Clean up logging handlers
            self.cleanup_logging()
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
    try:
        result = await agent.execute_task(
            prompt,
            execution_id=args.execution_id,
            is_interactive=args.interactive,
            task_id=args.task_id,
            generate_gif=args.gif_path
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