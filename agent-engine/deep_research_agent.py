#!/usr/bin/env python3
import os
import json
import logging
import warnings
import nest_asyncio
from autogen import config_list_from_json
from autogen.agents.experimental import DeepResearchAgent
import io
import contextlib
from dotenv import load_dotenv
from typing import Dict, Any, Optional
import asyncio
import sys
import traceback
import tempfile
import time
import argparse

# Load environment variables
load_dotenv()

# Configure logging - use a simpler format to avoid traceback issues
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

# Configure autogen loggers to reduce noise
for logger_name in ['autogen', 'browser_use', 'playwright', 'asyncio']:
    log = logging.getLogger(logger_name)
    log.setLevel(logging.WARNING)

# Apply nest_asyncio to allow nested event loops (needed for Jupyter/async environments)
try:
    nest_asyncio.apply()
except ImportError:
    logger.warning("nest_asyncio not installed. If running in Jupyter, install with: pip install nest_asyncio")

class DeepResearchAgentWrapper:
    """Wrapper for the DeepResearchAgent from AG2"""
    
    def __init__(self, config_path="OAI_CONFIG_LIST"):
        """Initialize the DeepResearchAgent wrapper
        
        Args:
            config_path: Path to the OpenAI config list file
        """
        self.config_path = config_path
        self.llm_name = "azure->openai->gpt-4o" # TODO: support other LLMs
    
    def run_research(self, query: str, max_turns: int = 2, user_input: bool = False) -> Dict[str, Any]:
        """Run deep research on the given query
        
        Args:
            query: The research query
            max_turns: Maximum number of turns for the agent (default: 2)
            user_input: Whether to allow user input during research (default: False)
            
        Returns:
            Dict containing the research results
        """
        # Create logs directory if it doesn't exist
        os.makedirs('logs', exist_ok=True)

        # Assert that we run with azure openai LLM
        assert self.llm_name == "azure->openai->gpt-4o", "This script only supports azure openai LLM"
        # Use a timestamp as a fallback if execution_id is not available
        timestamp = int(time.time())
        # The execution_id will be set in the main function
        execution_id = getattr(self, 'execution_id', f"{timestamp}")
        
        # Create a file for stdout redirection using the requested format
        output_file = f"logs/execution_{execution_id}_deep_activities.log"
        
        try:
            # Load config
            config_list = config_list_from_json(env_or_file=self.config_path)
            
            # Initialize DeepResearchAgent with proper configuration
            agent = DeepResearchAgent(
                name="DeepResearchAgent",
                llm_config={"config_list": config_list}
            )
            
            logger.info(f"Starting deep research on query: {query}")
            logger.info(f"Redirecting output to file: {output_file}")
            
            # Redirect stdout to a file
            with open(output_file, 'w') as f:
                with contextlib.redirect_stdout(f):
                    # Run the agent with proper error handling
                    try:
                        # Run the agent
                        result = agent.run(
                            message=query,
                            tools=agent.tools,
                            max_turns=max_turns,
                            user_input=user_input,
                            summary_method="reflection_with_llm",
                        )
                    except Exception as e:
                        logger.error(f"Error during agent.run: {str(e)}")
                        raise
            
            # Format the result
            research_result = {
                "summary": result.summary if hasattr(result, 'summary') else "Research completed but no summary was generated.",
                "cost": result.cost if hasattr(result, "cost") else None,
                "success": True,
                "query": query,
                "max_turns": max_turns,
                "llm_name": self.llm_name,
                "timestamp": result.timestamp if hasattr(result, "timestamp") else None,
                "output_file": output_file  # Include the path to the output file
            }
            
            logger.info(f"Deep research completed successfully. Summary length: {len(research_result['summary'])}")
            logger.info(f"Full output saved to: {output_file}")
            return research_result
            
        except Exception as e:
            logger.error(f"Error running deep research: {str(e)}")
            return {
                "summary": f"Error running deep research: {str(e)}",
                "success": False,
                "error": str(e),
                "query": query,
                "output_file": output_file if 'output_file' in locals() else None
            }
        finally:
            # Don't try to clean up asyncio tasks - this causes more problems than it solves
            pass

def main():
    """
    CLI entry point for deep research agent.
    This script is designed to be called from task_monitor.py in a similar way to web_agent.py.
    """
    parser = argparse.ArgumentParser(description='Run deep research on a query')
    parser.add_argument('--user_id', required=True, help='User ID')
    parser.add_argument('--execution_id', required=True, help='Execution ID')
    parser.add_argument('--task_id', required=True, help='Task ID')
    parser.add_argument('--prompt_file', required=True, help='File containing the prompt')
    parser.add_argument('--max_turns', type=int, default=2, help='Maximum number of turns for the agent')
    
    args = parser.parse_args()
    
    try:
        logger.info(f"Starting deep research for execution {args.execution_id}")
        
        # Read prompt from file
        with open(args.prompt_file, 'r') as f:
            prompt = f.read()
        
        logger.info(f"Running deep research for user {args.user_id}, task {args.task_id}")
        logger.info(f"Prompt: {prompt[:100]}...")
        
        # Initialize the deep research agent
        agent = DeepResearchAgentWrapper()
        
        # Set the execution_id on the agent instance
        agent.execution_id = args.execution_id
        
        # Run the research
        research_result = agent.run_research(
            query=prompt,
            max_turns=args.max_turns,
            user_input=False
        )
        
        # Print the result as JSON to stdout (will be captured by task_monitor.py)
        print(json.dumps(research_result))
        logger.info("Deep research completed successfully")
        
        # Return success
        return 0
    
    except Exception as e:
        # Simple error logging without traceback formatting
        error_msg = str(e)
        logger.error(f"Error in deep research: {error_msg}")
        
        # Get simple traceback as string
        tb_str = traceback.format_exc()
        logger.error(f"Traceback: {tb_str}")
        
        # Print error as JSON to stdout
        error_result = {
            "success": False,
            "error": f"{error_msg}\n\nTraceback: {tb_str}",
            "execution_id": args.execution_id if 'args' in locals() else None,
            "task_id": args.task_id if 'args' in locals() else None,
            "user_id": args.user_id if 'args' in locals() else None
        }
        print(json.dumps(error_result))
        return 1
    finally:
        # No cleanup needed - handlers will be automatically closed when the process exits
        pass

# Example usage as a script
if __name__ == "__main__":
    # If arguments are provided, run as CLI
    if len(sys.argv) > 1:
        sys.exit(main())
    # Otherwise, print the help message
    else:
        print("Usage: deep_research_agent.py --user_id=<user_id> --execution_id=<execution_id> --task_id=<task_id> --prompt_file=<prompt_file> --max_turns=<max_turns>")
