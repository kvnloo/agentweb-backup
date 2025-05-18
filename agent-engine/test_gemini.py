#!/usr/bin/env python3
"""
Test script for Google Gemini integration.
This script creates a ChatGoogleGenerativeAI instance and tests basic functionality.
"""

import os
import sys
import logging
import asyncio
from pathlib import Path
from typing import List, Optional
from dotenv import load_dotenv
from pydantic import SecretStr, BaseModel
from browser_use import Agent, ActionResult, Controller
from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContextConfig, BrowserContext
import re # Added for sanitize_filename
import random # Added for sanitize_filename fallback
# import uuid # No longer needed as uuid isn't used for filename

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create a controller for custom actions
controller = Controller()

def sanitize_filename(text: str, max_len: int = 50) -> str:
    """Sanitizes a string to be a valid filename."""
    if not text:
        return "image" # Default if prompt is empty
    # Keep alphanumeric, underscores, hyphens. Replace spaces with underscores.
    text = re.sub(r'[\s]+', '_', text) # Replace spaces with underscores first
    text = re.sub(r'[^\w\s-]', '', text).strip() # Remove unwanted characters (allow underscore and hyphen)
    # Truncate and ensure it's not empty
    sanitized = text[:max_len].strip('_') # Remove leading/trailing underscores after sanitization
    if not sanitized: # Fallback if all chars were removed or only underscores
        return "image_" + "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=5)) # Corrected to random.choices
    return sanitized

class NameList(BaseModel):
    names: List[str]

@controller.action('Say hello to someone')
async def hello(name: str, browser: BrowserContext):
    """Say hello to the specified person"""
    try:
        return ActionResult(extracted_content=f"Hello, {name}!")
    except Exception as e:
        return ActionResult(error=str(e))

@controller.action('Say hello to a list of people', param_model=NameList)
async def hello_list(name_list: NameList, browser: BrowserContext):
    """Say hello to a list of people"""
    try:
        greetings = [f"Hello, {name}!" for name in name_list.names]
        return ActionResult(extracted_content="\n".join(greetings))
    except Exception as e:
        return ActionResult(error=str(e))

