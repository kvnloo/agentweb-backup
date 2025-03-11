#!/usr/bin/env python3
"""
Test script for Pale Blue Dot DeepSeek integration.
This script creates a ChatOpenAI instance and tests basic functionality.
"""

import os
import sys
import logging
import asyncio
from pathlib import Path
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from pydantic import SecretStr
from browser_use import Agent

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def test_pld_deepseek():
    """Test the Pale Blue Dot DeepSeek integration"""
    # Load environment variables from .env file
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('PLD_DEEPSEEK_API_KEY')
    if not api_key:
        logger.error("PLD_DEEPSEEK_API_KEY environment variable is not set")
        sys.exit(1)
    
    model_name = "DeepSeek-R1"
    logger.info(f"Testing PLD DeepSeek with model: {model_name}")
    
    try:
        # Create ChatOpenAI instance
        chat = ChatOpenAI(
            base_url='https://www.palebluedot.ai/api',
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
        
        # Test with a simple prompt
        logger.info("Sending test prompt to DeepSeek model...")
        response = chat.invoke("What is the capital of France?")
        
        # Print the response
        logger.info("Response received:")
        logger.info(response.content)
        
        logger.info("Test completed successfully!")
        return True
        
    except Exception as e:
        logger.error(f"Error testing PLD DeepSeek: {e}")
        return False

def test_with_different_base_urls():
    """Test with different base URL configurations to find the correct one"""
    # Load environment variables from .env file
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('PLD_DEEPSEEK_API_KEY')
    if not api_key:
        logger.error("PLD_DEEPSEEK_API_KEY environment variable is not set")
        sys.exit(1)
    
    model_name = "DeepSeek-R1"
    
    # Different base URLs to try
    base_urls = [
        'https://www.palebluedot.ai/api',
        'https://www.palebluedot.ai',
        'https://api.palebluedot.ai',
        'https://www.palebluedot.ai/api/v1'
    ]
    
    for base_url in base_urls:
        logger.info(f"Testing with base_url: {base_url}")
        try:
            # Create ChatOpenAI instance
            chat = ChatOpenAI(
                base_url=base_url,
                model=model_name,
                api_key=SecretStr(api_key),
                temperature=0.0
            )
            
            # Test with a simple prompt
            response = chat.invoke("What is the capital of France?")
            
            # Print the response
            logger.info(f"Success with base_url: {base_url}")
            logger.info(f"Response: {response.content}")
            return base_url
            
        except Exception as e:
            logger.error(f"Failed with base_url {base_url}: {e}")
    
    logger.error("All base URLs failed")
    return None

async def test_with_browser_use_async():
    """Test using ChatOpenAI with browser-use for web automation, following web_agent.py pattern"""
    # Load environment variables from .env file
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('PLD_DEEPSEEK_API_KEY')
    if not api_key:
        logger.error("PLD_DEEPSEEK_API_KEY environment variable is not set")
        sys.exit(1)
    
    model_name = "DeepSeek-R1"
    logger.info(f"Testing PLD DeepSeek with browser-use using model: {model_name}")
    
    try:
        # Create ChatOpenAI instance
        chat = ChatOpenAI(
            base_url='https://www.palebluedot.ai/api',
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
        
        # Create downloads directory
        downloads_path = Path('downloads/test')
        downloads_path.mkdir(parents=True, exist_ok=True)
        
        # Define a simple web automation task
        task = """
        1. Go to https://www.example.com
        2. Read the main heading text
        3. Return the heading text
        """
        
        # Initialize Agent with the ChatOpenAI model
        logger.info("Initializing Agent with DeepSeek model...")
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
    
    parser = argparse.ArgumentParser(description='Test PLD DeepSeek integration')
    parser.add_argument('--find-url', action='store_true', help='Try different base URLs to find the correct one')
    parser.add_argument('--browser-use', action='store_true', help='Test with browser-use for web automation')
    args = parser.parse_args()
    
    if args.find_url:
        working_url = test_with_different_base_urls()
        if working_url:
            print(f"\nWorking base URL found: {working_url}")
            print("Update the get_pld_deepseek_llm function in task_utils.py with this URL")
        else:
            print("\nNo working base URL found. Please check your API key and network connection.")
    elif args.browser_use:
        success = test_with_browser_use()
        if success:
            print("\nBrowser-use test completed successfully!")
        else:
            print("\nBrowser-use test failed. Please check the logs for details.")
    else:
        success = test_pld_deepseek()
        if success:
            print("\nTest completed successfully!")
        else:
            print("\nTest failed. Please check the logs for details.") 