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
        page = await browser.get_current_page()
        await page.wait_for_load_state('domcontentloaded')
        
        # Try iframe first, then main page
        contexts = []
        iframe = await page.query_selector('iframe')
        if iframe and (frame := await iframe.content_frame()):
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
                    await elements.first.set_input_files(path)
                    return ActionResult(extracted_content=f'Successfully uploaded {TEST_FILE.name}')
        
        return ActionResult(error="Could not find file input element")
            
    except Exception as e:
        logger.error(f'Error in upload_file: {str(e)}')
        return ActionResult(error=f'Failed to upload file: {str(e)}')

@controller.registry.action('Close file dialog')
async def close_file_dialog(browser: BrowserContext):
    page = await browser.get_current_page()
    await page.keyboard.press('Escape')
    return ActionResult(extracted_content='Closed file dialog')

async def main():
    # Define the tasks to test
    tasks = [
        'go to https://huggingface.co/spaces/franciszzj/Leffa and upload an image to the Person Image',
        'Visit https://facetoonshop.com/video-creator.html, upload an image'
    ]

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

    try:
        # Test each task
        for i, task in enumerate(tasks, 1):
            logger.info(f"\n=== Testing Task {i} ===")
            logger.info(f"Task: {task}")
            
            # Create a new browser instance for each task
            browser = Browser(
                config=BrowserConfig(
                    headless=False
                )
            )
            
            # Create the agent with increased max steps
            agent = Agent(
                task=task,
                llm=model,
                controller=controller,
                browser=browser
            )
            
            try:
                # Run the agent with increased max steps for complex tasks
                result = await agent.run(max_steps=10)  # Increased from 5 to 10
                logger.info(f"Task {i} result: {result}")
            except Exception as e:
                logger.error(f"Error during task {i} execution: {str(e)}")
                if "net::" in str(e) or "timeout" in str(e).lower():  # Network or timeout error
                    logger.info("Network/timeout error detected. Retrying...")
                    try:
                        # Try again with a fresh browser instance
                        browser = Browser(
                            config=BrowserConfig(
                                headless=False
                            )
                        )
                        agent = Agent(
                            task=task,
                            llm=model,
                            controller=controller,
                            browser=browser
                        )
                        result = await agent.run(max_steps=10)
                        logger.info(f"Retry successful! Task {i} result: {result}")
                    except Exception as retry_e:
                        logger.error(f"Retry also failed: {str(retry_e)}")
            finally:
                # Wait for user input before moving to next task
                input(f'Press Enter to {"continue" if i < len(tasks) else "close"}...')
                # Clean up
                await browser.close()
                
    except Exception as e:
        logger.error(f"Error in main: {str(e)}")

if __name__ == '__main__':
    asyncio.run(main()) 