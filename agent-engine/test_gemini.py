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
from dotenv import load_dotenv
from pydantic import SecretStr
from browser_use import Agent

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def test_gemini():
    """Test the Google Gemini integration"""
    # Load environment variables from .env file
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        sys.exit(1)
    
    model_name = "gemini-2.0-flash"
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

async def test_with_browser_use_async():
    """Test using Gemini with browser-use for web automation"""
    # Load environment variables from .env file
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        sys.exit(1)
    
    model_name = "gemini-2.0-flash"
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
        
        # Create downloads directory
        downloads_path = Path('downloads/test_gemini')
        downloads_path.mkdir(parents=True, exist_ok=True)
        
        # Define a simple web automation task
        task = """
        1. Go to https://www.example.com
        2. Read the main heading text
        3. Return the heading text
        """
        
        # Initialize Agent with the ChatGoogleGenerativeAI model
        logger.info("Initializing Agent with Gemini model...")
        agent = Agent(
            task=task,
            llm=chat,
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
        
        logger.info("Browser-use test completed successfully!")
        return True
        
    except Exception as e:
        logger.error(f"Error testing with browser-use: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_with_browser_use():
    """Wrapper to run the async browser-use test"""
    return asyncio.run(test_with_browser_use_async())

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Test Google Gemini integration')
    parser.add_argument('--browser-use', action='store_true', help='Test with browser-use for web automation')
    args = parser.parse_args()
    
    if args.browser_use:
        success = test_with_browser_use()
        if success:
            print("\nBrowser-use test completed successfully!")
        else:
            print("\nBrowser-use test failed. Please check the logs for details.")
    else:
        success = test_gemini()
        if success:
            print("\nTest completed successfully!")
        else:
            print("\nTest failed. Please check the logs for details.") 