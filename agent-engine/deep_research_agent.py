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

# Patch Python's traceback module to avoid 'compact' parameter errors
original_TracebackException = traceback.TracebackException

class PatchedTracebackException(original_TracebackException):
    def __init__(self, *args, **kwargs):
        if 'compact' in kwargs:
            del kwargs['compact']
        super().__init__(*args, **kwargs)

# Apply the patch
traceback.TracebackException = PatchedTracebackException

# Disable asyncio error logging
asyncio_logger = logging.getLogger('asyncio')
asyncio_logger.setLevel(logging.CRITICAL)

# Completely disable traceback formatting in trio
try:
    import trio._core._multierror
    trio._core._multierror.traceback_exception_format = lambda self, chain=True: []
except (ImportError, AttributeError):
    pass

# Filter pydantic warnings about underscore fields
warnings.filterwarnings("ignore", message="fields may not start with an underscore")
# Filter warnings about function overrides
warnings.filterwarnings("ignore", message="Function .* is being overridden")
# Filter traceback warnings
warnings.filterwarnings("ignore", category=DeprecationWarning)

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

# Disable asyncio's Task.__del__ method to avoid errors
try:
    asyncio.tasks.Task.__del__ = lambda self: None
except (AttributeError, TypeError):
    pass

class DeepResearchAgentWrapper:
    """Wrapper for the DeepResearchAgent from AG2"""
    
    def __init__(self, config_path="OAI_CONFIG_LIST"):
        """Initialize the DeepResearchAgent wrapper
        
        Args:
            config_path: Path to the OpenAI config list file
        """
        self.config_path = config_path
        self._ensure_config_exists()
        
    def _ensure_config_exists(self):
        """Ensure the OAI_CONFIG_LIST file exists, create if not"""
        if not os.path.exists(self.config_path):
            # Create a default config using environment variables
            config = [{
                "api_type": "openai",
                "model": os.getenv("OPENAI_MODEL", "gpt-4o"),
                "api_key": os.getenv("OPENAI_API_KEY", "")
            }]
            
            with open(self.config_path, "w") as f:
                json.dump(config, f, indent=2)
            
            logger.info(f"Created default OAI_CONFIG_LIST at {self.config_path}")
    
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
        logs_dir = os.path.join(tempfile.gettempdir(), "logs")
        os.makedirs(logs_dir, exist_ok=True)
        
        # Create a temporary file for stdout redirection
        output_file = os.path.join(logs_dir, f"deep_research_{int(time.time())}.txt")
        
        try:
            # Load config
            config_list = config_list_from_json(env_or_file=self.config_path)
            
            # Initialize DeepResearchAgent with proper configuration
            agent = DeepResearchAgent(
                name="DeepResearchAgent",
                llm_config={"config_list": config_list}
            )
            
            # Configure browser settings directly on the agent's browser_use instance
            if hasattr(agent, 'browser_use'):
                agent.browser_use.timeout = 120000  # 2 minutes timeout
                agent.browser_use.headless = True
                agent.browser_use.slow_mo = 100  # Slow down operations slightly for stability
            
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
            
            # Read the captured output from the file
            with open(output_file, 'r') as f:
                captured_output = f.read()
            
            # Format the result
            research_result = {
                "summary": result.summary if hasattr(result, 'summary') else "Research completed but no summary was generated.",
                "cost": result.cost if hasattr(result, "cost") else None,
                "captured_output": captured_output,
                "success": True,
                "query": query,
                "max_turns": max_turns,
                "timestamp": result.timestamp if hasattr(result, "timestamp") else None,
                "output_file": output_file  # Include the path to the output file
            }
            
            # Add any additional attributes from the result that might be useful
            if hasattr(result, "messages") and result.messages:
                research_result["message_count"] = len(result.messages)
            
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

# Example usage
if __name__ == "__main__":
    agent = DeepResearchAgentWrapper()
    result = agent.run_research("What are the latest developments in quantum computing?")
    print(json.dumps(result, indent=2)) 