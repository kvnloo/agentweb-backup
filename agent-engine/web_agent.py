#!/usr/bin/env python3
import argparse
import json
import sys
import os
from typing import Dict, Any
import browser_use
from browser_use import Agent, Controller
from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContextConfig
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

def decrypt_password(encrypted_password: str, user_id: str) -> str:
    """Decrypt password using JWT_SECRET"""
    try:
        import jwt
        decoded = jwt.decode(encrypted_password, os.getenv('JWT_SECRET'), algorithms=['HS256'])
        if decoded['userId'] != user_id:
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

@controller.action('Get login credentials by domain')
def get_login_credentials(domain: str, user_id: str):
    """Get login credentials for a domain from the database"""
    if not user_id:
        raise Exception("User ID not provided")
    if not domain:
        return ActionResult(error=f"Please provide a domain")
    logger.info(f"Getting login credentials for domain {domain} under user {user_id}")
        
    table = dynamodb.Table(f'{TABLE_PREFIX}AW-Configs')
    response = table.query(
        KeyConditionExpression='userId = :userId',
        FilterExpression='website = :website',
        ExpressionAttributeValues={
            ':userId': user_id,
            ':website': domain
        }
    )

    items = response.get('Items', [])
    if not items:
        return ActionResult(error=f"No credentials found for domain: {domain}")

    config = items[0]
    try:
        decrypted_password = decrypt_password(config['password'], user_id)
        return ActionResult(extracted_content=f"username: {config['username']}, password: {decrypted_password}")
    except Exception as e:
        return ActionResult(error=f"Error getting credentials: {str(e)}")

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
        self.cookie_sync = CookieSync() if user_id else None

    def _get_cookies_path(self):
        """Get the path to the user's cookies file"""
        if not self.user_id:
            return None
        return str(self.context_dir / f"{self.user_id}_cookies.json")

    async def setup(self):
        """Initialize the browser instance"""
        if not self.task:
            raise ValueError("Task must be set before setup")
        
        # Create browser context config with user-specific cookies file
        cookies_path = self._get_cookies_path()
        if cookies_path and self.cookie_sync:
            # Try to download cookies from S3 before starting
            self.cookie_sync.download_cookies(self.user_id, cookies_path)
            
        context_config = BrowserContextConfig(
            cookies_file=cookies_path
        )
        if cookies_path:
            logger.info(f"Using cookies file for user {self.user_id}: {cookies_path}")

        # Get headless mode from environment variable, default to False if not set
        headless = os.getenv('BROWSER_HEADLESS', 'true').lower() == 'true'
        browser_config = BrowserConfig(new_context_config=context_config, headless=headless)
        self.browser = Browser(config=browser_config)
        self.agent = Agent(
            task=self.task,
            llm=self.llm,
            controller=controller,
            browser=self.browser,
            use_vision=global_use_vision,
            max_failures=5,  # Increase max retries
            retry_delay=60    # retry delay in seconds
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
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")
            raise

    def get_action_history(self):
        """Get the list of actions performed by the agent"""
        if not self.agent:
            return []
        return self.agent.action_history

    async def execute_task(self, prompt: str) -> Dict[str, Any]:
        """Execute a task based on the natural language prompt"""
        try:
            self.task = prompt  # Store the task
            await self.setup()  # Setup after we have the task
            
            # Run the agent
            await self.agent.run(max_steps=25)
            
            # Get the last message from the agent's history
            last_message = None
            task_is_done = False  # Initialize task_is_done
            
            if hasattr(self.agent, 'history'):
                history = self.agent.history.history
                if history:
                    if history[-1].result:
                        # Get the extracted content from the last action result
                        action_result = history[-1].result[0]  # First result from the last action
                        logger.info(f"Action result: {action_result}")
                        task_is_done = hasattr(action_result, 'is_done') and action_result.is_done
                        if task_is_done:
                            last_message = action_result.extracted_content
                        else:
                            last_message = action_result.error
                    else:
                        logger.warning("Last history entry has no result")
                else:
                    logger.warning("History is empty")
            else:
                logger.warning("Agent has no history attribute")
            
            return {
                "success": task_is_done,
                "summary" if task_is_done else "error": last_message if last_message else ("Task completed but no summary available" if task_is_done else "No error details available"),
                "llmName": self.llm_name
            }
        except Exception as e:
            logger.error(f"Error in execute_task: {e}")
            return {
                "success": False,
                "error": str(e),
                "llmName": self.llm_name
            }

async def main():
    parser = argparse.ArgumentParser(description='Web Agent for task automation')
    parser.add_argument('--task_id', required=True, help='Task ID')
    parser.add_argument('--prompt', required=True, help='Task prompt')
    parser.add_argument('--user_id', required=True, help='User ID')
    parser.add_argument('--llm_name', help='Full LLM name in format platform->provider->model')
    args = parser.parse_args()

    agent = WebAgent(args.user_id, args.llm_name)
    try:
        result = await agent.execute_task(args.prompt)  # Setup is called inside execute_task now
        print(json.dumps(result))
        sys.exit(0 if result["success"] else 1)
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e),
            "message": "Unexpected error occurred"
        }))
        sys.exit(1)
    finally:
        await agent.cleanup()

if __name__ == "__main__":
    import asyncio
    asyncio.run(main()) 