#!/usr/bin/env python3
import os
import sys
from pathlib import Path
import logging
import asyncio
from dotenv import load_dotenv

from browser_use import Agent, Controller
from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContext
from browser_use.agent.views import ActionResult
from langchain_openai import AzureChatOpenAI

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create a test file
TEST_FILE = Path.cwd() / 'downloads/1738251317419/american_model.png'
if not TEST_FILE.exists():
    TEST_FILE.write_text('This is a test file for upload testing')

# Initialize browser with non-headless mode for debugging
browser = Browser(
    config=BrowserConfig(
        headless=False
    )
)

controller = Controller()

@controller.registry.action('Upload file to element')
async def upload_file(index: int, browser: BrowserContext):
    path = str(TEST_FILE.absolute())
    logger.info(f"Attempting to upload file: {path}")
    
    try:
        # Get the current page
        page = await browser.get_current_page()
        
        # Get the highlight ID from the parent button
        highlight_id = f'playwright-highlight-{index}'
        logger.info(f"Looking for file input within element with highlight ID: {highlight_id}")
        
        # First try to find the element in the main page
        file_upload_el = None
        
        # Check if we're in a page with an iframe (like Hugging Face Spaces)
        iframe = await page.query_selector('iframe')
        if iframe:
            frame = await iframe.content_frame()
            if frame:
                logger.info("Found iframe, searching for file input in iframe context")
                # Find the button with the specific highlight ID and then find its file input
                button = frame.locator(f'[browser-user-highlight-id="{highlight_id}"]')
                file_upload_el = button.locator('input[type="file"]')
        else:
            # If no iframe, search in main page
            logger.info("No iframe found, searching in main page")
            button = page.locator(f'[browser-user-highlight-id="{highlight_id}"]')
            file_upload_el = button.locator('input[type="file"]')
            
        if file_upload_el is None:
            return ActionResult(error=f"Could not find file input element with highlight ID {highlight_id}")
            
        await file_upload_el.set_input_files(path)
        msg = f'Successfully uploaded file {TEST_FILE.name} to index {index}'
        logger.info(msg)
        return ActionResult(extracted_content=msg)
    except Exception as e:
        logger.error(f'Error in set_input_files: {str(e)}')
        return ActionResult(error=f'Failed to upload file to index {index}: {str(e)}')

@controller.registry.action('Close file dialog')
async def close_file_dialog(browser: BrowserContext):
    page = await browser.get_current_page()
    await page.keyboard.press('Escape')
    return ActionResult(extracted_content='Closed file dialog')

async def main():
    # You can modify this URL to test with different pages
    task = (
        'go to https://huggingface.co/spaces/franciszzj/Leffa and upload an image to the Person Image'
    )

    # Initialize Azure OpenAI model
    model = AzureChatOpenAI(
        azure_endpoint=os.getenv('AZURE_OPENAI_ENDPOINT'),
        azure_deployment=os.getenv('AZURE_OPENAI_DEPLOYMENT', 'agentweb'),
        api_key=os.getenv('AZURE_OPENAI_API_KEY'),
        api_version=os.getenv('AZURE_OPENAI_API_VERSION', '2024-02-15-preview'),
        model_name="gpt-4",  # Required parameter
        model_version="0613",  # Specify model version
        temperature=0
    )

    # Create the agent with use_vision enabled
    agent = Agent(
        task=task,
        llm=model,
        controller=controller,
        browser=browser
    )
    try:
        # Run the agent
        result = await agent.run(max_steps=5)
        logger.info(f"Task result: {result}")
    except Exception as e:
        logger.error(f"Error during agent execution: {e}")
    finally:
        # Wait for user input before closing
        input('Press Enter to close...')
        # Clean up
        await browser.close()

if __name__ == '__main__':
    asyncio.run(main()) 