#!/usr/bin/env python3
import os
import sys
import json
import logging
import asyncio
import re
from pathlib import Path
from typing import Dict, Any
from dotenv import load_dotenv

from browser_use import Agent
from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContext
from langchain_openai import ChatOpenAI

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Initialize browser with non-headless mode for debugging
browser_config = BrowserConfig(
    headless=False if os.environ.get("DEBUG_MODE") == "true" else True
)

# Custom JSON encoder to handle any non-serializable objects
class CustomJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        try:
            return super().default(obj)
        except TypeError:
            return str(obj)

def extract_json_from_content(content_list):
    """Extract JSON objects from the extracted content"""
    json_objects = []
    
    if not isinstance(content_list, list):
        # If content_list is not a list, convert it to a list with a single item
        content_list = [content_list]
        
    for content in content_list:
        if not content or not isinstance(content, str):
            continue
            
        # Try to extract JSON from code blocks
        if "```json" in content:
            # Extract the JSON part from code blocks
            json_matches = re.findall(r'```json\s*(.*?)\s*```', content, re.DOTALL)
            for json_str in json_matches:
                try:
                    json_obj = json.loads(json_str)
                    json_objects.append(json_obj)
                except json.JSONDecodeError:
                    logger.error(f"Failed to parse JSON from code block: {json_str[:100]}...")
        else:
            # Try to parse the content directly as JSON
            try:
                # Check if the content looks like JSON (starts with { or [)
                content_stripped = content.strip()
                if (content_stripped.startswith('{') and content_stripped.endswith('}')) or \
                   (content_stripped.startswith('[') and content_stripped.endswith(']')):
                    json_obj = json.loads(content_stripped)
                    json_objects.append(json_obj)
            except json.JSONDecodeError:
                # Not valid JSON, skip
                pass
                
    # For backward compatibility, return the first JSON object if any
    return json_objects[0] if json_objects else None

async def extract_page_content(url: str) -> Dict[str, Any]:
    """
    Extract content from a webpage using browser-use Agent.
    
    Args:
        url: The URL of the webpage to extract content from
        
    Returns:
        Dictionary containing the extracted content
    """
    try:
        # Initialize the browser
        browser = Browser(config=browser_config)
        
        # Initialize the LLM
        openai_api_key = os.environ.get("OPENAI_API_KEY")
        if not openai_api_key:
            raise ValueError("OPENAI_API_KEY environment variable is required")
        
        llm = ChatOpenAI(
            model="gpt-4o-mini",
            temperature=0,
            openai_api_key=openai_api_key
        )
        
        # Create a task prompt for the agent
        task = f"Go to {url} and extract all the main content from the page. Extract the title, main features, and description. Return the extracted content using the 'done' action."
        
        # Initialize the agent
        agent = Agent(task=task, llm=llm, browser=browser)
        
        # Run the agent
        logger.info(f"Running agent to extract content from {url}")
        history = await agent.run(max_steps=5)  # Limit to 5 steps to avoid long runs
        
        # Extract content from history
        extracted_content = history.extracted_content()
        final_result = history.final_result()
        
        # Extract JSON from content
        json_objects = []
        for content in extracted_content:
            objects = extract_json_from_content([content])
            if objects:
                if isinstance(objects, list):
                    json_objects.extend(objects)
                else:
                    json_objects.append(objects)
        
        # Get all URLs visited
        urls = history.urls()
        
        # Check if the task was completed successfully
        is_done = history.is_done()
        is_successful = history.is_successful()
        
        logger.info("Content extraction completed")
        return {
            "success": is_successful if is_successful is not None else is_done,
            "extracted_json": json_objects,
            "extracted_content": extracted_content,
            "final_result": final_result,
            "urls_visited": urls,
            "is_done": is_done
        }
        
    except Exception as e:
        logger.error(f"Error during extraction: {e}")
        return {
            "success": False,
            "error": str(e),
            "url": url
        }

async def main():
    """Main function to run the test"""
    # Parse command line arguments
    import argparse
    parser = argparse.ArgumentParser(description='Extract content from a webpage')
    parser.add_argument('--url', type=str, default="https://agentweb.pro", help='URL to extract content from')
    parser.add_argument('--json', action='store_true', help='Output results as JSON')
    parser.add_argument('--output', type=str, help='Output file path for JSON results')
    parser.add_argument('--extract-json-only', action='store_true', help='Output only the extracted JSON object')
    args = parser.parse_args()
    
    url = args.url
    
    # Print test information (only if not in JSON mode)
    if not args.json and not args.extract_json_only:
        print("\n" + "="*50)
        print("RUNNING PAGE CONTENT EXTRACTION TEST")
        print("="*50)
        print(f"URL: {url}")
        print("-"*50)
    
    # Run the extraction
    result = await extract_page_content(url)
    
    if args.extract_json_only:
        # Output only the extracted JSON object
        if result.get("extracted_json"):
            print(json.dumps(result["extracted_json"], indent=2))
        else:
            print(json.dumps({"error": "No JSON object found in extracted content"}))
        return result.get("success", False)
    
    if args.json:
        # Output as JSON
        json_result = json.dumps(result, indent=2, cls=CustomJSONEncoder)
        
        if args.output:
            # Write to file
            with open(args.output, 'w') as f:
                f.write(json_result)
            if not args.json:
                print(f"Results written to {args.output}")
        else:
            # Print to stdout
            print(json_result)
    else:
        # Pretty print the result
        print("\n" + "="*50)
        print(f"EXTRACTION RESULTS")
        print("="*50)
        
        if result.get("success"):
            print(f"Status: ✅ Success")
            print(f"Task Completed: {'Yes' if result['is_done'] else 'No'}")
            
            if result.get("extracted_json"):
                print("\nExtracted JSON:")
                print("-"*50)
                json_objects = result["extracted_json"]
                if isinstance(json_objects, list):
                    for i, json_obj in enumerate(json_objects):
                        print(f"JSON Object #{i+1}:")
                        print(json.dumps(json_obj, indent=2))
                        print()
                else:
                    print(json.dumps(json_objects, indent=2))
            
            print("\nExtracted Content:")
            print("-"*50)
            for i, content in enumerate(result["extracted_content"]):
                print(f"[{i+1}] {content}")
            
            print("\nFinal Result:")
            print("-"*50)
            print(result["final_result"])
            
            print("\nURLs Visited:")
            print("-"*50)
            for url in result["urls_visited"]:
                print(f"- {url}")
        else:
            print(f"Status: ❌ Failed")
            print(f"Error: {result.get('error', 'Unknown error')}")
        
        print("="*50 + "\n")
    
    return result.get("success", False)

if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1) 