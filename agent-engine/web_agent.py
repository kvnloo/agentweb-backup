#!/usr/bin/env python3
import argparse
import json
import sys
import os
import re
import uuid
import threading
import base64
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
import secrets_manager
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
from task_utils import get_downloads_path, upload_task_result_files, get_llm, validate_content_format, extract_json_from_content, generate_content_hash, get_agent_code_base_path, call_github_api, run_python_code_in_sandbox, fetch_api_credentials, decrypt_password, get_all_configs, parse_json, convert_svg_to_png
from knowledge_base_utils import get_knowledge_base_manager
from datetime import datetime, timezone
import PyPDF2
import docx
import openpyxl
from bs4 import BeautifulSoup
import yaml
import xml.etree.ElementTree as ET
import json
import csv
import io
import requests
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

class DataAnalysisParams(BaseModel):
    """Parameters for performing data analysis."""
    file_names: List[str]
    analysis_task: str
    include_lead_list: bool = False

class GenerateImageParams(BaseModel):
    """Parameters for generating images with input images."""
    input_file_names: List[str]
    prompt: str
    output_file_name: str
    size: str = "1024x1024"
    quality: str = "medium"

class VideoAnalysisParams(BaseModel):
    """Parameters for performing video analysis."""
    video_url: str
    prompt: str