def test_gemini(model_name="gemini-2.0-flash"):
    """Test the Google Gemini integration"""
    # Load environment variables from .env file
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        sys.exit(1)
    
    logger.info(f"Testing Google Gemini with model: {model_name}")
    
    try:
        # Import here to avoid requiring the package for all users
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI
        except ImportError:
            logger.error("langchain_google_genai package is not installed. Install it with: pip install langchain-google-genai")
            sys.exit(1)
        
        # Create ChatGoogleGenerativeAI instance
        chat = ChatGoogleGenerativeAI(
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
        
        # Test with a simple prompt
        logger.info("Sending test prompt to Gemini model...")
        response = chat.invoke("What is the capital of France?")
        
        # Print the response
        logger.info("Response received:")
        logger.info(response.content)
        
        logger.info("Test completed successfully!")
        return True
        
    except Exception as e:
        logger.error(f"Error testing Gemini: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

async def test_with_browser_use_async(model_name="gemini-2.0-flash"):
    """Test using Gemini with browser-use for web automation"""
    # Load environment variables from .env file
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        sys.exit(1)
    
    logger.info(f"Testing Google Gemini with browser-use using model: {model_name}")
    
    try:
        # Import here to avoid requiring the package for all users
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI
        except ImportError:
            logger.error("langchain_google_genai package is not installed. Install it with: pip install langchain-google-genai")
            sys.exit(1)
        
        # Create ChatGoogleGenerativeAI instance
        chat = ChatGoogleGenerativeAI(
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
        
        # Create browser instance
        browser = Browser(
            config=BrowserConfig(
                new_context_config=BrowserContextConfig(
                    viewport_expansion=0,
                )
            )
        )
        
        # Create downloads directory
        downloads_path = Path('downloads/test_gemini')
        downloads_path.mkdir(parents=True, exist_ok=True)
        
        # Define a simple web automation task
        task = """
        1. Go to https://www.example.com
        2. Use the hello_list function to say hello to ["World", "Python", "Gemini"]
        3. Return the greeting messages
        """
        
        # Initialize Agent with the ChatGoogleGenerativeAI model and controller
        logger.info("Initializing Agent with Gemini model...")
        agent = Agent(
            task=task,
            llm=chat,
            controller=controller,
            browser=browser,
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
        
        # Print function call history
        logger.info("\nFunction call history:")
        for step in result.history:
            if hasattr(step, 'result') and step.result:
                for action in step.result:
                    if hasattr(action, 'function_call'):
                        logger.info(f"Function called: {action.function_call}")
        
        logger.info("Browser-use test completed successfully!")
        return True
        
    except Exception as e:
        logger.error(f"Error testing with browser-use: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_with_browser_use(model_name="gemini-2.0-flash"):
    """Wrapper to run the async browser-use test"""
    return asyncio.run(test_with_browser_use_async(model_name))

async def test_gemini_aigc(model_id="models/gemini-2.0-flash-preview-image-generation"):
    """Test the Google Gemini image generation (AIGC) integration interactively."""
    load_dotenv()
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        return False

    logger.info(f"Starting interactive Gemini AIGC test with model: {model_id}")

    try:
        from langchain_core.messages import AIMessage
        from langchain_google_genai import ChatGoogleGenerativeAI
        import base64

        images_dir = Path("generated_images")
        images_dir.mkdir(parents=True, exist_ok=True)

        chat = ChatGoogleGenerativeAI(
            model=model_id,
            api_key=SecretStr(api_key),
            temperature=0.7, # Slightly higher temp for more diverse generations
        )

        initial_prompt_text = input("Enter your initial image prompt (e.g., 'A futuristic cityscape at sunset'): ").strip()
        if not initial_prompt_text:
            logger.warning("No initial prompt provided. Exiting AIGC test.")
            return False
            
        current_prompt_text = initial_prompt_text
        # Sanitize the entire initial prompt for the base filename part
        base_prompt_snippet = sanitize_filename(initial_prompt_text)
        if not base_prompt_snippet or base_prompt_snippet == "image": # Ensure meaningful snippet
             base_prompt_snippet = "prompt_image"

        iteration_count = 0

        while True:
            iteration_count += 1
            logger.info(f"Image generation attempt {iteration_count} for prompt: '{current_prompt_text}'")

            user_message = {
                "role": "user",
                "content": current_prompt_text,
            }
            
            response = None # Initialize response
            try:
                response = chat.invoke(
                    [user_message],
                    generation_config=dict(response_modalities=["TEXT", "IMAGE"])
                )
                logger.info("Response received from AIGC model.")
            except Exception as e:
                logger.error(f"Error invoking LLM for image generation: {e}")
                retry_input = input("Failed to get response from model. Retry? (yes/no/quit): ").strip().lower()
                if retry_input in ["no", "n", "quit", "q"]:
                    return False # End test on error if user doesn't want to retry
                elif retry_input in ["yes", "y"]:
                    iteration_count -=1 # Decrement to retry the same iteration number
                    continue 
                else: # Invalid input on retry prompt
                    logger.warning("Invalid input for retry. Exiting.")
                    return False


            def _get_image_base64(response_msg: Optional[AIMessage]) -> Optional[str]:
                if response_msg is None or not hasattr(response_msg, 'content') or not isinstance(response_msg.content, list):
                    logger.error(f"Invalid or unexpected response object or content type: {type(response_msg)}. Expected AIMessage with list content.")
                    if response_msg and hasattr(response_msg, 'content'):
                         logger.debug(f"Full response content for debugging: {response_msg.content}")
                    return None
                for block in response_msg.content:
                    if isinstance(block, dict) and block.get("type") == "image_url" and block.get("image_url"):
                        image_url_data = block["image_url"]
                        if isinstance(image_url_data, dict) and "url" in image_url_data:
                            url_parts = image_url_data["url"].split(",")
                            if len(url_parts) > 1 and url_parts[0].startswith("data:image/") and "base64" in url_parts[0]:
                                return url_parts[-1]
                logger.error("No image_url block found in the expected format in response.")
                logger.debug(f"Full response content for debugging: {response_msg.content}")
                return None

            image_base64_data = _get_image_base64(response)

            if image_base64_data:
                logger.info("Image data received successfully.")
                try:
                    decoded_image_data = base64.b64decode(image_base64_data)
                    
                    file_ext = "png" # Default extension
                    # Try to get actual extension from data URI
                    if response and hasattr(response, 'content') and isinstance(response.content, list):
                        for block in response.content:
                             if isinstance(block, dict) and block.get("type") == "image_url" and block.get("image_url"):
                                image_url_dict = block["image_url"]
                                if isinstance(image_url_dict, dict) and "url" in image_url_dict:
                                    data_uri_parts = image_url_dict["url"].split(';')[0] # e.g., "data:image/jpeg"
                                    if data_uri_parts.startswith("data:image/"):
                                        potential_ext = data_uri_parts.split('/')[-1]
                                        if potential_ext and re.match(r"^[a-zA-Z0-9]+$", potential_ext): # Basic check for valid extension chars
                                            file_ext = potential_ext
                                    break # Found the image block

                    image_filename = f"{base_prompt_snippet}_v{iteration_count}.{file_ext}"
                    image_path = images_dir / image_filename
                    with open(image_path, "wb") as f:
                        f.write(decoded_image_data)
                    logger.info(f"Generated image saved to: {image_path}")

                    user_feedback_action = ""
                    while True: # Inner loop for user satisfaction
                        user_input = input(f"Image saved as {image_filename}. Are you satisfied? (yes/no/quit): ").strip().lower()
                        if user_input in ["yes", "y"]:
                            user_feedback_action = "satisfied"
                            break
                        elif user_input in ["quit", "q"]:
                            user_feedback_action = "quit"
                            break
                        elif user_input in ["no", "n"]:
                            feedback = input("Feedback to improve (or type 'new' for new prompt, 'quit'): ").strip()
                            if feedback.lower() == 'quit':
                                user_feedback_action = "quit"
                                break
                            elif feedback.lower() == 'new':
                                new_prompt = input("Enter new initial prompt: ").strip()
                                if new_prompt:
                                    initial_prompt_text = new_prompt # This is the new base for feedback
                                    current_prompt_text = initial_prompt_text
                                    base_prompt_snippet = sanitize_filename(initial_prompt_text)
                                    if not base_prompt_snippet or base_prompt_snippet == "image":
                                        base_prompt_snippet = "prompt_image"
                                    iteration_count = 0 # Reset for new prompt idea, will be 1 on next loop
                                    user_feedback_action = "regenerate_new"
                                else: 
                                    logger.info("Empty new prompt, continuing with current image or quitting.")
                                    # Let them re-evaluate the current image or quit
                                    print("No new prompt entered. Please rate the current image again or quit.")
                                    continue # Go back to "Are you satisfied?"
                                break # Exit feedback loop, go to outer loop check
                            elif feedback: # User provided feedback for current prompt
                                current_prompt_text = initial_prompt_text + ". Additional feedback: " + feedback
                                user_feedback_action = "regenerate_feedback"
                                break # Exit feedback loop, go to outer loop check
                            else: # Empty feedback
                                print("No feedback provided. Please provide feedback, or type 'new' or 'quit'.")
                        else: # Invalid input for satisfaction
                            print("Invalid input. Please enter 'yes', 'no', or 'quit'.")
                    
                    if user_feedback_action == "satisfied":
                        logger.info("User satisfied. Ending AIGC session for this prompt.")
                        return True # Successfully generated and user is happy
                    elif user_feedback_action == "quit":
                        logger.info("User chose to quit. Ending AIGC session.")
                        return True # User quit, considered a graceful exit for the test
                    # If "regenerate_new" or "regenerate_feedback", the outer loop continues
                    elif user_feedback_action in ["regenerate_new", "regenerate_feedback"]:
                        continue

                except Exception as e:
                    logger.error(f"Failed to decode or save image: {e}")
                    if input("Error processing image. Quit session? (yes/no): ").strip().lower() in ["yes", "y"]:
                        return False # End test on error if user confirms
            else: # No image_base64_data
                logger.error("Failed to generate image in this attempt (no image data in response).")
                retry_input = input("Retry with current prompt? (yes/no/quit): ").strip().lower()
                if retry_input not in ["yes", "y"]:
                    logger.info("User chose not to retry or quit. Ending AIGC session.")
                    return False # End test if user doesn't want to retry failure
                else: # yes to retry
                    iteration_count -= 1 # Decrement to retry the same iteration number for the same prompt
                    continue
        
        logger.info("Interactive AIGC test finished (loop exited unexpectedly or user quit).")
        return True # Default return if loop finishes

    except ImportError:
        logger.error("langchain_google_genai or other necessary packages are not installed.")
        return False
    except Exception as e:
        logger.error(f"Error testing Gemini AIGC: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Test Google Gemini integration')
    parser.add_argument('--browser-use', action='store_true', help='Test with browser-use for web automation')
    parser.add_argument('--model', type=str, default="gemini-2.0-flash", help='Model name to use (default: gemini-2.0-flash)')
    parser.add_argument('--aigc', action='store_true', help='Test Gemini AIGC (image generation)') # New argument
    args = parser.parse_args()
    
    if args.browser_use:
        success = test_with_browser_use(args.model)
        if success:
            print("\nBrowser-use test completed successfully!")
        else:
            print("\nBrowser-use test failed. Please check the logs for details.")
    elif args.aigc: # New condition for AIGC test
        # For async functions called from sync context in __main__
        success = asyncio.run(test_gemini_aigc()) 
        if success:
            print("\nGemini AIGC test completed successfully!")
        else:
            print("\nGemini AIGC test failed. Please check the logs for details.")
    else:
        success = test_gemini(args.model)
        if success:
            print("\nTest completed successfully!")
        else:
            print("\nTest failed. Please check the logs for details.") 