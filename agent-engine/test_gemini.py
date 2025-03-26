#!/usr/bin/env python3
"""
Test script for Google Gemini integration.
This script creates a ChatGoogleGenerativeAI instance and tests basic functionality.
"""

import os
import sys
import logging
import asyncio
from pathlib import Path
from typing import List
from dotenv import load_dotenv
from pydantic import SecretStr, BaseModel
from browser_use import Agent, ActionResult, Controller
from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContextConfig, BrowserContext

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create a controller for custom actions
controller = Controller()

class NameList(BaseModel):
    names: List[str]

@controller.action('Say hello to someone')
async def hello(name: str, browser: BrowserContext):
    """Say hello to the specified person"""
    try:
        return ActionResult(extracted_content=f"Hello, {name}!")
    except Exception as e:
        return ActionResult(error=str(e))

@controller.action('Say hello to a list of people', param_model=NameList)
async def hello_list(name_list: NameList, browser: BrowserContext):
    """Say hello to a list of people"""
    try:
        greetings = [f"Hello, {name}!" for name in name_list.names]
        return ActionResult(extracted_content="\n".join(greetings))
    except Exception as e:
        return ActionResult(error=str(e))

def test_gemini(model_name="gemini-2.0-flash"):
    """Test the Google Gemini integration"""
    # Load environment variables from .env file
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        sys.exit(1)
    
    logger.info(f"Testing Google Gemini with model: {model_name}")
    
    try:
        # Import here to avoid requiring the package for all users
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI
        except ImportError:
            logger.error("langchain_google_genai package is not installed. Install it with: pip install langchain-google-genai")
            sys.exit(1)
        
        # Create ChatGoogleGenerativeAI instance
        chat = ChatGoogleGenerativeAI(
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
        
        # Test with a simple prompt
        logger.info("Sending test prompt to Gemini model...")
        response = chat.invoke("What is the capital of France?")
        
        # Print the response
        logger.info("Response received:")
        logger.info(response.content)
        
        logger.info("Test completed successfully!")
        return True
        
    except Exception as e:
        logger.error(f"Error testing Gemini: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

async def test_with_browser_use_async(model_name="gemini-2.0-flash"):
    """Test using Gemini with browser-use for web automation"""
    # Load environment variables from .env file
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        sys.exit(1)
    
    logger.info(f"Testing Google Gemini with browser-use using model: {model_name}")
    
    try:
        # Import here to avoid requiring the package for all users
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI
        except ImportError:
            logger.error("langchain_google_genai package is not installed. Install it with: pip install langchain-google-genai")
            sys.exit(1)
        
        # Create ChatGoogleGenerativeAI instance
        chat = ChatGoogleGenerativeAI(
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
        
        # Create browser instance
        browser = Browser(
            config=BrowserConfig(
                new_context_config=BrowserContextConfig(
                    viewport_expansion=0,
                )
            )
        )
        
        # Create downloads directory
        downloads_path = Path('downloads/test_gemini')
        downloads_path.mkdir(parents=True, exist_ok=True)
        
        # Define a simple web automation task
        task = """
        1. Go to https://www.example.com
        2. Use the hello_list function to say hello to ["World", "Python", "Gemini"]
        3. Return the greeting messages
        """
        
        # Initialize Agent with the ChatGoogleGenerativeAI model and controller
        logger.info("Initializing Agent with Gemini model...")
        agent = Agent(
            task=task,
            llm=chat,
            controller=controller,
            browser=browser,
            use_vision=False
        )
        
        # Run the agent
        logger.info("Executing browser automation task...")
        result = await agent.run(max_steps=25)
        
        # Check if task completed successfully
        task_is_done = result.is_done()
        
        # Get agent message
        agent_message = None
        if task_is_done:
            agent_message = result.history[-1].result[-1].extracted_content
        
        if agent_message is None:
            agent_message = 'Oops! Something went wrong while running the test.'
        
        # Print the result
        logger.info(f"Task completed: {task_is_done}")
        logger.info(f"Message: {agent_message}")
        
        # Print function call history
        logger.info("\nFunction call history:")
        for step in result.history:
            if hasattr(step, 'result') and step.result:
                for action in step.result:
                    if hasattr(action, 'function_call'):
                        logger.info(f"Function called: {action.function_call}")
        
        logger.info("Browser-use test completed successfully!")
        return True
        
    except Exception as e:
        logger.error(f"Error testing with browser-use: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_with_browser_use(model_name="gemini-2.0-flash"):
    """Wrapper to run the async browser-use test"""
    return asyncio.run(test_with_browser_use_async(model_name))

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Test Google Gemini integration')
    parser.add_argument('--browser-use', action='store_true', help='Test with browser-use for web automation')
    parser.add_argument('--model', type=str, default="gemini-2.0-flash", help='Model name to use (default: gemini-2.0-flash)')
    args = parser.parse_args()
    
    if args.browser_use:
        success = test_with_browser_use(args.model)
        if success:
            print("\nBrowser-use test completed successfully!")
        else:
            print("\nBrowser-use test failed. Please check the logs for details.")
    else:
        success = test_gemini(args.model)
        if success:
            print("\nTest completed successfully!")
        else:
            print("\nTest failed. Please check the logs for details.") 