class GenerateVideoParams(BaseModel):
    """Parameters for generating videos using Google VEO API."""
    prompt: str
    output_file_name: str
    image_file_name: Optional[str] = None  # Optional input image for image-to-video generation
    negative_prompt: Optional[str] = None  # Optional negative prompt to avoid certain elements

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
        # Shadow usage metering (Ship 1) — fail-open, never affects the task.
        self.usage_reporter = None
        try:
            from usage_reporter import UsageReporter, attach_usage_callback
            self.usage_reporter = UsageReporter(self.llm_name)
            attach_usage_callback(self.llm, self.usage_reporter)
        except Exception as usage_err:
            logger.warning(f"Usage metering disabled for this run: {usage_err}")
            self.usage_reporter = None
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
        self.has_attachments = False  # Initialize has_attachments property
        self.code_execution = False  # Initialize code_execution property
        self.image_model = None  # Initialize image_model property

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

    async def execute_task(self, prompt: str, execution_id: str = None, is_interactive: bool = False, task_id: str = None, generate_gif: str = None, is_complex_task: bool = False, extract_page_content: bool = False, validate_output: bool = False, output_as_json: bool = False, is_agentic_dev_mode: bool = False, output_as_html: bool = False, use_shared_browser: bool = False, turn_off_headless: bool = False, use_knowledge_base: bool = False, update_knowledge_base: bool = False, update_lead_list: bool = False, lead_list_identifier: str = None, has_attachments: bool = False, create_video: bool = False, video_model: str = None, image_model: str = None) -> Dict[str, Any]:
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
            self.has_attachments = has_attachments
            self.create_video = create_video
            self.video_model = video_model
            self.image_model = image_model
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
                prompt = f"{prompt}\n\nRequirement: The final output for this task MUST be in well-formatted HTML5 with modern styling. You MUST use the 'Write file' action to save this HTML content into a file with an .html extension. The HTML output should include:\n1. A clean, modern layout with proper spacing and typography\n2. Visual elements like tables, charts or diagrams to represent data (using Chart.js)\n3. DO NOT use bar chart if data range is large as it will be hard to read.\n4. Clear section headers and organized content structure\n5. CSS styling for visual appeal\n6. Proper citations and references for any external sources or data"

            # Add knowledge base instruction if enabled
            if self.use_knowledge_base:
                prompt = f"{prompt}\n\nImportant: Before browsing the web, you MUST first search the knowledge base using the search_knowledge_base action to find relevant information. Only proceed with web browsing if the knowledge base search doesn't provide sufficient information."

            # Add lead list instruction if enabled
            if self.update_lead_list:
                prompt = f"{prompt}\n\nImportant: For this task, you MUST use the {'update_lead_list_json' if 'gemini' in self.llm_name.lower() else 'update_lead_list'} action to store your findings instead of reporting them in the final result. Each record should contain the identifier field {self.lead_list_identifier}. The action will handle both adding new records and updating existing ones. You can use the get_lead_list_identifiers action to get the list of existing identifiers."

            # Add video generation instruction if enabled
            if self.create_video:
                prompt = f"{prompt}\n\nImportant: This task has video generation capabilities enabled. You can use the 'Generate short video' action to create videos based on text prompts. This is useful for creating promotional videos, tutorials, or any other video content needed for the task."

            # Add GPT-5 consultation instruction if using GPT-5 model
            if "gpt-5" in self.llm_name.lower():
                prompt = f"{prompt}\n\nImportant: You are using GPT-5, the most advanced AI model. For complex reasoning, strategic analysis, or when you need the most sophisticated AI capabilities, use the consult_agi action. This allows you to leverage GPT-5's full potential for deep thinking and problem-solving. When using consult_agi, make sure to include ALL relevant context in your question as GPT-5 cannot access external information or previous conversation history."

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

    def _get_attachment_dir(self) -> Optional[Path]:
        """Get the attachment directory for the current task"""
        if not self.current_task_id:
            logger.error("No task ID available")
            return None
        
        task_dir = self.attachments_dir / self.current_task_id
        task_dir.mkdir(exist_ok=True)
        return task_dir

    async def _get_attachment_path(self, file_name: str) -> Optional[str]:
        """Get the local path for an attachment, downloading it from S3 if needed, or return if it exists locally."""
        try:
            if not self.current_task_id:
                logger.error("No task ID available")
                return None

            # Get task details from DynamoDB
            tasks_table = dynamodb.Table(f'{TABLE_PREFIX}AW-Tasks')
            task = tasks_table.get_item(Key={'taskId': self.current_task_id}).get('Item')
            attachment = None
            if task and 'attachments' in task:
                # Find the attachment with matching filename
                attachment = next((a for a in task['attachments'] if a['filename'] == file_name), None)

            # Use the helper method to get the task directory
            task_dir = self._get_attachment_dir()
            if not task_dir:
                return None
            local_path = task_dir / file_name

            if attachment:
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
            else:
                # Not in metadata, but check if file exists locally (e.g., from download_image)
                if local_path.exists():
                    logger.info(f"Found {file_name} in local attachments directory.")
                    return str(local_path)
                logger.error(f"No attachment found with filename: {file_name}")
                return None
        except Exception as e:
            logger.error(f"Error getting attachment path: {e}")
            return None

    def _register_actions(self):
        @self.controller.registry.action('search_web, an alternative to search_google')
        def search_web(query: str, max_results: int = 5) -> ActionResult:
            """Search the web using Google Custom Search API.
            
            Parameters:
            - query: The search query string
            - max_results: Maximum number of results to return (default 5, max 10)
            
            Environment variables required:
            - GOOGLE_SEARCH_API_KEY
            - GOOGLE_SEARCH_ENGINE_ID
            """
            try:
                if not query or not isinstance(query, str):
                    return ActionResult(error="Please provide a non-empty search query")

                api_key = os.getenv('GOOGLE_SEARCH_API_KEY')
                search_engine_id = os.getenv('GOOGLE_SEARCH_ENGINE_ID')

                if not api_key or not search_engine_id:
                    return ActionResult(error="Google Search API not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID in .env")

                limit = max(1, min(int(max_results) if isinstance(max_results, int) else 5, 10))

                params = {
                    'key': api_key,
                    'cx': search_engine_id,
                    'q': query,
                    'num': limit,
                    'safe': 'medium',
                    'fields': 'items(title,link,snippet,pagemap/metatags,pagemap/cse_thumbnail)'
                }

                resp = requests.get('https://www.googleapis.com/customsearch/v1', params=params, timeout=20)
                if resp.status_code != 200:
                    try:
                        data = resp.json()
                        message = data.get('error', {}).get('message') or data.get('message') or 'Unknown error'
                    except Exception:
                        message = resp.text
                    return ActionResult(error=f"Google Search API error ({resp.status_code}): {message}")

                data = resp.json()
                items = data.get('items', []) or []
                if not items:
                    return ActionResult(extracted_content=f"No search results found for: {query}")

                results = []
                for item in items:
                    metatags = None
                    try:
                        metatags = (item.get('pagemap', {}) or {}).get('metatags', [{}])[0]
                    except Exception:
                        metatags = None
                    published = None
                    if isinstance(metatags, dict):
                        # Try a few common date meta keys
                        for key in ['article:published_time', 'og:updated_time', 'date', 'dc.date', 'pubdate', 'last-modified']:
                            if metatags.get(key):
                                published = metatags.get(key)
                                break

                    thumb = None
                    try:
                        thumbs = (item.get('pagemap', {}) or {}).get('cse_thumbnail', [])
                        if thumbs and isinstance(thumbs, list):
                            thumb = thumbs[0].get('src')
                    except Exception:
                        thumb = None

                    results.append({
                        'title': item.get('title') or 'No title',
                        'url': item.get('link') or '#',
                        'snippet': item.get('snippet') or 'No description available',
                        'publishedDate': published or datetime.now(timezone.utc).isoformat(),
                        'thumbnail': thumb
                    })

                # Provide a concise, readable summary for the agent
                lines = [f"Web search results for: {query}"]
                for idx, r in enumerate(results, start=1):
                    lines.append(f"{idx}. {r['title']}\n   {r['url']}\n   {r['snippet']}")

                # Also include a JSON payload at the end to allow structured parsing
                lines.append("\nJSON Results:")
                lines.append(json.dumps({'results': results}, ensure_ascii=False))

                return ActionResult(extracted_content='\n'.join(lines))
            except Exception as e:
                return ActionResult(error=f"Failed to perform web search: {str(e)}")

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
                
        @self.controller.registry.action('Run integration test with API credentials, load the API credentials from environment variables with names like GITHUB_API_CREDENTIAL, STRIPE_API_CREDENTIAL, etc. Do not use it for general purpose code execution.', param_model=IntegrationTestParams)
        def run_integration_test(params: IntegrationTestParams) -> ActionResult:
            """Run Python code with API credentials loaded from environment variables.
            
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
                
                return ActionResult(error="Deprecated: execution of arbitrary code has been disabled.")

            except Exception as e:
                logger.error(f"Error during API integration setup: {str(e)}")
                return ActionResult(error=f"Error running integration: {str(e)}")
        if "gpt-5" in self.llm_name.lower():
            @self.controller.registry.action('Consult AGI (GPT-5) for advanced reasoning and analysis')
            def consult_agi(question_with_full_context: str) -> ActionResult:
                """Consult GPT-5 for advanced reasoning and analysis. Use this when you need the most advanced AI capabilities for complex problem solving, strategic thinking, or deep analysis. IMPORTANT: Provide ALL relevant context in your question as GPT-5 cannot access external context or previous conversation history."""
                try:
                    # Import OpenAI client
                    try:
                        from openai import OpenAI
                    except ImportError:
                        return ActionResult(error="OpenAI package not installed. Install with: pip install openai")

                    # Get API key
                    api_key = secrets_manager.get_openai_api_key()
                    if not api_key:
                        return ActionResult(error="OPENAI_API_KEY environment variable is not set")

                    # Initialize the client
                    client = OpenAI(api_key=api_key)
                    
                    logger.info(f"Consulting GPT-5 with question: {question_with_full_context}")
                    
                    # Call GPT-5 without temperature parameter (uses default)
                    response = client.chat.completions.create(
                        model="gpt-5",
                        messages=[
                            {"role": "system", "content": "You are an advanced AI assistant. Provide thoughtful, comprehensive analysis and strategic insights."},
                            {"role": "user", "content": question_with_full_context}
                        ]
                    )
                    
                    result = response.choices[0].message.content
                    logger.info("GPT-5 consultation completed successfully")
                    
                    return ActionResult(extracted_content=result)
                    
                except Exception as e:
                    logger.error(f"Error consulting GPT-5: {str(e)}")
                    return ActionResult(error=f"Failed to consult GPT-5: {str(e)}")

        @self.controller.registry.action('Get brand guidelines')
        def get_brand_guidelines() -> ActionResult:
            """Get brand guidelines and assets for the current user.
            
            Returns comprehensive brand information including:
            - Brand name, tagline, and values
            - Colors (primary, secondary)
            - Typography (font family)
            - Tone of voice and messaging
            - Target audience and brand personality
            - Links to brand assets (logos, style guides)
            
            This information should be used to ensure all marketing materials,
            content, and communications align with the brand identity.
            """
            if not self.user_id:
                return ActionResult(error="User ID not provided")
            
            logger.info(f"Getting brand guidelines for user {self.user_id}")
            
            try:
                # Get brand guidelines from user record
                table = dynamodb.Table(f'{TABLE_PREFIX}AW-Users')
                response = table.query(
                    IndexName='UserIdIndex',
                    KeyConditionExpression='userId = :userId',
                    ExpressionAttributeValues={
                        ':userId': self.user_id
                    }
                )
                
                users = response.get('Items', [])
                if not users:
                    return ActionResult(error="User not found.")
                
                user = users[0]
                brand_guidelines = user.get('brandGuidelines')
                
                if not brand_guidelines:
                    return ActionResult(error="No brand guidelines found for this account. Please set up brand guidelines in your account settings first.")
                
                brand_data = brand_guidelines.get('brandData', {})
                attachments = brand_guidelines.get('attachments', [])
                
                # Format brand information for the agent
                brand_info = []
                brand_info.append("=== BRAND GUIDELINES ===")
                
                if brand_data.get('brandName'):
                    brand_info.append(f"Brand Name: {brand_data['brandName']}")
                
                if brand_data.get('tagline'):
                    brand_info.append(f"Tagline: {brand_data['tagline']}")
                
                # Colors
                if brand_data.get('primaryColor') or brand_data.get('secondaryColor'):
                    brand_info.append("\n--- COLORS ---")
                    if brand_data.get('primaryColor'):
                        is_gradient = brand_data.get('isGradient', False)
                        if is_gradient and brand_data.get('primaryColorEnd'):
                            brand_info.append(f"Primary Color: Gradient from {brand_data['primaryColor']} to {brand_data['primaryColorEnd']}")
                        else:
                            brand_info.append(f"Primary Color: {brand_data['primaryColor']}")
                    if brand_data.get('secondaryColor'):
                        brand_info.append(f"Secondary Color: {brand_data['secondaryColor']}")
                
                # Typography
                if brand_data.get('fontFamily'):
                    brand_info.append(f"\n--- TYPOGRAPHY ---")
                    brand_info.append(f"Font Family: {brand_data['fontFamily']}")
                
                # Voice and messaging
                if brand_data.get('toneOfVoice'):
                    brand_info.append(f"\n--- TONE OF VOICE ---")
                    brand_info.append(f"Tone: {brand_data['toneOfVoice']}")
                
                if brand_data.get('keyMessages') and len(brand_data['keyMessages']) > 0:
                    brand_info.append(f"\n--- KEY MESSAGES ---")
                    for i, message in enumerate(brand_data['keyMessages'], 1):
                        brand_info.append(f"{i}. {message}")
                
                if brand_data.get('brandValues') and len(brand_data['brandValues']) > 0:
                    brand_info.append(f"\n--- BRAND VALUES ---")
                    for i, value in enumerate(brand_data['brandValues'], 1):
                        brand_info.append(f"{i}. {value}")
                
                # Audience and personality
                if brand_data.get('targetAudience'):
                    brand_info.append(f"\n--- TARGET AUDIENCE ---")
                    brand_info.append(brand_data['targetAudience'])
                
                if brand_data.get('brandPersonality'):
                    brand_info.append(f"\n--- BRAND PERSONALITY ---")
                    brand_info.append(brand_data['brandPersonality'])
                
                # Assets
                if attachments:
                    brand_info.append(f"\n--- BRAND ASSETS ---")
                    for attachment in attachments:
                        asset_type = attachment.get('type', 'asset').title()
                        filename = attachment.get('filename', 'Unknown')
                        url = attachment.get('url', '')
                        brand_info.append(f"{asset_type}: {filename} ({url})")
                
                brand_info.append("\n=== END BRAND GUIDELINES ===")
                brand_info.append("\nIMPORTANT: Use these brand guidelines to ensure all content, designs, and communications align with the brand identity.")
                
                return ActionResult(extracted_content="\n".join(brand_info))
                
            except Exception as e:
                logger.error(f"Error retrieving brand guidelines: {str(e)}")
                return ActionResult(error=f"Error getting brand guidelines: {str(e)}")

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

        if self.code_execution:
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

                    return ActionResult(error="Deprecated: execution of arbitrary code has been disabled.")
                    
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
            """Download an image from a URL and save it to the attachments folder."""
            try:
                # Use the helper method to get the attachment directory
                task_dir = self._get_attachment_dir()
                if not task_dir:
                    return ActionResult(error="No attachments folder available for saving the image")
                
                # Use the common download function
                from task_utils import download_file_from_url
                filename, msg = await download_file_from_url(url, task_dir, "image")
                
                return ActionResult(extracted_content=msg)
                
            except Exception as e:
                logger.error(f'Error in download_image: {str(e)}')
                return ActionResult(error=f'Failed to download image: {str(e)}')

        @self.controller.registry.action('Download file when you have the URL')
        async def download_file(url: str, browser: BrowserContext) -> ActionResult:
            """Download a file from a URL and save it to the attachments folder."""
            try:
                # Use the helper method to get the attachment directory
                task_dir = self._get_attachment_dir()
                if not task_dir:
                    return ActionResult(error="No attachments folder available for saving the file")
                
                # Use the common download function
                from task_utils import download_file_from_url
                filename, msg = await download_file_from_url(url, task_dir, "file")
                
                return ActionResult(extracted_content=msg)
                
            except Exception as e:
                logger.error(f'Error in download_file: {str(e)}')
                return ActionResult(error=f'Failed to download file: {str(e)}')

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

        # Add video generation action if create_video is enabled
        if self.create_video:
            @self.controller.registry.action('Generate short video', param_model=GenerateVideoParams)
            async def generate_short_video(params: GenerateVideoParams) -> ActionResult:
                """Generate videos using Google VEO API or Runway AI API.
                
                This action uses the selected video model to generate videos based on text prompts or input images.
                The generated video is saved to the downloads folder.
                
                Supported models:
                - veo-3.0-generate-preview (Google): 8-second videos with audio supported, 16:9 aspect ratio
                - gen4_turbo (Runway AI): 5-second videos without audio, 1280:720 ratio
                - kling-v2.1-std (ReelMind): 5-second image-to-video generation, 16:9 aspect ratio (Kling V1.6 Std used for text-to-video)
                
                Parameters:
                - params: GenerateVideoParams containing:
                  - prompt: Description of the video to generate
                  - output_file_name: Name of the output video file to save in downloads folder (must end with .mp4)
                  - image_file_name: Optional input image file name for image-to-video generation. If provided, the file will be searched in task attachments first, then in downloads folder.
                  - negative_prompt: Optional negative prompt to specify what to avoid in the generated video
                
                Returns:
                - ActionResult with the generation results or error message
                """
                try:
                    # Get the video model to use (default to Google VEO if not specified)
                    video_model = self.video_model or "veo-3.0-generate-preview"
                    logger.info(f"Using video model: {video_model}")
                    
                    # Validate output file extension (must end with .mp4)
                    output_ext = Path(params.output_file_name).suffix.lower()
                    if output_ext != ".mp4":
                        return ActionResult(error=f"Output file extension '{output_ext}' must be '.mp4'. Please rename the file to end with .mp4")
                    
                    # Get downloads path for output
                    downloads_path = self._get_downloads_path()
                    output_path = Path(downloads_path) / params.output_file_name

                    
                    # Handle input image if provided
                    image_path = None
                    if params.image_file_name:
                        # Try to get file path from attachments first, then downloads
                        image_path = await self._get_attachment_path(params.image_file_name)
                        
                        if not image_path:
                            # If not found in attachments, try downloads path
                            image_path = Path(downloads_path) / params.image_file_name
                            
                            if not image_path.exists():
                                return ActionResult(error=f"Input image file {params.image_file_name} not found in task attachments or downloads folder")
                        
                        # Check if file is an image
                        image_ext = Path(params.image_file_name).suffix.lower()
                        if image_ext not in ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg']:
                            return ActionResult(error=f"File {params.image_file_name} is not a supported image format. Supported formats: PNG, JPG, JPEG, GIF, BMP, WEBP, SVG")
                        
                        # Convert SVG to high-quality PNG if needed for video generation
                        if image_ext == '.svg':
                            # Create a high-quality PNG file for the converted SVG in attachment directory
                            png_file_name = Path(params.image_file_name).with_suffix('.png').name
                            attachment_dir = self._get_attachment_dir()
                            if not attachment_dir:
                                return ActionResult(error="Failed to get attachment directory for SVG conversion")
                            png_path = attachment_dir / png_file_name
                            
                            # Use high DPI (300) and 2048px width for better quality
                            if not convert_svg_to_png(str(image_path), str(png_path), dpi=300, width=2048):
                                return ActionResult(error=f"Failed to convert SVG file {params.image_file_name} to high-quality PNG format")
                            
                            # Replace SVG filename with PNG filename in the prompt
                            params.prompt = params.prompt.replace(params.image_file_name, png_file_name)
                            
                            # Use the converted PNG file instead
                            image_path = png_path
                            logger.info(f"Converted SVG {params.image_file_name} to high-quality PNG {png_file_name} in attachment directory for video generation")
                        
                        logger.info(f"Using input image: {params.image_file_name}")
                    
                    logger.info(f"Generating video with prompt: {params.prompt}")
                    
                    # Generate video based on selected model
                    if video_model == "gen4_turbo":
                        # Use Runway AI
                        try:
                            from runwayml import RunwayML
                        except ImportError:
                            return ActionResult(error="Runway ML package not installed. Install with: pip install runwayml")
                        
                        # Get API key
                        api_key = os.getenv('RUNWAY_API_KEY')
                        if not api_key:
                            return ActionResult(error="RUNWAY_API_KEY environment variable is not set")
                        
                        client = RunwayML(api_key=api_key)
                        logger.info("Runway AI: Generating 5-second video without audio")
                        
                        if image_path:
                            # Image-to-video generation
                            logger.info("Generating video from input image using Runway AI")
                            
                            # Encode image to data URI
                            with open(image_path, "rb") as f:
                                base64_image = base64.b64encode(f.read()).decode("utf-8")
                                # Get the image extension to determine MIME type
                                image_ext = Path(params.image_file_name).suffix.lower()
                                mime_map = {
                                    '.png': 'image/png',
                                    '.jpg': 'image/jpeg', 
                                    '.jpeg': 'image/jpeg',
                                    '.gif': 'image/gif',
                                    '.bmp': 'image/bmp',
                                    '.webp': 'image/webp'
                                }
                                mime_type = mime_map.get(image_ext, 'image/png')
                                data_uri = f"data:{mime_type};base64,{base64_image}"
                            
                            try:
                                task = client.image_to_video.create(
                                    model='gen4_turbo',
                                    prompt_image=data_uri,
                                    prompt_text=params.prompt,
                                    ratio='1280:720',
                                    duration=5,
                                ).wait_for_task_output()
                                
                                if task and hasattr(task, 'output') and task.output:
                                    # Download the video
                                    import requests
                                    response = requests.get(task.output[0])
                                    with open(output_path, 'wb') as f:
                                        f.write(response.content)
                                    
                                    logger.info(f"Runway AI video saved to: {output_path}")
                                    return ActionResult(extracted_content=f"✅ Video {params.output_file_name} generated successfully using Runway AI and saved to downloads folder!")
                                else:
                                    return ActionResult(error="No video data received from Runway AI")
                                    
                            except Exception as e:
                                if 'TaskFailedError' in str(type(e)):
                                    return ActionResult(error=f"Runway AI video generation failed: {str(e)}")
                                else:
                                    raise e
                        else:
                            # Text-to-video not supported by Runway AI gen4_turbo
                            return ActionResult(error="Runway AI gen4_turbo only supports image-to-video generation. Please provide an input image.")
                    
                    elif video_model == "kling-v2.1-std":
                        # Use ReelMind API for Kling V2.1 Std
                        import requests
                        import json
                        import time
                        
                        # Get API key
                        api_key = os.getenv('REELMIND_API_KEY')
                        if not api_key:
                            return ActionResult(error="REELMIND_API_KEY environment variable is not set (Do not retry - this is a permanent failure)")
                        
                        # Kling V2.1 Std supports both text-to-video and image-to-video generation
                        # If no image is provided, we'll do text-to-video generation
                        
                        # Determine generation type and prepare request
                        if image_path:
                            logger.info("Kling V2.1 Std: Generating 5-10 second image-to-video")
                            
                            # Upload image to S3 to get a public URL
                            from task_utils import get_s3_client
                            
                            s3_client = get_s3_client()
                            s3_bucket = os.getenv('AWS_S3_BUCKET')
                            
                            if not s3_bucket:
                                return ActionResult(error="AWS_S3_BUCKET environment variable is not set (Do not retry - this is a permanent failure)")
                            
                            # Generate unique S3 key for the image
                            import uuid
                            image_ext = Path(params.image_file_name).suffix.lower()
                            unique_filename = f"kling_input_{uuid.uuid4()}{image_ext}"
                            s3_key = f"video_inputs/{unique_filename}"
                            
                            # Upload image to S3
                            try:
                                # Determine content type
                                mime_map = {
                                    '.png': 'image/png',
                                    '.jpg': 'image/jpeg', 
                                    '.jpeg': 'image/jpeg',
                                    '.gif': 'image/gif',
                                    '.bmp': 'image/bmp',
                                    '.webp': 'image/webp'
                                }
                                content_type = mime_map.get(image_ext, 'image/png')
                                
                                s3_client.upload_file(
                                    image_path,
                                    s3_bucket,
                                    s3_key,
                                    ExtraArgs={'ContentType': content_type}
                                )
                                
                                # Generate public URL
                                image_url = f"https://{s3_bucket}.s3.amazonaws.com/{s3_key}"
                                logger.info(f"Uploaded input image to S3: {image_url}")
                                
                            except Exception as e:
                                return ActionResult(error=f"Failed to upload image to S3: {str(e)} (Do not retry - this is a permanent failure)")
                            
                            # Prepare request data for image-to-video (Kling V2.1 Std)
                            request_data = {
                                "prompt": params.prompt,
                                "model_id": "b36e980e-3e29-4e8f-8082-35408a2b57c7",  # Kling V2.1 Std
                                "duration": "5",  # Default 5 seconds
                                "aspect_ratio": "16:9",  # Default aspect ratio
                                "image_url": image_url
                            }
                        else:
                            logger.info("Kling V1.6 Std: Generating 5-second text-to-video")
                            
                            # Prepare request data for text-to-video (Kling V1.6 Std)
                            request_data = {
                                "prompt": params.prompt,
                                "model_id": "5410929b-78d0-4c1f-ad7c-17913ad3e2b5",  # Kling V1.6 Std for text-to-video
                                "duration": "5",  # Default 5 seconds
                                "aspect_ratio": "16:9"  # Default aspect ratio
                            }
                        
                        try:
                            if params.negative_prompt:
                                request_data["negative_prompt"] = params.negative_prompt
                            else:
                                request_data["negative_prompt"] = "blur, distort, and low quality"
                            
                            request_data["cfg_scale"] = 0.5  # Default CFG scale
                            
                            # Make request to ReelMind API
                            headers = {
                                "Authorization": api_key,
                                "Content-Type": "application/json"
                            }
                            
                            logger.info(f"Sending request to ReelMind API: {request_data}")
                            response = requests.post(
                                "https://nestapi.reelmind.ai/external-api/video/generate",
                                headers=headers,
                                json=request_data,
                                timeout=30
                            )

                            if int(response.status_code) not in [200, 201]:
                                error_msg = f"ReelMind API request failed with status {response.status_code}: {response.text}"
                                logger.error(error_msg)
                                return ActionResult(error=error_msg)
                            
                            task_data = response.json()
                            task_id = task_data.get("data", {}).get("task_id")
                            
                            if not task_id:
                                return ActionResult(error=f"No task_id received from ReelMind API: {task_data} (Do not retry - this is a permanent failure)")
                            
                            logger.info(f"ReelMind task created with ID: {task_id}")
                            
                            # Poll for completion (no webhook as requested)
                            max_attempts = 120  # 10 minutes max (5 second intervals)
                            attempt = 0
                            
                            while attempt < max_attempts:
                                time.sleep(5)  # Wait 5 seconds between polls
                                attempt += 1
                                
                                # Check task status (using task_id from response to get status)
                                # Note: The exact status endpoint may need to be confirmed with ReelMind API docs
                                status_response = requests.get(
                                    f"https://nestapi.reelmind.ai/external-api/video/task/{task_id}",
                                    headers=headers,
                                    timeout=10
                                )

                                if int(status_response.status_code) not in [200, 201]:
                                    logger.warning(f"Status check failed: {status_response.status_code} - {status_response.text}")
                                    continue
                                
                                status_data = status_response.json()
                                task_status = status_data.get("data", {}).get("status")
                                
                                logger.info(f"ReelMind task {task_id} status: {task_status} (attempt {attempt}/{max_attempts})")
                                
                                if task_status == "completed":
                                    # Extract video URL from the nested data.output_result structure
                                    output_result = status_data.get("data", {}).get("output_result", {})
                                    video_url = output_result.get("video_url")
                                    if video_url:
                                        # Download the video
                                        video_response = requests.get(video_url, timeout=60)
                                        if video_response.status_code == 200:
                                            with open(output_path, 'wb') as f:
                                                f.write(video_response.content)
                                            
                                            # Clean up the uploaded input image from S3 (only if image was uploaded)
                                            if image_path:
                                                try:
                                                    s3_client.delete_object(Bucket=s3_bucket, Key=s3_key)
                                                    logger.info(f"Cleaned up input image from S3: {s3_key}")
                                                except Exception as cleanup_error:
                                                    logger.warning(f"Failed to clean up input image from S3: {cleanup_error}")
                                            
                                            logger.info(f"Kling video saved to: {output_path}")
                                            return ActionResult(extracted_content=f"✅ Video {params.output_file_name} generated successfully using Kling V2.1 Std and saved to downloads folder!")
                                        else:
                                            return ActionResult(error=f"Failed to download video from URL: {video_url} (Do not retry - this is a permanent failure)")
                                    else:
                                        return ActionResult(error="Video completed but no video_url provided (Do not retry - this is a permanent failure)")
                                
                                elif task_status == "failed":
                                    error_msg = status_data.get("error", "Video generation failed.")
                                    # Clean up the uploaded input image from S3 (only if image was uploaded)
                                    if image_path:
                                        try:
                                            s3_client.delete_object(Bucket=s3_bucket, Key=s3_key)
                                            logger.info(f"Cleaned up input image from S3 after failure: {s3_key}")
                                        except Exception as cleanup_error:
                                            logger.warning(f"Failed to clean up input image from S3 after failure: {cleanup_error}")
                                    return ActionResult(error=f"ReelMind video generation failed: {error_msg} (Do not retry - this is a permanent failure)")
                                
                                elif task_status in ["pending", "processing"]:
                                    # Continue polling
                                    continue
                                else:
                                    logger.warning(f"Unknown task status: {task_status}")
                                    continue
                            
                            # If we get here, we've exceeded max attempts
                            # Clean up the uploaded input image from S3 (only if image was uploaded)
                            if image_path:
                                try:
                                    s3_client.delete_object(Bucket=s3_bucket, Key=s3_key)
                                    logger.info(f"Cleaned up input image from S3 after timeout: {s3_key}")
                                except Exception as cleanup_error:
                                    logger.warning(f"Failed to clean up input image from S3 after timeout: {cleanup_error}")
                            return ActionResult(error=f"ReelMind video generation timed out after {max_attempts * 5} seconds (Do not retry - this is a permanent failure)")
                            
                        except requests.exceptions.RequestException as e:
                            # Clean up the uploaded input image from S3 if it exists
                            if image_path and 's3_key' in locals():
                                try:
                                    s3_client.delete_object(Bucket=s3_bucket, Key=s3_key)
                                    logger.info(f"Cleaned up input image from S3 after request error: {s3_key}")
                                except Exception as cleanup_error:
                                    logger.warning(f"Failed to clean up input image from S3 after request error: {cleanup_error}")
                            return ActionResult(error=f"ReelMind API request error: {str(e)} (Do not retry - this is a permanent failure)")
                        except Exception as e:
                            # Clean up the uploaded input image from S3 if it exists
                            if image_path and 's3_key' in locals():
                                try:
                                    s3_client.delete_object(Bucket=s3_bucket, Key=s3_key)
                                    logger.info(f"Cleaned up input image from S3 after error: {s3_key}")
                                except Exception as cleanup_error:
                                    logger.warning(f"Failed to clean up input image from S3 after error: {cleanup_error}")
                            return ActionResult(error=f"ReelMind video generation error: {str(e)} (Do not retry - this is a permanent failure)")
                    
                    else:
                        # Use Google VEO (default)
                        try:
                            from google import genai
                            from google.genai import types
                        except ImportError:
                            return ActionResult(error="Google Generative AI package not installed. Install with: pip install google-genai")
                        
                        # Get API key
                        api_key = os.getenv('GOOGLE_VEO_API_KEY')
                        if not api_key:
                            return ActionResult(error="GOOGLE_VEO_API_KEY environment variable is not set")
                        
                        client = genai.Client(api_key=api_key)
                        logger.info("Google VEO: Generating 8-second video with audio support in 16:9 aspect ratio")
                        
                        # Handle input image for Google VEO
                        image_object = None
                        if image_path:
                            try:
                                with open(image_path, "rb") as f:
                                    image_bytes = f.read()
                                
                                # Determine MIME type based on file extension
                                image_ext = Path(params.image_file_name).suffix.lower()
                                mime_type_map = {
                                    '.png': 'image/png',
                                    '.jpg': 'image/jpeg',
                                    '.jpeg': 'image/jpeg',
                                    '.gif': 'image/gif',
                                    '.bmp': 'image/bmp',
                                    '.webp': 'image/webp'
                                }
                                mime_type = mime_type_map.get(image_ext, 'image/jpeg')
                                
                                image_object = types.Image(image_bytes=image_bytes, mime_type=mime_type)
                                logger.info(f"Loaded input image for Google VEO: {params.image_file_name} (MIME: {mime_type})")
                            except Exception as e:
                                return ActionResult(error=f"Failed to read image file {params.image_file_name}: {str(e)}")
                        
                        # Generate video using VEO API
                        if image_object:
                            # Image-to-video generation
                            logger.info("Generating video from input image using Google VEO")
                            config_params = {
                                "aspect_ratio": "16:9",  # 16:9 is the only supported value for Veo 3
                                "number_of_videos": 1,  # 1 video generated per request
                            }
                            if params.negative_prompt:
                                config_params["negative_prompt"] = params.negative_prompt
                            
                            operation = client.models.generate_videos(
                                model="veo-3.0-generate-preview",
                                prompt=params.prompt,
                                image=image_object,
                                config=types.GenerateVideosConfig(**config_params)
                            )
                        else:
                            # Text-to-video generation
                            logger.info("Generating video from text prompt using Google VEO")
                            config_params = {
                                "aspect_ratio": "16:9",  # 16:9 is the only supported value for Veo 3
                                "number_of_videos": 1,  # 1 video generated per request
                            }
                            if params.negative_prompt:
                                config_params["negative_prompt"] = params.negative_prompt
                            
                            operation = client.models.generate_videos(
                                model="veo-3.0-generate-preview",
                                prompt=params.prompt,
                                config=types.GenerateVideosConfig(**config_params)
                            )
                        
                        # Wait for the video to be generated
                        logger.info("Waiting for Google VEO video generation to complete...")
                        while not operation.done:
                            time.sleep(20)
                            operation = client.operations.get(operation)
                            logger.info(f"Video generation update: {operation}")
                        
                        result = operation.result
                        
                        # Check if video was generated successfully
                        if result and result.generated_videos and len(result.generated_videos) > 0:
                            # Download and save the video
                            generated_video = result.generated_videos[0]
                            client.files.download(file=generated_video.video)
                            generated_video.video.save(output_path)
                            
                            logger.info(f"Google VEO video saved to: {output_path}")
                            return ActionResult(extracted_content=f"✅ Video {params.output_file_name} generated successfully using Google VEO and saved to downloads folder!")
                        else:
                            return ActionResult(error="No video data received from Google VEO API")

                except Exception as e:
                    logger.error(f"Error generating video: {e}")
                    return ActionResult(error=f"Failed to generate video: {str(e)}")

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
            
        if self.has_attachments:
            @self.controller.registry.action('Read attached file')
            async def read_attached_file(file_name: str) -> ActionResult:
                """Read the contents of an attached file. Supports various file formats:
                - Text files: .txt, .md, .log, .csv, .json, .jsonl
                - Documents: .docx, .xlsx
                - Web: .html, .htm
                - Data: .yaml, .yml, .xml
                - PDF: .pdf
                
                For files larger than 400KB, only the first and last 200KB will be returned.
                
                Parameters:
                - file_name: Name of the attached file to read
                
                Returns:
                - ActionResult with the file contents or error message
                """
                try:
                    # Get attachment path
                    file_path = await self._get_attachment_path(file_name)
                    if not file_path:
                        return ActionResult(error=f"File {file_name} not found in task attachments")

                    # Get file extension
                    file_ext = Path(file_name).suffix.lower()
                    chunk_size = 200 * 1024  # 200KB in bytes

                    # Handle different file types
                    if file_ext in ['.txt', '.md', '.log', '.json', '.jsonl']:
                        # Read text files
                        with open(file_path, 'r', encoding='utf-8') as f:
                            content = f.read()
                            
                    elif file_ext == '.csv':
                        # Read CSV files
                        with open(file_path, 'r', encoding='utf-8') as f:
                            reader = csv.reader(f)
                            content = '\n'.join([','.join(row) for row in reader])
                            
                    elif file_ext == '.docx':
                        try:
                            # Read DOCX files
                            doc = docx.Document(file_path)
                            content = '\n'.join([paragraph.text for paragraph in doc.paragraphs])
                        except ImportError:
                            return ActionResult(error="python-docx is not installed. Please install it to read DOCX files.")
                            
                    elif file_ext == '.xlsx':
                        try:
                            # Read XLSX files
                            wb = openpyxl.load_workbook(file_path, read_only=True)
                            content = []
                            for sheet in wb.sheetnames:
                                ws = wb[sheet]
                                content.append(f"Sheet: {sheet}")
                                for row in ws.rows:
                                    content.append('\t'.join(str(cell.value) for cell in row))
                            content = '\n'.join(content)
                        except ImportError:
                            return ActionResult(error="openpyxl is not installed. Please install it to read XLSX files.")
                            
                    elif file_ext in ['.html', '.htm']:
                        # Read HTML files
                        with open(file_path, 'r', encoding='utf-8') as f:
                            content = f.read()
                            
                    elif file_ext in ['.yaml', '.yml']:
                        try:
                            # Read YAML files
                            with open(file_path, 'r', encoding='utf-8') as f:
                                content = yaml.safe_dump(yaml.safe_load(f), default_flow_style=False)
                        except ImportError:
                            return ActionResult(error="PyYAML is not installed. Please install it to read YAML files.")
                            
                    elif file_ext == '.xml':
                        try:
                            # Read XML files
                            tree = ET.parse(file_path)
                            root = tree.getroot()
                            content = ET.tostring(root, encoding='unicode', method='xml')
                        except Exception as e:
                            return ActionResult(error=f"Error reading XML file: {str(e)}")
                            
                    elif file_ext == '.pdf':
                        try:
                            # Read PDF files
                            with open(file_path, 'rb') as f:
                                pdf_reader = PyPDF2.PdfReader(f)
                                content = []
                                for page in pdf_reader.pages:
                                    content.append(page.extract_text())
                                content = '\n'.join(content)
                        except ImportError:
                            return ActionResult(error="PyPDF2 is not installed. Please install it to read PDF files.")
                        except Exception as e:
                            return ActionResult(error=f"Error reading PDF file: {str(e)}")
                    
                    else:
                        return ActionResult(error=f"Unsupported file type: {file_ext}. Supported types are: .txt, .md, .log, .csv, .json, .jsonl, .docx, .xlsx, .html, .htm, .yaml, .yml, .xml, .pdf")

                    # Check content size and truncate if needed
                    content_size = len(content.encode('utf-8'))
                    if content_size > chunk_size * 2:  # If content is larger than 400KB
                        # Truncate content to first and last 200KB
                        first_part = content[:chunk_size]
                        last_part = content[-chunk_size:]
                        content = f"{first_part}\n... (middle content omitted) ...\n{last_part}"
                    
                    return ActionResult(extracted_content=content)

                except Exception as e:
                    logger.error(f"Error reading attached file: {e}")
                    return ActionResult(error=f"Failed to read file: {str(e)}")

        @self.controller.registry.action('Perform data analysis with code execution on attached and downloaded files. Output in text only. No output files will be saved.', param_model=DataAnalysisParams)
        async def perform_data_analysis(params: DataAnalysisParams) -> ActionResult:
            """Perform data analysis on files using Google Gemini SDK with code execution.
            
            This action uses the Google Gemini SDK to analyze files with code execution capabilities.
            Files are sent as inline data (base64 encoded) to the Gemini model for analysis.
            
            Parameters:
            - params: DataAnalysisParams containing:
              - file_names: List of file names to analyze. If the file is not attached, it will be searched in the downloads folder.
              - analysis_task: Description of the analysis task to perform
              - include_lead_list: If True, save the lead list as a JSON file and include it for analysis (default: False)
            
            Returns:
            - ActionResult with the analysis results or error message
            """
            try:
                # Import Google Gemini SDK
                try:
                    from google import genai
                    from google.genai import types
                except ImportError:
                    return ActionResult(error="Google Gemini SDK not installed. Install with: pip install google-genai")

                # Get API key
                api_key = secrets_manager.get_gemini_api_key()
                if not api_key:
                    return ActionResult(error="GEMINI_API_KEY environment variable is not set")

                # Initialize the client
                client = genai.Client(api_key=api_key)
                
                # Prepare file data for analysis
                file_parts = []
                total_size = 0
                # Get file size limit from environment variable, default to 50MB
                max_total_size = int(os.getenv('DATA_ANALYSIS_FILE_SIZE', '52428800'))  # 50MB in bytes
                
                # Handle lead list data if requested
                if params.include_lead_list:                    
                    try:
                        # Get lead list data from DynamoDB
                        lead_list_table = dynamodb.Table(f'{TABLE_PREFIX}AW-TaskLeadList')
                        response = lead_list_table.query(
                            KeyConditionExpression='taskId = :taskId',
                            ExpressionAttributeValues={
                                ':taskId': self.current_task_id
                            }
                        )
                        items = response.get('Items', [])
                        
                        if items:
                            # Create CSV file with the data records
                            import csv
                            import io
                            
                            # Get all unique field names from all records
                            all_fields = set()
                            for item in items:
                                record_data = item.get('data', {})
                                all_fields.update(record_data.keys())
                            
                            # Sort fields for consistent ordering
                            field_names = sorted(list(all_fields))
                            
                            # Create CSV content
                            csv_buffer = io.StringIO()
                            csv_writer = csv.writer(csv_buffer)
                            
                            # Write header
                            csv_writer.writerow(field_names)
                            
                            # Write data rows
                            for item in items:
                                record_data = item.get('data', {})
                                row = [record_data.get(field, '') for field in field_names]
                                csv_writer.writerow(row)
                            
                            csv_content = csv_buffer.getvalue()
                            csv_buffer.close()
                            
                            lead_list_file_name = f"lead_list.csv"
                            
                            # Add lead list file to the analysis
                            file_content = base64.b64encode(csv_content.encode('utf-8')).decode('utf-8')
                            file_part = {
                                "inline_data": {
                                    "data": file_content,
                                    "mime_type": "text/csv"
                                }
                            }
                            file_parts.append(file_part)
                            
                            # Update analysis task to mention lead list data with metadata
                            params.analysis_task = f"{params.analysis_task}\n\nNote: Lead list data has been included as '{lead_list_file_name}' with {len(items)} records. The identifier field is '{self.lead_list_identifier}'."
                        else:
                            params.analysis_task = f"{params.analysis_task}\n\nNote: Lead list was requested but no records were found."
                            
                    except Exception as e:
                        logger.error(f"Error retrieving lead list data: {e}")
                        return ActionResult(error=f"Failed to retrieve lead list data: {str(e)}")
                
                for file_name in params.file_names:
                    # Try to get file path from attachments first, then downloads
                    file_path = await self._get_attachment_path(file_name)
                    
                    if not file_path:
                        # If not found in attachments, try downloads path
                        downloads_path = self._get_downloads_path()
                        file_path = Path(downloads_path) / file_name
                        
                        if not file_path.exists():
                            return ActionResult(error=f"File {file_name} not found in task attachments or downloads folder")

                    # Check file size before processing
                    file_size = file_path.stat().st_size
                    total_size += file_size
                    
                    if total_size > max_total_size:
                        return ActionResult(error=f"Total file size ({total_size} bytes) exceeds the {max_total_size} bytes limit. Please reduce the number or size of files.")

                    # Read file content
                    try:
                        with open(file_path, 'r', encoding='utf-8') as f:
                            file_content = f.read()
                        # Encode as base64 for inline_data
                        file_content = base64.b64encode(file_content.encode('utf-8')).decode('utf-8')
                    except UnicodeDecodeError:
                        # Try binary mode for non-text files
                        with open(file_path, 'rb') as f:
                            file_content = f.read()
                            # For binary files, we'll encode as base64
                            file_content = base64.b64encode(file_content).decode('utf-8')
                    
                    # Determine MIME type based on file extension
                    file_ext = Path(file_name).suffix.lower()
                    mime_type_map = {
                        '.csv': 'text/csv',
                        '.txt': 'text/plain',
                        '.json': 'application/json',
                        '.jsonl': 'application/jsonl',
                        '.xml': 'application/xml',
                        '.yaml': 'application/x-yaml',
                        '.yml': 'application/x-yaml',
                        '.html': 'text/html',
                        '.htm': 'text/html',
                        '.md': 'text/markdown',
                        '.log': 'text/plain',
                        '.py': 'text/x-python',
                        '.js': 'text/javascript',
                        '.ts': 'text/typescript',
                        '.java': 'text/x-java-source',
                        '.cpp': 'text/x-c++src',
                        '.c': 'text/x-csrc'
                    }
                    mime_type = mime_type_map.get(file_ext, 'text/plain')
                    
                    # Create file part
                    file_part = {
                        "inline_data": {
                            "data": file_content,
                            "mime_type": mime_type
                        }
                    }
                    file_parts.append(file_part)
                
                # Call Gemini API
                model_name = os.getenv('DATA_ANALYSIS_LLM_NAME', 'gemini-2.5-pro')
                
                # Create the content parts properly
                content_parts = []
                
                # Add file parts
                for file_part in file_parts:
                    content_parts.append(file_part)
                
                # Add text part
                content_parts.append({
                    "text": f"Please perform the following analysis task on the provided files:\n\n{params.analysis_task}\n\nUse Python code execution to analyze the data and provide detailed insights. Do not ask questions as the user is not present."
                })
                
                response = client.models.generate_content(
                    model=model_name,  # Use environment variable or default to gemini-2.5-pro
                    contents=content_parts,
                    config=types.GenerateContentConfig(
                        tools=[types.Tool(code_execution=types.ToolCodeExecution)]
                    ),
                )
                
                # Extract and format the response
                result_parts = []
                code_executed = False
                
                for part in response.candidates[0].content.parts:
                    if part.text is not None:
                        result_parts.append(f"**Analysis:** {part.text}")
                    if part.executable_code is not None:
                        result_parts.append(f"**Code Executed:**\n```python\n{part.executable_code.code}\n```")
                        code_executed = True
                    if part.code_execution_result is not None:
                        result_parts.append(f"**Code Output:**\n```\n{part.code_execution_result.output}\n```")
                
                if not result_parts:
                    return ActionResult(error="No analysis results received from Gemini")
                
                # Combine all results
                analysis_result = "\n\n".join(result_parts)
                
                return ActionResult(extracted_content=f"{analysis_result}{'\n\nNo code execution was performed.' if not code_executed else ''}")

            except Exception as e:
                logger.error(f"Error performing data analysis: {e}")
                return ActionResult(error=f"Failed to perform data analysis: {str(e)}")

        @self.controller.registry.action('Perform video analysis using Google Gemini 2.5 Pro', param_model=VideoAnalysisParams)
        async def perform_video_analysis(params: VideoAnalysisParams) -> ActionResult:
            """Perform video analysis using Google Gemini 2.5 Pro.
            
            This action analyzes videos from URLs using Google Gemini 2.5 Pro.
            For YouTube videos, it sends the URL directly to Gemini.
            For other video URLs, it downloads the video and sends it as a file to Gemini.
            
            Parameters:
            - params: VideoAnalysisParams containing:
              - video_url: URL of the video to analyze (YouTube or other video URL)
              - prompt: Analysis prompt describing what to analyze in the video
            
            Returns:
            - ActionResult with the video analysis results or error message
            """
            try:
                # Import Google Gemini SDK
                try:
                    from google import genai
                    from google.genai import types
                except ImportError:
                    return ActionResult(error="Google Generative AI package not installed. Install with: pip install google-genai")

                # Get API key
                api_key = secrets_manager.get_gemini_api_key()
                if not api_key:
                    return ActionResult(error="GEMINI_API_KEY environment variable is not set")

                # Initialize the client
                client = genai.Client(api_key=api_key)
                
                # Get model name from environment
                model_name = os.getenv('VIDEO_ANALYSIS_LLM_NAME', 'gemini-2.5-pro')
                
                # Check if it's a YouTube URL
                is_youtube = 'youtube.com' in params.video_url or 'youtu.be' in params.video_url                
                if is_youtube:
                    # For YouTube videos, send URL directly to Gemini using proper SDK
                    logger.info(f"Analyzing YouTube video: {params.video_url}")
                    
                    try:
                        # Create content using the proper Google Generative AI SDK
                        contents = [
                            types.Content(
                                role="user",
                                parts=[
                                    types.Part(
                                        file_data=types.FileData(
                                            file_uri=params.video_url,
                                            mime_type="video/*",
                                        )
                                    ),
                                    types.Part.from_text(text=params.prompt),
                                ],
                            ),
                        ]
                        
                        generate_content_config = types.GenerateContentConfig(
                            thinking_config=types.ThinkingConfig(
                                thinking_budget=-1,
                            ),
                            response_mime_type="text/plain",
                        )
                        
                        logger.info("Sending YouTube video analysis request...")
                        
                        # Collect the response
                        response_text = ""
                        for chunk in client.models.generate_content_stream(
                            model=model_name,
                            contents=contents,
                            config=generate_content_config,
                        ):
                            if chunk.text:
                                response_text += chunk.text
                        
                        if response_text:
                            logger.info("YouTube video analysis completed successfully")
                            return ActionResult(extracted_content=response_text)
                        else:
                            return ActionResult(error="No analysis results received from Gemini for YouTube video")
                            
                    except Exception as e:
                        logger.error(f"Error analyzing YouTube video: {e}")
                        return ActionResult(error=f"Failed to analyze YouTube video: {str(e)}")
                        
                else:
                    # For other video URLs, download the video and send as file
                    logger.info(f"Downloading and analyzing video: {params.video_url}")

                    try:
                        is_instagram = 'instagram.com' in params.video_url
                        is_facebook = 'facebook.com' in params.video_url
                        is_google_drive = 'drive.google.com' in params.video_url

                        if is_instagram:
                            try:
                                import instaloader
                            except ImportError:
                                return ActionResult(error="instaloader library not installed. Install with: pip install instaloader")

                            L = instaloader.Instaloader(
                                download_videos=True,
                                download_video_thumbnails=False,
                                download_geotags=False,
                                download_comments=False,
                                save_metadata=False,
                                compress_json=False
                            )

                            shortcode = params.video_url.split('/p/')[-1].split('/')[0]
                            logger.info(f"Extracted Instagram shortcode: {shortcode}")

                            post = instaloader.Post.from_shortcode(L.context, shortcode)

                            if not post.is_video:
                                return ActionResult(error="This Instagram post is not a video")

                            if not post.video_url:
                                return ActionResult(error="No video URL found in Instagram post")

                            logger.info(f"Found Instagram video URL: {post.video_url}")

                            import tempfile
                            with tempfile.TemporaryDirectory() as temp_dir:
                                temp_dir_path = Path(temp_dir) / (self.current_execution_id or "unknown_execution")
                                temp_dir_path.mkdir(exist_ok=True)
                                logger.info(f"Downloading Instagram video to {temp_dir_path}")
                                L.download_post(post, target=temp_dir_path)
                                video_files = list(temp_dir_path.glob("*.mp4"))
                                if not video_files:
                                    return ActionResult(error="No video file found after Instagram download")
                                video_file = video_files[0]
                                file_size = video_file.stat().st_size
                                if file_size == 0:
                                    return ActionResult(error="Downloaded Instagram video file is empty")
                                
                                logger.info(f"Instagram video downloaded successfully: {file_size} bytes ({file_size / (1024*1024):.1f} MB)")
                                with open(video_file, 'rb') as video_file_handle:
                                    video_data = video_file_handle.read()
                                file_extension = ".mp4"
                                mime_type = "video/mp4"
                        elif is_facebook:
                            try:
                                import yt_dlp
                            except ImportError:
                                return ActionResult(error="yt-dlp library not installed. Install with: pip install yt-dlp")

                            logger.info(f"Downloading Facebook video: {params.video_url}")

                            import tempfile
                            with tempfile.TemporaryDirectory() as temp_dir:
                                temp_dir_path = Path(temp_dir) / (self.current_execution_id or "unknown_execution")
                                temp_dir_path.mkdir(exist_ok=True)
                                logger.info(f"Downloading Facebook video to {temp_dir_path}")

                                # Configure yt-dlp options
                                ydl_opts = {
                                    'outtmpl': str(temp_dir_path / '%(title)s.%(ext)s'),
                                    'quiet': True,
                                    'no_warnings': True,
                                    'extract_flat': False,
                                    'format': 'best[ext=mp4]/best',  # Prefer MP4 format
                                    'writeinfojson': False,
                                    'writesubtitles': False,
                                    'writeautomaticsub': False,
                                    'ignoreerrors': False,
                                }

                                # Download the video
                                logger.info("Downloading Facebook video...")
                                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                                    # Get video info first
                                    info = ydl.extract_info(params.video_url, download=False)
                                    logger.info(f"Facebook video info:")
                                    logger.info(f"  - Title: {info.get('title', 'Unknown')}")
                                    logger.info(f"  - Duration: {info.get('duration', 'Unknown')} seconds")
                                    logger.info(f"  - Uploader: {info.get('uploader', 'Unknown')}")
                                    
                                    # Download the video
                                    ydl.download([params.video_url])

                                # Find the downloaded video file
                                video_files = list(temp_dir_path.glob("*.mp4"))
                                if not video_files:
                                    # Try other video extensions
                                    video_files = list(temp_dir_path.glob("*.webm")) + list(temp_dir_path.glob("*.mkv")) + list(temp_dir_path.glob("*.avi"))
                                
                                if not video_files:
                                    return ActionResult(error="No video file found after Facebook download")
                                
                                video_file = video_files[0]  # Take the first video file found
                                file_size = video_file.stat().st_size
                                
                                if file_size == 0:
                                    return ActionResult(error="Downloaded Facebook video file is empty")

                                logger.info(f"Facebook video downloaded successfully: {file_size} bytes ({file_size / (1024*1024):.1f} MB)")
                                logger.info(f"Downloaded file: {video_file.name}")

                                # Read the video file as binary data and set up for existing analysis code
                                with open(video_file, 'rb') as video_file_handle:
                                    video_data = video_file_handle.read()

                                # Get the actual file extension from the downloaded file
                                file_extension = video_file.suffix.lower()
                                
                                # If no extension or unknown extension, try to infer from filename
                                if not file_extension or file_extension not in ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.mpg', '.mpeg', '.ogv']:
                                    # Look for video extensions in the filename
                                    filename_lower = video_file.name.lower()
                                    for ext in ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.mpg', '.mpeg', '.ogv']:
                                        if ext in filename_lower:
                                            file_extension = ext
                                            logger.info(f"Inferred extension from filename: {file_extension}")
                                            break
                                    else:
                                        # If no video extension found in filename, assume MP4
                                        file_extension = '.mp4'
                                        logger.info(f"Assuming MP4 extension")
                                
                                # Determine MIME type based on actual file extension
                                mime_type_map = {
                                    '.mp4': 'video/mp4',
                                    '.avi': 'video/x-msvideo',
                                    '.mov': 'video/quicktime',
                                    '.mkv': 'video/x-matroska',
                                    '.wmv': 'video/x-ms-wmv',
                                    '.flv': 'video/x-flv',
                                    '.webm': 'video/webm',
                                    '.m4v': 'video/x-m4v',
                                    '.3gp': 'video/3gpp',
                                    '.mpg': 'video/mpeg',
                                    '.mpeg': 'video/mpeg',
                                    '.ogv': 'video/ogg'
                                }
                                mime_type = mime_type_map.get(file_extension, 'video/mp4')
                                
                                logger.info(f"Detected file extension: {file_extension}, MIME type: {mime_type}")
                        elif is_google_drive:
                            try:
                                import gdown
                            except ImportError:
                                return ActionResult(error="gdown library not installed. Install with: pip install gdown")

                            # Extract file ID from URL
                            if '/file/d/' in params.video_url:
                                file_id = params.video_url.split('/file/d/')[1].split('/')[0]
                            elif 'id=' in params.video_url:
                                file_id = params.video_url.split('id=')[1].split('&')[0]
                            else:
                                return ActionResult(error="Could not extract file ID from Google Drive URL")

                            logger.info(f"Extracted Google Drive file ID: {file_id}")

                            import tempfile
                            with tempfile.TemporaryDirectory() as temp_dir:
                                temp_dir_path = Path(temp_dir) / (self.current_execution_id or "unknown_execution")
                                temp_dir_path.mkdir(exist_ok=True)
                                logger.info(f"Downloading Google Drive video to {temp_dir_path}")

                                # Construct the direct download URL
                                direct_url = f"https://drive.google.com/uc?id={file_id}"

                                # First, try to get the actual filename from Google Drive
                                logger.info("Getting file information from Google Drive...")
                                
                                # Use gdown to get file info first
                                filename = None
                                try:
                                    import requests
                                    
                                    # Try to get file info using Google Drive API-like approach
                                    info_url = f"https://drive.google.com/uc?id={file_id}&export=download"
                                    response = requests.head(info_url, allow_redirects=True)
                                    
                                    # Check if we can get filename from Content-Disposition header
                                    content_disposition = response.headers.get('Content-Disposition', '')
                                    if 'filename=' in content_disposition:
                                        filename = content_disposition.split('filename=')[1].strip('"')
                                        logger.info(f"Found filename from headers: {filename}")
                                    
                                    # If no filename found, try a different approach
                                    if not filename:
                                        # Use gdown with --id flag to get file info
                                        import subprocess
                                        try:
                                            result = subprocess.run([
                                                'gdown', '--id', file_id, '--print-url'
                                            ], capture_output=True, text=True, timeout=30)
                                            
                                            if result.returncode == 0 and result.stdout.strip():
                                                # Parse the output to get filename
                                                output_lines = result.stdout.strip().split('\n')
                                                for line in output_lines:
                                                    if 'filename=' in line:
                                                        filename = line.split('filename=')[1].strip()
                                                        logger.info(f"Found filename from gdown: {filename}")
                                                        break
                                        except Exception as e:
                                            logger.warning(f"Could not get filename from gdown: {e}")
                                    
                                except Exception as e:
                                    logger.warning(f"Could not get file info: {e}")
                                
                                # Download the video using gdown
                                logger.info("Downloading Google Drive video...")
                                
                                # Use gdown with the actual filename if we found it
                                if filename:
                                    # Use the actual filename if we found it
                                    output_path = str(temp_dir_path / filename)
                                    logger.info(f"Using actual filename: {filename}")
                                else:
                                    return ActionResult(error="Could not get filename from Google Drive")
                                
                                result = gdown.download(
                                    direct_url, 
                                    output_path, 
                                    quiet=True,
                                    fuzzy=True,  # Use fuzzy matching to get the correct file
                                    use_cookies=False  # Don't use cookies which can cause issues
                                )

                                if result is None:
                                    return ActionResult(error="Download failed - gdown returned None")

                                # Wait a moment for any file operations to complete
                                import time
                                time.sleep(2)

                                # Find the downloaded file (filter out system files and hidden files)
                                video_files = [f for f in temp_dir_path.glob("*") if not f.name.startswith('.') and f.name != '.DS_Store']
                                if not video_files:
                                    return ActionResult(error="No file found after Google Drive download")
                                
                                # Take the first file found
                                video_file = video_files[0]
                                logger.info(f"Found downloaded file: {video_file.name}")
                                file_size = video_file.stat().st_size

                                if file_size == 0:
                                    return ActionResult(error="Downloaded Google Drive video file is empty")

                                logger.info(f"Google Drive video downloaded successfully: {file_size} bytes ({file_size / (1024*1024):.1f} MB)")
                                logger.info(f"Downloaded file: {video_file.name}")

                                # Read the video file as binary data and set up for existing analysis code
                                with open(video_file, 'rb') as video_file_handle:
                                    video_data = video_file_handle.read()

                                # Get the actual file extension from the downloaded file
                                file_extension = video_file.suffix.lower()
                                
                                # If no extension or unknown extension, try to infer from filename
                                if not file_extension or file_extension not in ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.mpg', '.mpeg', '.ogv']:
                                    # Look for video extensions in the filename
                                    filename_lower = video_file.name.lower()
                                    for ext in ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.mpg', '.mpeg', '.ogv']:
                                        if ext in filename_lower:
                                            file_extension = ext
                                            logger.info(f"Inferred extension from filename: {file_extension}")
                                            break
                                    else:
                                        return ActionResult(error="Could not get file extension from Google Drive")
                                
                                # Determine MIME type based on actual file extension
                                mime_type_map = {
                                    '.mp4': 'video/mp4',
                                    '.avi': 'video/x-msvideo',
                                    '.mov': 'video/quicktime',
                                    '.mkv': 'video/x-matroska',
                                    '.wmv': 'video/x-ms-wmv',
                                    '.flv': 'video/x-flv',
                                    '.webm': 'video/webm',
                                    '.m4v': 'video/x-m4v',
                                    '.3gp': 'video/3gpp',
                                    '.mpg': 'video/mpeg',
                                    '.mpeg': 'video/mpeg',
                                    '.ogv': 'video/ogg'
                                }
                                mime_type = mime_type_map.get(file_extension, 'video/mp4')
                                
                                logger.info(f"Detected file extension: {file_extension}, MIME type: {mime_type}")
                        else:
                            import aiohttp
                            import tempfile
                            from urllib.parse import urlparse
                            parsed_url = urlparse(params.video_url)
                            file_extension = Path(parsed_url.path).suffix.lower()
                            video_extensions = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp']
                            if not file_extension or file_extension not in video_extensions:
                                return ActionResult(error="Unknown video file extension. Please provide a video file with one of the following extensions: " + ", ".join(video_extensions))
                            
                            with tempfile.TemporaryDirectory() as temp_dir:
                                temp_dir_path = Path(temp_dir) / (self.current_execution_id or "unknown_execution")
                                temp_dir_path.mkdir(exist_ok=True)
                                temp_video_path = temp_dir_path / f"downloaded_video{file_extension}"
                                logger.info(f"Downloading HTTP video to {temp_video_path}")
                            async with aiohttp.ClientSession() as session:
                                async with session.get(params.video_url) as response:
                                    if response.status != 200:
                                        return ActionResult(error=f"Failed to download video: HTTP {response.status}")
                                    video_data = await response.read()
                                    
                                    logger.info(f"Video downloaded successfully: {len(video_data)} bytes ({len(video_data) / (1024*1024):.1f} MB)")
                                    
                                    with open(temp_video_path, 'wb') as f:
                                        f.write(video_data)
                            with open(temp_video_path, 'rb') as video_file:
                                video_data = video_file.read()
                            mime_type_map = {
                                '.mp4': 'video/mp4',
                                '.avi': 'video/x-msvideo',
                                '.mov': 'video/quicktime',
                                '.mkv': 'video/x-matroska',
                                '.wmv': 'video/x-ms-wmv',
                                '.flv': 'video/x-flv',
                                '.webm': 'video/webm',
                                '.m4v': 'video/x-m4v',
                                '.3gp': 'video/3gpp'
                            }
                            mime_type = mime_type_map.get(file_extension, 'video/mp4')

                        # Check file size limit before analysis
                        video_size = len(video_data)
                        max_size_mb = int(os.getenv('MAX_DOWNLOADED_VIDEO_SIZE_MB', '100'))  # Default 100MB
                        max_size_bytes = max_size_mb * 1024 * 1024
                        
                        if video_size > max_size_bytes:
                            error_msg = f"Video file too large for analysis: {video_size} bytes ({video_size / (1024*1024):.1f} MB) exceeds limit of {max_size_mb} MB"
                            logger.error(error_msg)
                            return ActionResult(error=error_msg)
                        
                        logger.info(f"Size check passed (limit: {max_size_mb} MB)")

                        # --- Shared Gemini analysis code ---
                        contents = [
                            types.Content(
                                role="user",
                                parts=[
                                    types.Part.from_bytes(
                                        mime_type=mime_type,
                                        data=video_data
                                    ),
                                    types.Part.from_text(text=params.prompt),
                                ],
                            ),
                        ]

                        generate_content_config = types.GenerateContentConfig(
                            thinking_config=types.ThinkingConfig(
                                thinking_budget=-1,
                            ),
                            response_mime_type="text/plain",
                        )

                        logger.info("Sending video file analysis request...")

                        response_text = ""
                        for chunk in client.models.generate_content_stream(
                            model=model_name,
                            contents=contents,
                            config=generate_content_config,
                        ):
                            if chunk.text:
                                response_text += chunk.text

                        if response_text:
                            logger.info("Video file analysis completed successfully")
                            return ActionResult(extracted_content=response_text)
                        else:
                            return ActionResult(error="No analysis results received from Gemini for video file")

                    except Exception as e:
                        logger.error(f"Error downloading or processing video: {e}")
                        return ActionResult(error=f"Failed to download or process video: {str(e)}")
                    finally:
                        # Cleanup is handled automatically by tempfile.TemporaryDirectory() contexts
                        pass

            except Exception as e:
                logger.error(f"Error performing video analysis: {e}")
                return ActionResult(error=f"Failed to perform video analysis: {str(e)}")

        @self.controller.registry.action('Generate image with input images using OpenAI GPT Image or Azure AI Services FLUX', param_model=GenerateImageParams)
        async def generate_image(params: GenerateImageParams) -> ActionResult:
            """Generate or edit images using OpenAI GPT Image or Azure AI Services FLUX model with input images.
            
            This action uses OpenAI GPT Image or Azure AI Services FLUX.1-Kontext-pro to generate or edit images based on input images
            from attachments or downloads folder. The generated image is saved to the downloads folder.
            
            Parameters:
            - params: GenerateImageParams containing:
              - input_file_names: List of input image file names. If the file is not attached, it will be searched in the downloads folder.
              - prompt: Description of what to do with the input images
              - output_file_name: Name of the output image file to save in downloads folder
              - size: Image size (default: "1024x1024")
              - quality: Image quality (default: "medium")
            
            
            Returns:
            - ActionResult with the generation results or error message
            """
            try:
                # Import OpenAI client (used for OpenAI and default path)
                try:
                    from openai import OpenAI
                except ImportError:
                    return ActionResult(error="OpenAI package not installed. Install with: pip install openai")

                # Determine which model to use and get appropriate API key
                # Use the task's imageModel when provided; otherwise default to env or "openai-image-1"
                model_to_use = self.image_model or os.getenv('DEFAULT_IMAGE_MODEL', "openai-image-1")
                
                logger.info(f"Image generation - task.image_model: {self.image_model}, final model_to_use: {model_to_use}")
                
                # Initialize variables for Azure AI Services / Google Gemini
                azure_model_name = None
                google_model_name = None
                google_client = None
                
                if model_to_use == "FLUX.1-Kontext-pro":
                    # Use Azure AI Services for FLUX model with direct HTTP requests
                    api_key = secrets_manager.get_azure_openai_api_key2()
                    if not api_key:
                        return ActionResult(error="AZURE_OPENAI_API_KEY2 environment variable is not set for FLUX.1-Kontext-pro model")
                    
                    logger.info(f"Using Azure AI Services FLUX model with direct HTTP requests")
                    
                    # Azure AI Services endpoint for FLUX model
                    azure_endpoint = "https://ai-ruiwangwarm7085ai345967089938.services.ai.azure.com"
                    deployment_name = "FLUX.1-Kontext-pro"
                    
                    # For Azure AI Services, we'll use direct HTTP requests
                    azure_model_name = "flux.1-kontext-pro"
                    
                    logger.info(f"Azure AI Services FLUX model configured: {azure_model_name}")
                elif model_to_use == "gemini-2.5-flash-image":
                    # Use Google Gemini Nano Banana image model
                    api_key = secrets_manager.get_google_image_api_key()
                    if not api_key:
                        return ActionResult(error="GOOGLE_IMAGE_API_KEY environment variable is not set for Google Nano Banana model")
                    try:
                        from google import genai
                        from google.genai import types as google_types
                    except ImportError:
                        return ActionResult(error="google-genai package not installed. Install with: pip install google-genai")

                    logger.info("Using Google Nano Banana (gemini-2.5-flash-image)")
                    google_client = genai.Client(api_key=api_key)
                    google_model_name = "gemini-2.5-flash-image"
                elif model_to_use == "gpt-image-1":
                    # Use Azure AI Services for gpt-image-1 model (same as FLUX)
                    api_key = secrets_manager.get_azure_openai_api_key2()
                    if not api_key:
                        return ActionResult(error="AZURE_OPENAI_API_KEY2 environment variable is not set for gpt-image-1 model")
                    
                    logger.info("Using Azure AI Services for gpt-image-1 model")
                    
                    # Azure AI Services endpoint for gpt-image-1 model
                    azure_endpoint = "https://ai-ruiwangwarm7085ai345967089938.services.ai.azure.com"
                    deployment_name = "gpt-image-1"
                    azure_model_name = "gpt-image-1"
                else:
                    # Use OpenAI for other models
                    api_key = os.getenv('OPENAI_IMAGE_API_KEY')
                    if not api_key:
                        return ActionResult(error="OPENAI_IMAGE_API_KEY environment variable is not set")
                    
                    logger.info(f"Using OpenAI default model: {model_to_use}")
                    
                    # Initialize OpenAI client
                    client = OpenAI(api_key=api_key)

                # Validate parameters
                # Validate quality (fallback to default instead of error)
                valid_qualities = ["low", "medium", "high", "auto"]
                if params.quality not in valid_qualities:
                    logger.warning(f"Invalid quality '{params.quality}' provided. Falling back to 'medium'.")
                    params.quality = "medium"
                
                # Validate size
                valid_sizes = ["1024x1024", "1536x1024", "1024x1536", "auto"]
                if params.size not in valid_sizes:
                    return ActionResult(error=f"Invalid size '{params.size}'. Must be one of: {', '.join(valid_sizes)}")
                

                
                # Validate output file extension (must end with .png)
                output_ext = Path(params.output_file_name).suffix.lower()
                if output_ext != ".png":
                    return ActionResult(error=f"Output file extension '{output_ext}' must be '.png'. Please rename the file to end with .png")
                
                # Get downloads path for output
                downloads_path = self._get_downloads_path()
                output_path = Path(downloads_path) / params.output_file_name
                
                # Prepare input images
                input_images = []
                
                for file_name in params.input_file_names:
                    # Try to get file path from attachments first, then downloads
                    file_path = await self._get_attachment_path(file_name)
                    
                    if not file_path:
                        # If not found in attachments, try downloads path
                        file_path = Path(downloads_path) / file_name
                        
                        if not file_path.exists():
                            return ActionResult(error=f"Input image file {file_name} not found in task attachments or downloads folder")

                    # Check if file is an image
                    file_ext = Path(file_name).suffix.lower()
                    if file_ext not in ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg']:
                        return ActionResult(error=f"File {file_name} is not a supported image format. Supported formats: PNG, JPG, JPEG, GIF, BMP, WEBP, SVG")

                    # Convert SVG to high-quality PNG if needed
                    if file_ext == '.svg':
                        # Create a high-quality PNG file for the converted SVG in attachment directory
                        png_file_name = Path(file_name).with_suffix('.png').name
                        attachment_dir = self._get_attachment_dir()
                        if not attachment_dir:
                            return ActionResult(error="Failed to get attachment directory for SVG conversion")
                        png_path = attachment_dir / png_file_name
                        
                        # Use high DPI (300) and 2048px width for better quality
                        if not convert_svg_to_png(str(file_path), str(png_path), dpi=300, width=2048):
                            return ActionResult(error=f"Failed to convert SVG file {file_name} to high-quality PNG format")
                        
                        # Replace SVG filename with PNG filename in the prompt
                        params.prompt = params.prompt.replace(file_name, png_file_name)
                        
                        # Use the converted PNG file instead
                        input_images.append(png_path)
                        logger.info(f"Converted SVG {file_name} to high-quality PNG {png_file_name} in attachment directory for processing")
                    else:
                        input_images.append(file_path)
                
                # Determine the operation based on number of input images
                if len(input_images) == 0:
                    # Generate new image from prompt only
                    if model_to_use == "gpt-image-1":
                        # Use Azure AI Services for gpt-image-1 model
                        logger.info(f"Generating new image with Azure gpt-image-1 model...")
                        
                        import requests
                        
                        url = f"{azure_endpoint}/openai/deployments/{deployment_name}/images/generations"
                        headers = {
                            "Content-Type": "application/json",
                            "api-key": api_key
                        }
                        data = {
                            "prompt": params.prompt,
                            "size": params.size,
                            "n": 1,
                            "quality": params.quality,
                            "output_format": "png"
                        }
                        
                        generation_response = requests.post(url, headers=headers, json=data, params={"api-version": "2025-04-01-preview"})
                        
                        if generation_response.status_code != 200:
                            return ActionResult(error=f"Azure AI Services API error: {generation_response.status_code} - {generation_response.text}")
                        
                        result_data = generation_response.json()
                        if not result_data.get('data') or len(result_data['data']) == 0:
                            return ActionResult(error="No image data received from Azure AI Services API")
                        
                        # Extract the image data
                        image_base64 = result_data['data'][0].get('b64_json')
                        if not image_base64:
                            return ActionResult(error="No b64_json data in Azure AI Services response")
                        
                        # Save the image
                        image_bytes = base64.b64decode(image_base64)
                        with open(output_path, "wb") as f:
                            f.write(image_bytes)
                        
                        logger.info(f"Generated image with Azure gpt-image-1 saved to: {output_path}")
                        
                        # Upload the generated image to S3 and get the URL
                        result_files = []
                        if self.current_execution_id:
                            result_files = upload_task_result_files(downloads_path, self.current_execution_id)
                        
                        # Find the uploaded file info for our generated image
                        uploaded_file_info = None
                        for file_info in result_files:
                            if file_info.get('filename') == params.output_file_name:
                                uploaded_file_info = file_info
                                break
                        
                        # Create success message
                        if uploaded_file_info and uploaded_file_info.get('url'):
                            success_msg = f"✅ Image {params.output_file_name} generated successfully using Azure {model_to_use}! It has been uploaded and available at {uploaded_file_info['url']}. You MUST use the URL to refer this image in any HTML or Markdown content."
                            logger.info(f"Generated image uploaded to S3: {uploaded_file_info['url']}")
                        else:
                            success_msg = f"✅ Image {params.output_file_name} generated successfully using Azure {model_to_use} and saved to downloads folder!"
                            logger.warning("Could not retrieve S3 URL for generated image")
                        
                        return ActionResult(extracted_content=success_msg)
                    elif model_to_use == "FLUX.1-Kontext-pro":
                        # Use direct HTTP request for Azure AI Services FLUX model
                        logger.info(f"Generating new image with FLUX model using direct HTTP request...")
                        
                        import requests
                        
                        url = f"{azure_endpoint}/openai/deployments/{deployment_name}/images/generations"
                        headers = {
                            "Content-Type": "application/json",
                            "api-key": api_key
                        }
                        data = {
                            "prompt": params.prompt,
                            "size": params.size,
                            "n": 1,
                            "quality": params.quality,
                            "output_format": "png"
                        }
                        
                        response = requests.post(url, headers=headers, json=data, params={"api-version": "2025-04-01-preview"})
                        
                        if response.status_code != 200:
                            return ActionResult(error=f"Azure AI Services API error: {response.status_code} - {response.text}")
                        
                        result_data = response.json()
                        if not result_data.get('data') or len(result_data['data']) == 0:
                            return ActionResult(error="No image data received from Azure AI Services API")
                        
                        # Extract the image data
                        image_base64 = result_data['data'][0].get('b64_json')
                        if not image_base64:
                            return ActionResult(error="No b64_json data in Azure AI Services response")
                        
                        # Save the image
                        image_bytes = base64.b64decode(image_base64)
                        with open(output_path, "wb") as f:
                            f.write(image_bytes)
                        
                        logger.info(f"Generated image with FLUX model saved to: {output_path}")
                        
                        # Upload the generated image to S3 and get the URL
                        result_files = []
                        if self.current_execution_id:
                            result_files = upload_task_result_files(downloads_path, self.current_execution_id)
                        
                        # Find the uploaded file info for our generated image
                        uploaded_file_info = None
                        for file_info in result_files:
                            if file_info.get('filename') == params.output_file_name:
                                uploaded_file_info = file_info
                                break
                        
                        # Create success message
                        if uploaded_file_info and uploaded_file_info.get('url'):
                            success_msg = f"✅ Image {params.output_file_name} generated successfully using {model_to_use}! It has been uploaded and available at {uploaded_file_info['url']}. You MUST use the URL to refer this image in any HTML or Markdown content."
                            logger.info(f"Generated image uploaded to S3: {uploaded_file_info['url']}")
                        else:
                            success_msg = f"✅ Image {params.output_file_name} generated successfully using {model_to_use} and saved to downloads folder! "
                            logger.warning("Could not retrieve S3 URL for generated image")
                        
                        return ActionResult(extracted_content=success_msg)
                    elif google_client is not None:
                        # Google Nano Banana: text-only generation
                        logger.info("Generating new image with Google Nano Banana from text prompt")
                        contents = [
                            google_types.Content(
                                role="user",
                                parts=[
                                    google_types.Part.from_text(text=params.prompt),
                                ],
                            )
                        ]
                        generate_content_config = google_types.GenerateContentConfig(
                            response_modalities=["IMAGE", "TEXT"]
                        )

                        file_index = 0
                        emitted_text_parts = []
                        for chunk in google_client.models.generate_content_stream(
                            model=google_model_name,
                            contents=contents,
                            config=generate_content_config,
                        ):
                            if (
                                not chunk.candidates
                                or not chunk.candidates[0].content
                                or not chunk.candidates[0].content.parts
                            ):
                                continue
                            part = chunk.candidates[0].content.parts[0]
                            if getattr(part, 'inline_data', None) and getattr(part.inline_data, 'data', None):
                                target_path = output_path if file_index == 0 else output_path.with_stem(f"{output_path.stem}_{file_index}")
                                file_index += 1
                                data_buffer = part.inline_data.data
                                with open(target_path, "wb") as f:
                                    f.write(data_buffer)
                                logger.info(f"Generated image (Google) saved to: {target_path}")
                            elif getattr(chunk, 'text', None):
                                emitted_text_parts.append(chunk.text)

                        # Upload the generated image(s) to S3 and get URLs
                        result_files = []
                        if self.current_execution_id:
                            result_files = upload_task_result_files(downloads_path, self.current_execution_id)
                        uploaded_file_info = None
                        for file_info in result_files:
                            if file_info.get('filename') == params.output_file_name:
                                uploaded_file_info = file_info
                                break

                        if uploaded_file_info and uploaded_file_info.get('url'):
                            success_msg = f"✅ Image {params.output_file_name} generated successfully using {model_to_use}! It has been uploaded and available at {uploaded_file_info['url']}."
                        else:
                            success_msg = f"✅ Image {params.output_file_name} generated successfully using {model_to_use} and saved to downloads folder!"

                        if emitted_text_parts:
                            success_msg += "\n\n" + "".join(emitted_text_parts)
                        return ActionResult(extracted_content=success_msg)
                    else:
                        # Use OpenAI client for other models (not gpt-image-1 or FLUX)
                        logger.info(f"Generating new image from prompt with model: {model_to_use}...")
                        result = client.images.generate(
                            model=model_to_use,
                            prompt=params.prompt,
                            size=params.size,
                            quality=params.quality
                        )
                elif len(input_images) == 1:
                    # Edit single image
                    if model_to_use == "gpt-image-1":
                        # Use Azure AI Services for gpt-image-1 model
                        logger.info(f"Editing image with Azure gpt-image-1 model...")
                        
                        import requests
                        
                        url = f"{azure_endpoint}/openai/deployments/{deployment_name}/images/edits"
                        headers = {
                            "api-key": api_key
                        }
                        
                        edit_body = {
                            "prompt": params.prompt,
                            "n": 1,
                            "size": params.size,
                            "quality": params.quality
                        }
                        
                        # Prepare the image file for upload
                        with open(input_images[0], "rb") as img_input:
                            files = {
                                "image": (params.input_file_names[0], img_input, "image/png")
                            }
                            
                            response = requests.post(url, headers=headers, data=edit_body, files=files, params={"api-version": "2025-04-01-preview"})
                        
                        if response.status_code != 200:
                            return ActionResult(error=f"Azure AI Services API error: {response.status_code} - {response.text}")
                        
                        result_data = response.json()
                        if not result_data.get('data') or len(result_data['data']) == 0:
                            return ActionResult(error="No image data received from Azure AI Services API")
                        
                        # Extract the image data
                        image_base64 = result_data['data'][0].get('b64_json')
                        if not image_base64:
                            return ActionResult(error="No b64_json data in Azure AI Services response")
                        
                        # Save the image
                        image_bytes = base64.b64decode(image_base64)
                        with open(output_path, "wb") as f:
                            f.write(image_bytes)
                        
                        logger.info(f"Edited image with Azure gpt-image-1 saved to: {output_path}")
                        
                        # Upload the generated image to S3 and get the URL
                        result_files = []
                        if self.current_execution_id:
                            result_files = upload_task_result_files(downloads_path, self.current_execution_id)
                        
                        # Find the uploaded file info for our generated image
                        uploaded_file_info = None
                        for file_info in result_files:
                            if file_info.get('filename') == params.output_file_name:
                                uploaded_file_info = file_info
                                break
                        
                        # Create success message
                        if uploaded_file_info and uploaded_file_info.get('url'):
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using Azure {model_to_use}! It has been uploaded and available at {uploaded_file_info['url']}. You MUST use the URL to refer this image in any HTML or Markdown content."
                            logger.info(f"Edited image uploaded to S3: {uploaded_file_info['url']}")
                        else:
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using Azure {model_to_use} and saved to downloads folder!"
                            logger.warning("Could not retrieve S3 URL for edited image")
                        
                        return ActionResult(extracted_content=success_msg)
                    elif model_to_use == "FLUX.1-Kontext-pro":
                        # Use direct HTTP request for Azure AI Services FLUX model
                        logger.info(f"Editing image with FLUX model using direct HTTP request...")
                        
                        import requests
                        
                        url = f"{azure_endpoint}/openai/deployments/{deployment_name}/images/edits"
                        headers = {
                            "api-key": api_key
                        }
                        
                        # Prepare the image file for upload
                        with open(input_images[0], "rb") as img_input:
                            files = {
                                "image": (params.input_file_names[0], img_input, "image/png"),
                                "model": (None, azure_model_name),
                                "prompt": (None, params.prompt)
                            }
                            
                            response = requests.post(url, headers=headers, files=files, params={"api-version": "2025-04-01-preview"})
                        
                        if response.status_code != 200:
                            return ActionResult(error=f"Azure AI Services API error: {response.status_code} - {response.text}")
                        
                        result_data = response.json()
                        if not result_data.get('data') or len(result_data['data']) == 0:
                            return ActionResult(error="No image data received from Azure AI Services API")
                        
                        # Extract the image data
                        image_base64 = result_data['data'][0].get('b64_json')
                        if not image_base64:
                            return ActionResult(error="No b64_json data in Azure AI Services response")
                        
                        # Save the image
                        image_bytes = base64.b64decode(image_base64)
                        with open(output_path, "wb") as f:
                            f.write(image_bytes)
                        
                        logger.info(f"Edited image with FLUX model saved to: {output_path}")
                        
                        # Upload the generated image to S3 and get the URL
                        result_files = []
                        if self.current_execution_id:
                            result_files = upload_task_result_files(downloads_path, self.current_execution_id)
                        
                        # Find the uploaded file info for our generated image
                        uploaded_file_info = None
                        for file_info in result_files:
                            if file_info.get('filename') == params.output_file_name:
                                uploaded_file_info = file_info
                                break
                        
                        # Create success message
                        if uploaded_file_info and uploaded_file_info.get('url'):
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using FLUX.1-Kontext-pro! It has been uploaded and available at {uploaded_file_info['url']}. You MUST use the URL to refer this image in any HTML or Markdown content."
                            logger.info(f"Edited image uploaded to S3: {uploaded_file_info['url']}")
                        else:
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using FLUX.1-Kontext-pro and saved to downloads folder! "
                            logger.warning("Could not retrieve S3 URL for edited image")
                        
                        return ActionResult(extracted_content=success_msg)
                    elif google_client is not None:
                        # Google Nano Banana with one input image
                        logger.info("Editing image with Google Nano Banana using input image and prompt")
                        from google.genai import types as google_types  # type: ignore
                        # Prepare contents: image then text
                        image_path = input_images[0]
                        mime = "image/png"
                        if str(image_path).lower().endswith(".jpg") or str(image_path).lower().endswith(".jpeg"):
                            mime = "image/jpeg"
                        with open(image_path, "rb") as f:
                            image_bytes = f.read()
                        contents = [
                            google_types.Content(
                                role="user",
                                parts=[
                                    google_types.Part.from_bytes(mime_type=mime, data=image_bytes),
                                ],
                            ),
                            google_types.Content(
                                role="user",
                                parts=[google_types.Part.from_text(text=params.prompt)],
                            ),
                        ]
                        generate_content_config = google_types.GenerateContentConfig(
                            response_modalities=["IMAGE", "TEXT"]
                        )

                        file_index = 0
                        emitted_text_parts = []
                        for chunk in google_client.models.generate_content_stream(
                            model=google_model_name,
                            contents=contents,
                            config=generate_content_config,
                        ):
                            if (
                                not chunk.candidates
                                or not chunk.candidates[0].content
                                or not chunk.candidates[0].content.parts
                            ):
                                continue
                            part = chunk.candidates[0].content.parts[0]
                            if getattr(part, 'inline_data', None) and getattr(part.inline_data, 'data', None):
                                target_path = output_path if file_index == 0 else output_path.with_stem(f"{output_path.stem}_{file_index}")
                                file_index += 1
                                data_buffer = part.inline_data.data
                                with open(target_path, "wb") as f:
                                    f.write(data_buffer)
                                logger.info(f"Edited image (Google) saved to: {target_path}")
                            elif getattr(chunk, 'text', None):
                                emitted_text_parts.append(chunk.text)

                        # Upload and return
                        result_files = []
                        if self.current_execution_id:
                            result_files = upload_task_result_files(downloads_path, self.current_execution_id)
                        uploaded_file_info = None
                        for file_info in result_files:
                            if file_info.get('filename') == params.output_file_name:
                                uploaded_file_info = file_info
                                break
                        if uploaded_file_info and uploaded_file_info.get('url'):
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using {model_to_use}! It has been uploaded and available at {uploaded_file_info['url']}."
                        else:
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using {model_to_use} and saved to downloads folder!"
                        if emitted_text_parts:
                            success_msg += "\n\n" + "".join(emitted_text_parts)
                        return ActionResult(extracted_content=success_msg)
                    else:
                        # Use OpenAI client for other models (not gpt-image-1 or FLUX)
                        logger.info("Editing single input image...")
                        with open(input_images[0], "rb") as img_input:
                            result = client.images.edit(
                                model=model_to_use,
                                image=img_input,
                                prompt=params.prompt,
                                size=params.size
                            )
                else:
                    # Edit multiple images (combine them)
                    if model_to_use == "gpt-image-1":
                        # Use Azure AI Services for gpt-image-1 model
                        logger.info(f"Editing multiple images with Azure gpt-image-1 model...")
                        
                        import requests
                        
                        url = f"{azure_endpoint}/openai/deployments/{deployment_name}/images/edits"
                        headers = {
                            "api-key": api_key
                        }
                        
                        edit_body = {
                            "prompt": params.prompt,
                            "n": 1,
                            "size": params.size,
                            "quality": params.quality
                        }
                        
                        # Prepare the image files for upload
                        with open(input_images[0], "rb") as img1:
                            files = {
                                "image": (params.input_file_names[0], img1, "image/png")
                            }
                            
                            # Add additional images if they exist
                            for i, img_path in enumerate(input_images[1:], 1):
                                with open(img_path, "rb") as img:
                                    files[f"image_{i}"] = (params.input_file_names[i], img, "image/png")
                            
                            response = requests.post(url, headers=headers, data=edit_body, files=files, params={"api-version": "2025-04-01-preview"})
                        
                        if response.status_code != 200:
                            return ActionResult(error=f"Azure AI Services API error: {response.status_code} - {response.text}")
                        
                        result_data = response.json()
                        if not result_data.get('data') or len(result_data['data']) == 0:
                            return ActionResult(error="No image data received from Azure AI Services API")
                        
                        # Extract the image data
                        image_base64 = result_data['data'][0].get('b64_json')
                        if not image_base64:
                            return ActionResult(error="No b64_json data in Azure AI Services response")
                        
                        # Save the image
                        image_bytes = base64.b64decode(image_base64)
                        with open(output_path, "wb") as f:
                            f.write(image_bytes)
                        
                        logger.info(f"Edited multiple images with Azure gpt-image-1 saved to: {output_path}")
                        
                        # Upload the generated image to S3 and get the URL
                        result_files = []
                        if self.current_execution_id:
                            result_files = upload_task_result_files(downloads_path, self.current_execution_id)
                        
                        # Find the uploaded file info for our generated image
                        uploaded_file_info = None
                        for file_info in result_files:
                            if file_info.get('filename') == params.output_file_name:
                                uploaded_file_info = file_info
                                break
                        
                        # Create success message
                        if uploaded_file_info and uploaded_file_info.get('url'):
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using Azure {model_to_use}! It has been uploaded and available at {uploaded_file_info['url']}. You MUST use the URL to refer this image in any HTML or Markdown content."
                            logger.info(f"Edited image uploaded to S3: {uploaded_file_info['url']}")
                        else:
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using Azure {model_to_use} and saved to downloads folder!"
                            logger.warning("Could not retrieve S3 URL for edited image")
                        
                        return ActionResult(extracted_content=success_msg)
                    elif model_to_use == "FLUX.1-Kontext-pro":
                        # Use direct HTTP request for Azure AI Services FLUX model
                        logger.info(f"Editing multiple images with FLUX model using direct HTTP request...")
                        
                        import requests
                        
                        url = f"{azure_endpoint}/openai/deployments/{deployment_name}/images/edits"
                        headers = {
                            "api-key": api_key
                        }
                        
                        # Prepare the image files for upload
                        with open(input_images[0], "rb") as img1, open(input_images[1], "rb") as img2:
                            files = {
                                "image": (params.input_file_names[0], img1, "image/png"),
                                "model": (None, azure_model_name),
                                "instructions": (None, params.prompt)
                            }
                            
                            # Add additional images if they exist
                            for i, img_path in enumerate(input_images[2:], 2):
                                with open(img_path, "rb") as img:
                                    files[f"image_{i}"] = (params.input_file_names[i], img, "image/png")
                            
                            response = requests.post(url, headers=headers, files=files, params={"api-version": "2025-04-01-preview"})
                        
                        if response.status_code != 200:
                            return ActionResult(error=f"Azure AI Services API error: {response.status_code} - {response.text}")
                        
                        result_data = response.json()
                        if not result_data.get('data') or len(result_data['data']) == 0:
                            return ActionResult(error="No image data received from Azure AI Services API")
                        
                        # Extract the image data
                        image_base64 = result_data['data'][0].get('b64_json')
                        if not image_base64:
                            return ActionResult(error="No b64_json data in Azure AI Services response")
                        
                        # Save the image
                        image_bytes = base64.b64decode(image_base64)
                        with open(output_path, "wb") as f:
                            f.write(image_bytes)
                        
                        logger.info(f"Edited multiple images with FLUX model saved to: {output_path}")
                        
                        # Upload the generated image to S3 and get the URL
                        result_files = []
                        if self.current_execution_id:
                            result_files = upload_task_result_files(downloads_path, self.current_execution_id)
                        
                        # Find the uploaded file info for our generated image
                        uploaded_file_info = None
                        for file_info in result_files:
                            if file_info.get('filename') == params.output_file_name:
                                uploaded_file_info = file_info
                                break
                        
                        # Create success message
                        if uploaded_file_info and uploaded_file_info.get('url'):
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using FLUX.1-Kontext-pro! It has been uploaded and available at {uploaded_file_info['url']}. You MUST use the URL to refer this image in any HTML or Markdown content."
                            logger.info(f"Edited image uploaded to S3: {uploaded_file_info['url']}")
                        else:
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using FLUX.1-Kontext-pro and saved to downloads folder! "
                            logger.warning("Could not retrieve S3 URL for edited image")
                        
                        return ActionResult(extracted_content=success_msg)
                    elif google_client is not None:
                        # Google Nano Banana with multiple images: send all as parts
                        logger.info("Editing multiple images with Google Nano Banana")
                        from google.genai import types as google_types  # type: ignore
                        parts_list = []
                        for idx, img_path in enumerate(input_images):
                            mime = "image/png"
                            lower = str(img_path).lower()
                            if lower.endswith(".jpg") or lower.endswith(".jpeg"):
                                mime = "image/jpeg"
                            with open(img_path, "rb") as f:
                                parts_list.append(google_types.Part.from_bytes(mime_type=mime, data=f.read()))
                        contents = [
                            google_types.Content(role="user", parts=parts_list),
                            google_types.Content(role="user", parts=[google_types.Part.from_text(text=params.prompt)]),
                        ]
                        generate_content_config = google_types.GenerateContentConfig(
                            response_modalities=["IMAGE", "TEXT"]
                        )

                        file_index = 0
                        emitted_text_parts = []
                        for chunk in google_client.models.generate_content_stream(
                            model=google_model_name,
                            contents=contents,
                            config=generate_content_config,
                        ):
                            if (
                                not chunk.candidates
                                or not chunk.candidates[0].content
                                or not chunk.candidates[0].content.parts
                            ):
                                continue
                            part = chunk.candidates[0].content.parts[0]
                            if getattr(part, 'inline_data', None) and getattr(part.inline_data, 'data', None):
                                target_path = output_path if file_index == 0 else output_path.with_stem(f"{output_path.stem}_{file_index}")
                                file_index += 1
                                data_buffer = part.inline_data.data
                                with open(target_path, "wb") as f:
                                    f.write(data_buffer)
                                logger.info(f"Edited images (Google) saved to: {target_path}")
                            elif getattr(chunk, 'text', None):
                                emitted_text_parts.append(chunk.text)

                        # Upload and return
                        result_files = []
                        if self.current_execution_id:
                            result_files = upload_task_result_files(downloads_path, self.current_execution_id)
                        uploaded_file_info = None
                        for file_info in result_files:
                            if file_info.get('filename') == params.output_file_name:
                                uploaded_file_info = file_info
                                break
                        if uploaded_file_info and uploaded_file_info.get('url'):
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using {model_to_use}! It has been uploaded and available at {uploaded_file_info['url']}."
                        else:
                            success_msg = f"✅ Image {params.output_file_name} edited successfully using {model_to_use} and saved to downloads folder!"
                        if emitted_text_parts:
                            success_msg += "\n\n" + "".join(emitted_text_parts)
                        return ActionResult(extracted_content=success_msg)
                    else:
                        # Use OpenAI client for other models (not gpt-image-1 or FLUX)
                        logger.info("Editing multiple input images...")
                        # Open all images and pass them to OpenAI
                        image_files = []
                        for img_path in input_images:
                            image_files.append(open(img_path, "rb"))
                        
                        try:
                            result = client.images.edit(
                                model=model_to_use,
                                image=image_files,
                                prompt=params.prompt,
                                size=params.size
                            )
                        finally:
                            # Close all opened files
                            for img_file in image_files:
                                img_file.close()
                
                # Save the generated image (for OpenAI default model only)
                if result.data and len(result.data) > 0:
                    image_base64 = result.data[0].b64_json
                    image_bytes = base64.b64decode(image_base64)
                    
                    # Save the image
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)
                    
                    logger.info(f"Generated image saved to: {output_path}")
                    
                    # Upload the generated image to S3 and get the URL
                    result_files = []
                    if self.current_execution_id:
                        result_files = upload_task_result_files(downloads_path, self.current_execution_id)
                    
                    # Find the uploaded file info for our generated image
                    uploaded_file_info = None
                    for file_info in result_files:
                        if file_info.get('filename') == params.output_file_name:
                            uploaded_file_info = file_info
                            break
                    
                    # Create success message
                    if uploaded_file_info and uploaded_file_info.get('url'):
                        success_msg = f"✅ Image {params.output_file_name} generated successfully using {model_to_use}! It has been uploaded and available at {uploaded_file_info['url']}. You MUST use the URL to refer this image in any HTML or Markdown content."
                        logger.info(f"Generated image uploaded to S3: {uploaded_file_info['url']}")
                    else:
                        success_msg = f"✅ Image {params.output_file_name} generated successfully using {model_to_use} and saved to downloads folder! "
                        logger.warning("Could not retrieve S3 URL for generated image")
                    
                    return ActionResult(extracted_content=success_msg)
                else:
                    return ActionResult(error="No image data received from OpenAI API")

            except Exception as e:
                logger.error(f"Error generating image: {e}")
                return ActionResult(error=f"Failed to generate image: {str(e)}")

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
    parser = argparse.ArgumentParser(description='Run a task with a web agent.')
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
    parser.add_argument('--has-attachments', action='store_true', help='Task has attachments')
    parser.add_argument('--create-video', action='store_true', help='Create video recording of task execution')
    parser.add_argument('--video-model', help='Video model to use for video generation (veo-3.0-generate-preview, gen4_turbo, or kling-v2.1-std)')
    parser.add_argument('--image-model', help='Image model to use for image generation (openai-image-1 or FLUX.1-Kontext-pro)')
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
            lead_list_identifier=args.lead_list_identifier,
            has_attachments=args.has_attachments,
            create_video=args.create_video,
            video_model=args.video_model,
            image_model=args.image_model
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
        try:
            # Shadow usage metering flush — fail-open, never affects the task.
            if getattr(agent, 'usage_reporter', None):
                agent.usage_reporter.flush(args.user_id, args.task_id)
        except Exception:
            pass
        await agent.cleanup()

if __name__ == '__main__':
    asyncio.run(main()) 
