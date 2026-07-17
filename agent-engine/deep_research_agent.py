#!/usr/bin/env python3
import os
import json
import logging
import warnings
import nest_asyncio
from autogen import config_list_from_json, filter_config
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
from datetime import datetime
import html
from task_utils import get_downloads_path, upload_task_result_files, get_llm
from report_prompt import build_report_format_prompt

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
    
    def __init__(self, user_id: str, execution_id: str, full_llm_name: str):
        """Initialize the DeepResearchAgent wrapper
        
        Args:
            user_id: User ID for organizing outputs
            execution_id: Execution ID for tracking
            full_llm_name: Full LLM name in format platform->provider->model
        """
        self.llm_name = full_llm_name
        self.user_id = user_id
        self.execution_id = execution_id
    
    def _get_config_list(self) -> list:
        """Get the filtered config list based on the LLM name
        
        Returns:
            list: Filtered config list for the LLM
        """
        try:
            # Parse the LLM name components
            platform, provider, model = self.llm_name.lower().split('->')
            
            # Load the base config list
            base_config = config_list_from_json(env_or_file="OAI_CONFIG_LIST")
            
            # Create filter tags based on platform and model
            filter_tags = [platform, model]
            
            # Filter the config list
            filtered_config = filter_config(base_config, {"tags": filter_tags})
            
            if not filtered_config:
                logger.error(f"No matching config found for tags {filter_tags}")
                return None
                
            return filtered_config
            
        except Exception as e:
            logger.error(f"Error creating filtered config list: {str(e)}")
            logger.warning("Using full config list as fallback")
            return config_list_from_json(env_or_file="OAI_CONFIG_LIST")

    def _generate_html_report(self, research_result: Dict[str, Any], query: str, output_file: str) -> str:
        """Generate an HTML5 report from the research results
        
        Args:
            research_result: The research results dictionary
            query: The original research query
            output_file: Path to the detailed output log file
            
        Returns:
            Path to the generated HTML report
        """
        # Read the detailed log file
        try:
            with open(output_file, 'r') as f:
                detailed_log = f.read()
        except Exception as e:
            detailed_log = f"Error reading detailed log: {str(e)}"
            
        # Generate timestamp
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # For large logs, use first and last portions
        log_for_prompt = detailed_log
        if len(detailed_log) > 50000:
            first_part = detailed_log[:25000]
            last_part = detailed_log[-25000:]
            log_for_prompt = f"{first_part}\n\n[...MIDDLE SECTION TRUNCATED...]\n\n{last_part}"
            logger.info(f"Detailed log truncated from {len(detailed_log)} to {len(log_for_prompt)} characters")
        
        # Use LLM to create a complete HTML report
        try:
            # Use the shared get_llm function to get a language model for report generation
            llm, _ = get_llm(self.llm_name)
            
            # Prepare prompt for the LLM (built in the dependency-light report_prompt
            # module so the inline-citation guidance is unit-testable offline).
            format_prompt = build_report_format_prompt(query, log_for_prompt)
            
            # Use the LLM directly to generate the complete HTML report
            logger.info("Using LLM to create complete HTML research report")
            
            from langchain_core.messages import HumanMessage
            formatted_result = llm.invoke([HumanMessage(content=format_prompt)])
            html_content = formatted_result.content
            
            logger.info(f"Successfully generated complete HTML report with LLM (length: {len(html_content)})")
            
        except Exception as e:
            logger.error(f"Error using LLM to generate report: {str(e)}")
            # Create a simple error report
            html_content = f"""
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Error Generating Research Report</title>
                <style>
                    body {{ font-family: Arial, sans-serif; line-height: 1.6; padding: 20px; }}
                    .error {{ color: #d32f2f; background-color: #ffebee; padding: 15px; border-radius: 4px; }}
                </style>
            </head>
            <body>
                <h1>Error Generating Research Report</h1>
                <p>There was an error while generating the research report:</p>
                <div class="error">{str(e)}</div>
                <h2>Research Query</h2>
                <p>{query}</p>
                <h2>Timestamp</h2>
                <p>{timestamp}</p>
            </body>
            </html>
            """
        
        # Save HTML report using the shared downloads path with user_id and execution_id
        report_path = os.path.join(
            get_downloads_path(
                user_id=self.user_id,
                execution_id=self.execution_id
            ),
            f"research_report.html"
        )
        
        with open(report_path, 'w', encoding='utf-8') as f:
            f.write(html_content)
            
        return report_path
    
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
        
        # Create a file for stdout redirection using the execution_id
        output_file = f"logs/execution_{self.execution_id}_deep_activities.log"
        
        try:
            # Get filtered config list based on LLM name
            config_list = self._get_config_list()
            
            # Initialize DeepResearchAgent with proper configuration
            agent = DeepResearchAgent(
                name="DeepResearchAgent",
                llm_config={"config_list": config_list},
                max_web_steps=10,
                max_consecutive_auto_reply=2 # This could help terminate the agent if it's stuck in a loop
            )
            
            logger.info(f"Starting deep research on query: {query}")
            logger.info(f"Using LLM: {self.llm_name}")
            logger.info(f"Redirecting output to file: {output_file}")
            
            # Write initial info to the output file
            with open(output_file, 'a') as f:
                f.write(f"\n=== Deep Research Started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ===\n")
                f.write(f"Using LLM: {self.llm_name}\n")
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
            
            # Get downloads path for storing generated files
            downloads_path = get_downloads_path(
                user_id=self.user_id,
                execution_id=self.execution_id
            )
            
            # Generate HTML report
            try:
                html_report_path = self._generate_html_report(research_result, query, output_file)
                research_result["html_report"] = html_report_path
                logger.info(f"HTML report generated at: {html_report_path}")
            except Exception as e:
                logger.error(f"Error generating HTML report: {str(e)}")
                research_result["html_report_error"] = str(e)
            
            # Upload generated files to S3
            try:
                result_files = upload_task_result_files(downloads_path, self.execution_id)
                if result_files:
                    research_result["result_files"] = result_files
                    logger.info(f"Uploaded {len(result_files)} files to S3")
            except Exception as e:
                logger.error(f"Error uploading result files to S3: {str(e)}")
            
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

    async def cleanup(self):
        """Empty cleanup method required by task_monitor.py"""
        logger.info(f"DeepResearchAgentWrapper cleanup for {self.execution_id}")
        # Nothing to clean up here, but method is required by task_monitor.py
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
    parser.add_argument('--llm_name', required=True, help='Full LLM name in format platform->provider->model')
    
    args = parser.parse_args()
    
    try:
        logger.info(f"Starting deep research for execution {args.execution_id}")
        
        # Read prompt from file
        with open(args.prompt_file, 'r') as f:
            prompt = f.read()
        
        logger.info(f"Running deep research for user {args.user_id}, task {args.task_id}")
        logger.info(f"Using LLM: {args.llm_name}")
        logger.info(f"Prompt: {prompt[:100]}...")
        
        # Initialize the deep research agent with user_id and execution_id
        agent = DeepResearchAgentWrapper(
            user_id=args.user_id,
            execution_id=args.execution_id,
            full_llm_name=args.llm_name
        )
        
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
        print("Usage: deep_research_agent.py --user_id=<user_id> --execution_id=<execution_id> --task_id=<task_id> --prompt_file=<prompt_file> --max_turns=<max_turns> --llm_name=<llm_name>")
