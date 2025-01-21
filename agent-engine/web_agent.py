#!/usr/bin/env python3
import argparse
import json
import sys
import os
from typing import Dict, Any
import browser_use
from browser_use import Agent
from browser_use.browser.browser import Browser, BrowserConfig
from langchain_aws import ChatBedrock
import boto3
from botocore.config import Config
from dotenv import load_dotenv
import logging

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configure AWS client with no retries
aws_config = Config(
    retries = dict(
        max_attempts = 1  # Disable AWS's internal retries
    )
)

# Initialize AWS Bedrock client
bedrock = boto3.client(
    service_name='bedrock-runtime',
    region_name=os.getenv('AWS_REGION', 'us-west-2'),  # Changed default to us-west-2
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
    config=aws_config
)

def get_llm():
    """Initialize the language model using AWS Bedrock"""
    try:
        return ChatBedrock(
            client=bedrock,
            model_id="anthropic.claude-3-5-sonnet-20241022-v2:0",
            model_kwargs={"temperature": 0.0}
        )
    except Exception as e:
        if "AccessDeniedException" in str(e):
            print("Error: The AWS user lacks permission to invoke Claude model in Bedrock.")
            print("Please ensure the user has the necessary permissions and the model exists.")
            sys.exit(1)
        raise

class WebAgent:
    def __init__(self):
        self.browser = None
        self.agent = None
        self.llm = get_llm()
        self.task = None
        self.action_history = []

    async def setup(self):
        """Initialize the browser instance"""
        if not self.task:
            raise ValueError("Task must be set before setup")
            
        self.browser = Browser(config=BrowserConfig())
        self.agent = Agent(
            task=self.task,  # Use the stored task
            llm=self.llm,
            browser=self.browser,
            use_vision=True,
            max_actions_per_step=1
        )

    async def cleanup(self):
        """Clean up browser resources"""
        if self.browser:
            await self.browser.close()

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
            if hasattr(self.agent, 'history'):
                logger.info("Agent has history attribute")
                history = self.agent.history.history
                if history:
                    logger.info(f"History length: {len(history)}")
                    if history[-1].result:
                        logger.info("Last history entry has result")
                        # Get the extracted content from the last action result
                        action_result = history[-1].result[0]  # First result from the last action
                        logger.info(f"Action result: {action_result}")
                        if hasattr(action_result, 'is_done') and action_result.is_done:
                            last_message = action_result.extracted_content
                            logger.info(f"Extracted summary: {last_message}")
                        else:
                            logger.warning(f"Last action result is not done: {action_result}")
                    else:
                        logger.warning("Last history entry has no result")
                else:
                    logger.warning("History is empty")
            else:
                logger.warning("Agent has no history attribute")
            
            return {
                "success": True,
                "message": "Task completed successfully",
                "summary": last_message if last_message else "Task completed but no summary available"
            }
        except Exception as e:
            logger.error(f"Error in execute_task: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": "Task execution failed"
            }

async def main():
    parser = argparse.ArgumentParser(description='Web Agent for task automation')
    parser.add_argument('--task_id', required=True, help='Task ID')
    parser.add_argument('--prompt', required=True, help='Task prompt')
    args = parser.parse_args()

    agent = WebAgent()
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