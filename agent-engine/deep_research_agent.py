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
from datetime import datetime
import html
from task_utils import get_downloads_path, upload_task_result_files, get_llm

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
    
    def __init__(self, user_id: str, execution_id: str, config_path: str = "OAI_CONFIG_LIST"):
        """Initialize the DeepResearchAgent wrapper
        
        Args:
            user_id: User ID for organizing outputs
            execution_id: Execution ID for tracking
            config_path: Path to the OpenAI config list file
        """
        self.config_path = config_path
        self.llm_name = "azure->openai->gpt-4o" # TODO: support other LLMs
        self.user_id = user_id
        self.execution_id = execution_id
    
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
        
        # Use LLM to create a more readable version of the detailed log
        try:
            # Use the shared get_llm function to get a language model for report generation
            # We'll use the same LLM as the main research agent
            llm, _ = get_llm(self.llm_name)
            
            # For large logs, use first and last portions
            log_for_prompt = detailed_log
            if len(detailed_log) > 50000:
                first_part = detailed_log[:25000]
                last_part = detailed_log[-25000:]
                log_for_prompt = f"{first_part}\n\n[...MIDDLE SECTION TRUNCATED...]\n\n{last_part}"
                logger.info(f"Detailed log truncated from {len(detailed_log)} to {len(log_for_prompt)} characters")
            
            # Prepare prompt for the LLM
            format_prompt = f"""
            Please analyze the following research log and create a comprehensive, well-structured, detailed report in HTML format.
            
            IMPORTANT: Your output will be directly inserted into an HTML document within a div with class "formatted-report".
            DO NOT include complete HTML document tags like <!DOCTYPE>, <html>, <head>, <body>, etc.
            DO include proper HTML formatting for the content itself using appropriate tags.
            
            Make the report as valuable and informative as possible, including all relevant details, data points, and insights.
            
            Organize the information into clear sections such as:
            
            1. Research Process: Describe the steps taken during the research in detail
            2. Key Findings: Highlight the most important discoveries with supporting evidence and data
            3. References: List and summarize all sources consulted, including URLs, titles, authors, and publication dates where available
            4. Conclusions: Provide thorough, evidence-based conclusions and recommendations
            
            Use proper HTML formatting:
            - Use <h3>, <h4> tags for section headers (h1 and h2 are already used in the document)
            - Use <ul> and <li> for bullet point lists
            - Use <ol> and <li> for numbered lists
            - Use <table>, <tr>, <th>, <td> for data tables
            - Use <strong> for emphasis
            - Use <blockquote> for quotes
            - Use <a href="URL"> for links
            - Use <p> for paragraphs
            
            Make the report comprehensive, detailed, and visually structured for easy reading.
            
            Original Query: {query}
            
            Research Log:
            {log_for_prompt}
            """
            
            # Use the LLM directly to generate the formatted report
            logger.info("Using LLM to create formatted research report")
            
            # Use the LLM directly for all model types
            from langchain_core.messages import HumanMessage
            formatted_result = llm.invoke([HumanMessage(content=format_prompt)])
            formatted_report = formatted_result.content
            
            logger.info(f"Successfully generated formatted report with LLM (length: {len(formatted_report)})")
            
        except Exception as e:
            logger.error(f"Error using LLM to format report: {str(e)}")
            formatted_report = "<p>Error generating formatted report with LLM.</p>"
            
        # Create HTML content
        html_content = f"""
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Research Report: {html.escape(query[:50])}...</title>
            <style>
                body {{
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    line-height: 1.6;
                    max-width: 1200px;
                    margin: 0 auto;
                    padding: 20px;
                    color: #333;
                    background-color: #f9f9f9;
                }}
                .header {{
                    background-color: #2c3e50;
                    color: white;
                    padding: 30px;
                    border-radius: 8px;
                    margin-bottom: 30px;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                }}
                .header h1 {{
                    margin-top: 0;
                    font-size: 2.2em;
                }}
                .summary {{
                    background-color: white;
                    padding: 25px;
                    border-radius: 8px;
                    margin-bottom: 30px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
                }}
                .formatted-report {{
                    background-color: white;
                    padding: 25px;
                    border-radius: 8px;
                    margin-bottom: 30px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
                }}
                .formatted-report table {{
                    border-collapse: collapse;
                    width: 100%;
                    margin: 15px 0;
                }}
                .formatted-report th, .formatted-report td {{
                    border: 1px solid #ddd;
                    padding: 12px;
                    text-align: left;
                }}
                .formatted-report th {{
                    background-color: #f2f2f2;
                }}
                .formatted-report tr:nth-child(even) {{
                    background-color: #f9f9f9;
                }}
                .formatted-report blockquote {{
                    border-left: 4px solid #2c3e50;
                    padding-left: 15px;
                    margin-left: 0;
                    color: #555;
                    font-style: italic;
                }}
                .formatted-report ul, .formatted-report ol {{
                    padding-left: 25px;
                }}
                .formatted-report img {{
                    max-width: 100%;
                    height: auto;
                    display: block;
                    margin: 20px auto;
                    border-radius: 4px;
                }}
                .metadata {{
                    color: #eee;
                    font-size: 0.9em;
                    margin-top: 15px;
                }}
                h2 {{
                    color: #2c3e50;
                    border-bottom: 2px solid #eee;
                    padding-bottom: 10px;
                    margin-top: 30px;
                }}
                h3 {{
                    color: #3498db;
                    margin-top: 25px;
                }}
                h4 {{
                    color: #2980b9;
                    margin-top: 20px;
                }}
                a {{
                    color: #3498db;
                    text-decoration: none;
                }}
                a:hover {{
                    text-decoration: underline;
                }}
                code {{
                    background-color: #f8f8f8;
                    padding: 2px 5px;
                    border-radius: 3px;
                    font-family: monospace;
                    font-size: 0.9em;
                }}
                pre {{
                    background-color: #f8f8f8;
                    padding: 15px;
                    border-radius: 5px;
                    overflow-x: auto;
                    font-family: monospace;
                }}
            </style>
        </head>
        <body>
            <div class="header">
                <h1>Research Report</h1>
                <div class="metadata">
                    <p>Generated: {timestamp}</p>
                    <p>Query: {html.escape(query)}</p>
                    <p>LLM: {html.escape(research_result.get('llm_name', 'Unknown'))}</p>
                </div>
            </div>
            
            <div class="summary">
                <h2>Research Summary</h2>
                <p>{html.escape(research_result.get('summary', 'No summary available.'))}</p>
            </div>
            
            <div class="formatted-report">
                <h2>Detailed Research Report</h2>
                {formatted_report}
            </div>
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

        # Assert that we run with azure openai LLM
        assert self.llm_name == "azure->openai->gpt-4o", "This script only supports azure openai LLM"
        
        # Create a file for stdout redirection using the execution_id
        output_file = f"logs/execution_{self.execution_id}_deep_activities.log"
        
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
        
        # Initialize the deep research agent with user_id and execution_id
        agent = DeepResearchAgentWrapper(
            user_id=args.user_id,
            execution_id=args.execution_id
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
        print("Usage: deep_research_agent.py --user_id=<user_id> --execution_id=<execution_id> --task_id=<task_id> --prompt_file=<prompt_file> --max_turns=<max_turns>")
