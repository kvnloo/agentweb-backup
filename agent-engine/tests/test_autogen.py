#!/usr/bin/env python3
"""
Test script for autogen integration.
This script creates a DeepResearchAgent instance and tests basic functionality with different models.
"""

import os
import sys
import logging
from pathlib import Path
from typing import Dict, Any
from dotenv import load_dotenv
from pydantic import SecretStr
from autogen import config_list_from_json, filter_config
from autogen.agents.experimental import DeepResearchAgent
import contextlib
import datetime

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def test_autogen(model_name: str):
    """Test the autogen integration with a specific model
    
    Args:
        model_name: Full model name in format platform->provider->model
    """
    # Load environment variables from .env file
    load_dotenv()
    
    logger.info(f"Testing autogen with model: {model_name}")
    
    try:
        # Parse the LLM name components
        platform, provider, model = model_name.lower().split('->')
        
        # Load the base config list
        base_config = config_list_from_json(env_or_file="OAI_CONFIG_LIST")
        
        # Create filter tags based on platform and model
        filter_tags = [platform, model]
        
        # Filter the config list
        filtered_config = filter_config(base_config, {"tags": filter_tags})
        
        if not filtered_config:
            logger.error(f"No matching config found for tags {filter_tags}")
            return False
        
        # Initialize DeepResearchAgent with proper configuration
        agent = DeepResearchAgent(
            name="DeepResearchAgent",
            llm_config={"config_list": filtered_config},
            max_web_steps=10,
            max_consecutive_auto_reply=2
        )
        
        # Create a test query
        query = "What are the latest developments in quantum computing?"
        
        # Create logs directory if it doesn't exist
        os.makedirs('logs', exist_ok=True)
        
        # Create a file for stdout redirection
        output_file = f"logs/test_autogen_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
        
        # Write initial info to the output file
        with open(output_file, 'a') as f:
            f.write(f"\n=== Autogen Test Started at {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ===\n")
            f.write(f"Using LLM: {model_name}\n")
            f.write(f"Query: {query}\n")
            f.write("=" * 80 + "\n\n")
        
        # Redirect stdout to append to the file
        with open(output_file, 'a') as f:
            with contextlib.redirect_stdout(f):
                # Run the agent with proper error handling
                try:
                    # Run the agent
                    result = agent.run(
                        message=query,
                        tools=agent.tools,
                        max_turns=2,
                        user_input=False,
                        summary_method="reflection_with_llm",
                    )
                    
                    # Print the result
                    logger.info("Response received:")
                    logger.info(result.summary if hasattr(result, 'summary') else "No summary generated")
                    
                    logger.info("Test completed successfully!")
                    return True
                    
                except Exception as e:
                    logger.error(f"Error during agent.run: {str(e)}")
                    raise
                    
    except Exception as e:
        logger.error(f"Error testing autogen: {e}")
        import traceback
        try:
            logger.error(traceback.format_exc())
        except TypeError:
            # Fallback for Python 3.12 traceback formatting
            logger.error("Error details: " + str(e))
        return False

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Test autogen integration')
    parser.add_argument('--model', type=str, required=True, help='Model name in format platform->provider->model (e.g., azure->openai->gpt-4o)')
    args = parser.parse_args()
    
    success = test_autogen(args.model)
    if success:
        print("\nTest completed successfully!")
    else:
        print("\nTest failed. Please check the logs for details.") 