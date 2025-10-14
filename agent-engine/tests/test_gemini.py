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
from typing import List, Optional, Dict, Any
from dotenv import load_dotenv
from pydantic import SecretStr, BaseModel
from browser_use import Agent, ActionResult, Controller
from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContextConfig, BrowserContext
import re # Added for sanitize_filename
import random # Added for sanitize_filename fallback
import base64 # Ensure base64 is imported at the top level
import mimetypes # For guessing mime type from file extension
import httpx # For fetching URL for base64 encoding if needed
import tempfile
import csv

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

async def get_image_input_content() -> Optional[Dict[str, Any]]:
    """Prompts user for an image input (path or URL) and returns the content dict for HumanMessage."""
    image_input_str = input("Provide input image path or URL (or press Enter to skip): ").strip()
    if not image_input_str:
        return None

    if image_input_str.startswith(("http://", "https://")):
        try:
            logger.info(f"Fetching image from URL: {image_input_str}")
            async with httpx.AsyncClient() as client: 
                response = await client.get(image_input_str, timeout=10.0)
            response.raise_for_status() 
            image_data = response.content
            mime_type = response.headers.get("content-type", "image/png") 
            
            # Adjust MIME type for API compatibility if it's SVG or doesn't fit pattern
            if not re.match(r"^image/\w{2,4}$", mime_type):
                logger.warning(f"Original MIME type \'{mime_type}\' might not be API compatible. Defaulting to image/png for data URI.")
                api_mime_type = "image/png"
            else:
                api_mime_type = mime_type

            encoded_image = base64.b64encode(image_data).decode("utf-8")
            image_uri = f"data:{api_mime_type};base64,{encoded_image}"
            logger.info(f"Successfully fetched image from URL. Original MIME: {mime_type}, Used for URI: {api_mime_type}")
            return {"type": "image_url", "image_url": {"url": image_uri}}
        except Exception as e:
            logger.error(f"Failed to fetch or encode image from URL \'{image_input_str}\': {e}. Using URL directly as fallback.")
            # Fallback: let the API try to handle the direct URL if our processing fails
            return {"type": "image_url", "image_url": {"url": image_input_str}}
    elif Path(image_input_str).is_file():
        try:
            image_path = Path(image_input_str)
            with open(image_path, "rb") as f:
                image_data = f.read()
            encoded_image = base64.b64encode(image_data).decode("utf-8")
            mime_type, _ = mimetypes.guess_type(image_path)
            if mime_type is None:
                mime_type = "image/png" 
                logger.warning(f"Could not guess MIME type for {image_path}, defaulting to {mime_type}")
            
            # Adjust MIME type for API compatibility
            if not re.match(r"^image/\w{2,4}$", mime_type):
                logger.warning(f"Original MIME type \'{mime_type}\' for local file might not be API compatible. Defaulting to image/png for data URI.")
                api_mime_type = "image/png"
            else:
                api_mime_type = mime_type

            image_uri = f"data:{api_mime_type};base64,{encoded_image}"
            logger.info(f"Successfully loaded local image: {image_path}. Original MIME: {mime_type}, Used for URI: {api_mime_type}")
            return {"type": "image_url", "image_url": {"url": image_uri}}
        except Exception as e:
            logger.error(f"Failed to read or encode local image file \'{image_input_str}\': {e}")
            return None
    else:
        logger.warning(f"Invalid image path or URL: {image_input_str}")
        return None

async def test_gemini_aigc(model_id="models/gemini-2.0-flash-preview-image-generation"):
    """Test the Google Gemini image generation (AIGC) integration interactively, with image input support."""
    load_dotenv()
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        return False

    logger.info(f"Starting interactive Gemini AIGC test with model: {model_id}")

    try:
        from langchain_core.messages import AIMessage, HumanMessage
        from langchain_google_genai import ChatGoogleGenerativeAI
        
        images_dir = Path("generated_images")
        images_dir.mkdir(parents=True, exist_ok=True)

        chat = ChatGoogleGenerativeAI(
            model=model_id,
            api_key=SecretStr(api_key),
            temperature=0.7, 
        )

        initial_prompt_text = input("Enter your initial text prompt (e.g., 'Make the cat wear a party hat'): ").strip()
        if not initial_prompt_text:
            logger.warning("No initial text prompt provided. Exiting AIGC test.")
            return False
        
        current_text_prompt = initial_prompt_text
        current_input_image_content = await get_image_input_content()

        base_prompt_snippet = sanitize_filename(current_text_prompt) 
        if not base_prompt_snippet or base_prompt_snippet == "image":
             base_prompt_snippet = "aigc_image"

        iteration_count = 0

        while True:
            iteration_count += 1
            logger.info(f"Image generation attempt {iteration_count} for text prompt: '{current_text_prompt}'" + 
                        (f" with input image." if current_input_image_content else " (text only)."))

            message_content_list = []
            message_content_list.append({"type": "text", "text": current_text_prompt})
            if current_input_image_content:
                message_content_list.append(current_input_image_content)
            
            # User message for Langchain needs to be a list of HumanMessage or string,
            # for multimodal input, it's more complex with HumanMessage containing list of dicts.
            # For simplicity with invoke, we will pass the structured list content.
            # The ChatGoogleGenerativeAI model internally handles construction of HumanMessage.
            
            response = None 
            try:
                # Langchain's ChatGoogleGenerativeAI invoke method can take a list of messages,
                # or a string. For multimodal, a HumanMessage with list content is typical.
                
                user_llm_message = HumanMessage(content=message_content_list)
                
                response = chat.invoke(
                    [user_llm_message],
                    generation_config=dict(response_modalities=["TEXT", "IMAGE"])
                )
                logger.info("Response received from AIGC model.")
            except Exception as e:
                logger.error(f"Error invoking LLM: {e}")
                retry_input = input("Retry? (yes/no/quit): ").strip().lower()
                if retry_input in ["no", "n", "quit", "q"]:
                    return False 
                elif retry_input in ["yes", "y"]:
                    iteration_count -=1 
                    continue 
                else: 
                    logger.warning("Invalid input. Exiting.")
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
                logger.info("Output image data received.")
                try:
                    decoded_image_data = base64.b64decode(image_base64_data)
                    file_ext = "png" 
                    if response and hasattr(response, 'content') and isinstance(response.content, list):
                        for block in response.content:
                             if isinstance(block, dict) and block.get("type") == "image_url" and block.get("image_url"):
                                image_url_dict = block["image_url"]
                                if isinstance(image_url_dict, dict) and "url" in image_url_dict:
                                    data_uri_parts = image_url_dict["url"].split(';')[0] 
                                    if data_uri_parts.startswith("data:image/"):
                                        potential_ext = data_uri_parts.split('/')[-1]
                                        if potential_ext and re.match(r"^[a-zA-Z0-9]+$", potential_ext):
                                            file_ext = potential_ext
                                    break 
                    image_filename = f"{base_prompt_snippet}_v{iteration_count}.{file_ext}"
                    image_path = images_dir / image_filename
                    with open(image_path, "wb") as f: f.write(decoded_image_data)
                    logger.info(f"Generated image saved to: {image_path}")

                    user_feedback_action = ""
                    while True: 
                        user_input = input(f"Image {image_filename} saved. Satisfied? (yes/no/quit): ").strip().lower()
                        if user_input in ["yes", "y"]: user_feedback_action = "satisfied"; break
                        elif user_input in ["quit", "q"]: user_feedback_action = "quit"; break
                        elif user_input in ["no", "n"]:
                            feedback_text = input("Feedback for text prompt (or Enter to keep current '{current_text_prompt}'): ").strip()
                            if feedback_text: current_text_prompt = feedback_text
                            
                            change_image_input_prompt = "Change input image?"
                            if current_input_image_content:
                                change_image_input_prompt += " (current: set, options: yes/no/remove, Enter to keep): "
                            else:
                                change_image_input_prompt += " (current: none, options: yes/no, Enter to keep none): "
                            
                            change_image_input = input(change_image_input_prompt).strip().lower()

                            if change_image_input == 'yes':
                                current_input_image_content = await get_image_input_content()
                            elif change_image_input == 'remove' and current_input_image_content: # only allow remove if image exists
                                current_input_image_content = None
                                logger.info("Input image removed for next generation.")
                            # If 'no' or Enter, or 'remove' when no image, current_input_image_content remains unchanged
                            elif change_image_input == 'no':
                                logger.info("Input image kept as is.")
                            elif not change_image_input: # Enter pressed
                                logger.info("Input image kept as is / no change.")
                            else:
                                logger.warning(f"Invalid input '{change_image_input}' for image change. Keeping current image setting.")


                            user_feedback_action = "regenerate_feedback"; break
                        else: print("Invalid input. Please enter 'yes', 'no', or 'quit'.")
                    
                    if user_feedback_action == "satisfied": logger.info("User satisfied."); return True
                    elif user_feedback_action == "quit": logger.info("User quit."); return True
                    elif user_feedback_action == "regenerate_feedback": continue

                except Exception as e:
                    logger.error(f"Failed to process/save image: {e}")
                    if input("Quit session due to error? (yes/no): ").strip().lower() in ["yes", "y"]:
                        return False
            else: 
                logger.error("Failed to generate image (no image data in response).")
                retry_input = input("Retry with current prompt & image? (yes/no/quit): ").strip().lower()
                if retry_input not in ["yes", "y"]:
                    logger.info("Not retrying. Ending session."); return False
                else: iteration_count -= 1; continue
        
        logger.info("Interactive AIGC test finished.")
        return True
    except ImportError:
        logger.error("Required packages (e.g., langchain_google_genai, httpx) not installed.")
        return False
    except Exception as e:
        logger.error(f"Error in AIGC test: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

async def test_gemini_code_execution(model_name="gemini-2.0-flash"):
    """Test the Google Gemini code execution integration"""
    load_dotenv()
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        return False

    logger.info(f"Testing Google Gemini code execution with model: {model_name}")

    try:
        from task_utils import get_gemini_llm

        # Use the same LLM initialization to ensure tools are bound
        llm = get_gemini_llm(model_name, code_execution=True)
        
        # Test with a simple prompt that should trigger code execution
        logger.info("Sending code execution prompt to Gemini model...")
        response = llm.invoke("What is 2*2, use python")

        logger.info("Response received:")
        logger.info(response.content)

        # Assert that the response contains the code execution result
        if isinstance(response.content, list):
            found_code_execution = any(
                c.get("type") == "executable_code" for c in response.content if isinstance(c, dict)
            )
            found_execution_result = any(
                c.get("type") == "code_execution_result" for c in response.content if isinstance(c, dict)
            )
            if found_code_execution and found_execution_result:
                logger.info("Test completed successfully!")
                return True
            else:
                logger.error("Response did not contain expected code execution output.")
                return False
        else:
            logger.error(f"Unexpected response format: {type(response.content)}")
            return False

    except Exception as e:
        logger.error(f"Error testing Gemini code execution: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

async def test_with_browser_use_code_execution_async(model_name="gemini-2.0-flash"):
    """Test using Gemini with browser-use for web automation with code execution enabled"""
    load_dotenv()
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        return False

    logger.info(f"Testing Google Gemini with browser-use and code execution using model: {model_name}")

    try:
        from task_utils import get_gemini_llm

        # Use the same LLM initialization as web_agent.py to ensure consistency
        llm = get_gemini_llm(model_name, code_execution=True)
        
        # Initialize Agent with the Gemini model and controller
        logger.info("Initializing Agent with Gemini model (with code execution)...")
        agent = Agent(
            task="Calculate what 2 * 2 equals using Python code execution. Return the result.",
            llm=llm
        )
        
        # Run the agent
        logger.info("Executing browser automation task with code execution...")
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
        
        # Check if code execution was used
        code_execution_used = False
        for step in result.history:
            if hasattr(step, 'result') and step.result:
                for action in step.result:
                    if hasattr(action, 'function_call'):
                        logger.info(f"Function called: {action.function_call}")
                        # Check if any code execution occurred
                        if hasattr(action, 'content') and isinstance(action.content, list):
                            for content_item in action.content:
                                if isinstance(content_item, dict):
                                    if content_item.get("type") == "executable_code":
                                        code_execution_used = True
                                        logger.info("Code execution detected in response!")
                                    elif content_item.get("type") == "code_execution_result":
                                        code_execution_used = True
                                        logger.info("Code execution result detected in response!")
        
        if code_execution_used:
            logger.info("✅ Code execution test with browser-use completed successfully!")
            return True
        else:
            logger.warning("⚠️ Task completed but no code execution was detected")
            logger.info("This might indicate the browser-use Agent is not properly handling the bound LLM")
            return False
        
    except Exception as e:
        logger.error(f"Error testing with browser-use and code execution: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_with_browser_use_code_execution(model_name="gemini-2.0-flash"):
    """Wrapper to run the async browser-use code execution test"""
    return asyncio.run(test_with_browser_use_code_execution_async(model_name))

async def test_gemini_file_input_with_sdk(model_name="gemini-2.0-flash"):
    """Test Google Gemini file input using the Google Gemini SDK directly"""
    load_dotenv()
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        return False

    logger.info(f"Testing Google Gemini file input with SDK using model: {model_name}")

    try:
        # Import Google Gemini SDK
        try:
            from google import genai
            from google.genai import types
        except ImportError:
            logger.error("Google Gemini SDK not installed. Install with: pip install google-genai")
            return False

        # Initialize the client
        client = genai.Client(api_key=api_key)
        
        # Create a temporary CSV file for testing
        sample_data = [
            ['name', 'age', 'city', 'salary'],
            ['Alice', '25', 'New York', '75000'],
            ['Bob', '30', 'Los Angeles', '85000'],
            ['Charlie', '35', 'Chicago', '90000'],
            ['Diana', '28', 'Boston', '80000'],
            ['Eve', '32', 'San Francisco', '95000']
        ]
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, newline='') as temp_file:
            writer = csv.writer(temp_file)
            writer.writerows(sample_data)
            temp_file_path = temp_file.name
        
        try:
            # Read the file content for inline data
            with open(temp_file_path, 'r') as f:
                file_content = f.read()
            
            # Test 1: Using inline data (file content as text)
            logger.info("Test 1: Using inline data (file content as text)...")
            
            response1 = client.models.generate_content(
                model=model_name,
                contents=[
                    {
                        "role": "user",
                        "parts": [
                            {
                                "text": f"Analyze this CSV data and provide insights. Use Python code execution to process the data:\n\n{file_content}"
                            }
                        ]
                    }
                ],
                config=types.GenerateContentConfig(
                    tools=[types.Tool(code_execution=types.ToolCodeExecution)]
                ),
            )
            
            logger.info("Response 1 received:")
            for part in response1.candidates[0].content.parts:
                if part.text is not None:
                    logger.info(f"Text: {part.text}")
                if part.executable_code is not None:
                    logger.info(f"Code: {part.executable_code.code}")
                if part.code_execution_result is not None:
                    logger.info(f"Result: {part.code_execution_result.output}")
            
            # Test 2: Using file upload via Files API (proper method)
            logger.info("Test 2: Using file upload via Files API...")
            
            try:
                # Upload file to Gemini Files API using the correct method
                with open(temp_file_path, 'rb') as f:
                    file_data = f.read()
                
                upload_response = client.files.upload(
                    data=file_data,
                    mime_type="text/csv"
                )
                
                file_uri = upload_response.file.name
                logger.info(f"File uploaded with URI: {file_uri}")
                
                # Use the uploaded file in the prompt
                response2 = client.models.generate_content(
                    model=model_name,
                    contents=[
                        {
                            "role": "user",
                            "parts": [
                                {
                                    "file_data": {
                                        "file_uri": file_uri,
                                        "mime_type": "text/csv"
                                    }
                                },
                                {
                                    "text": "Analyze this CSV file and provide insights. Use Python code execution to process the data."
                                }
                            ]
                        }
                    ],
                    config=types.GenerateContentConfig(
                        tools=[types.Tool(code_execution=types.ToolCodeExecution)]
                    ),
                )
                
                logger.info("Response 2 received:")
                for part in response2.candidates[0].content.parts:
                    if part.text is not None:
                        logger.info(f"Text: {part.text}")
                    if part.executable_code is not None:
                        logger.info(f"Code: {part.executable_code.code}")
                    if part.code_execution_result is not None:
                        logger.info(f"Result: {part.code_execution_result.output}")
                
                # Clean up uploaded file
                client.files.delete(file_uri)
                logger.info("Uploaded file cleaned up")
                
            except Exception as e:
                logger.warning(f"File upload test failed: {e}")
                logger.info("This might be due to API limitations or authentication issues.")
                logger.info("Continuing with inline data test only...")
            
            # Test 3: Using inline data with base64 encoding (alternative approach)
            logger.info("Test 3: Using inline data with base64 encoding...")
            
            import base64
            
            # Encode file content as base64
            file_content_bytes = file_content.encode('utf-8')
            file_content_b64 = base64.b64encode(file_content_bytes).decode('utf-8')
            
            response3 = client.models.generate_content(
                model=model_name,
                contents=[
                    {
                        "role": "user",
                        "parts": [
                            {
                                "inline_data": {
                                    "data": file_content_b64,
                                    "mime_type": "text/csv"
                                }
                            },
                            {
                                "text": "Analyze this CSV file and provide insights. Use Python code execution to process the data."
                            }
                        ]
                    }
                ],
                config=types.GenerateContentConfig(
                    tools=[types.Tool(code_execution=types.ToolCodeExecution)]
                ),
            )
            
            logger.info("Response 3 received:")
            for part in response3.candidates[0].content.parts:
                if part.text is not None:
                    logger.info(f"Text: {part.text}")
                if part.executable_code is not None:
                    logger.info(f"Code: {part.executable_code.code}")
                if part.code_execution_result is not None:
                    logger.info(f"Result: {part.code_execution_result.output}")
            
            # Check if responses contain code execution results
            success_count = 0
            
            # Check response 1
            found_code_execution1 = False
            found_execution_result1 = False
            for part in response1.candidates[0].content.parts:
                if part.executable_code is not None:
                    found_code_execution1 = True
                if part.code_execution_result is not None:
                    found_execution_result1 = True
            
            if found_code_execution1 and found_execution_result1:
                logger.info("✅ Test 1 (inline data) completed successfully!")
                success_count += 1
            else:
                logger.error("❌ Test 1 (inline data) failed - no code execution detected")
            
            # Check response 2 if it was successful
            if 'response2' in locals():
                found_code_execution2 = False
                found_execution_result2 = False
                for part in response2.candidates[0].content.parts:
                    if part.executable_code is not None:
                        found_code_execution2 = True
                    if part.code_execution_result is not None:
                        found_execution_result2 = True
                
                if found_code_execution2 and found_execution_result2:
                    logger.info("✅ Test 2 (file upload) completed successfully!")
                    success_count += 1
                else:
                    logger.error("❌ Test 2 (file upload) failed - no code execution detected")
            
            # Check response 3
            found_code_execution3 = False
            found_execution_result3 = False
            for part in response3.candidates[0].content.parts:
                if part.executable_code is not None:
                    found_code_execution3 = True
                if part.code_execution_result is not None:
                    found_execution_result3 = True
            
            if found_code_execution3 and found_execution_result3:
                logger.info("✅ Test 3 (base64 inline data) completed successfully!")
                success_count += 1
            else:
                logger.error("❌ Test 3 (base64 inline data) failed - no code execution detected")
            
            if success_count >= 1:
                logger.info(f"🎉 File input tests completed successfully! ({success_count} tests passed)")
                return True
            else:
                logger.error("❌ All file input tests failed")
                return False
                
        finally:
            # Clean up temporary file
            if os.path.exists(temp_file_path):
                os.unlink(temp_file_path)

    except Exception as e:
        logger.error(f"Error testing Gemini file input with SDK: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

async def test_gemini_video_understanding(model_name="gemini-2.0-flash"):
    """Test Gemini video understanding capabilities with YouTube videos and attached video files"""
    # Load environment variables from .env file
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set")
        return False
    
    logger.info(f"Testing Google Gemini video understanding with model: {model_name}")
    
    try:
        # Import here to avoid requiring the package for all users
        try:
            import google.generativeai as genai
        except ImportError:
            logger.error("google-generativeai package is not installed. Install it with: pip install google-generativeai")
            return False
        
        # Configure the API
        genai.configure(api_key=api_key)
        
        # Test 1: YouTube Video Summarization
        logger.info("Test 1: YouTube Video Summarization")
        logger.info("Testing with a sample YouTube video URL...")
        
        # Use a sample YouTube video URL (you can replace this with any public YouTube video)
        # Using a popular educational video about AI
        youtube_url = "https://www.youtube.com/watch?v=aircAruvnKk"  # 3Blue1Brown - But what is a neural network?
        
        try:
            # Import the proper Google Generative AI SDK
            try:
                from google import genai
                from google.genai import types
            except ImportError:
                logger.error("google-genai package is not installed. Install with: pip install google-genai")
                youtube_success = False
                return False
            
            # Create the client
            client = genai.Client(api_key=api_key)
            
            # Test YouTube video understanding using the proper API
            contents = [
                types.Content(
                    role="user",
                    parts=[
                        types.Part(
                            file_data=types.FileData(
                                file_uri=youtube_url,
                                mime_type="video/*",
                            )
                        ),
                        types.Part.from_text(text="""give a summary of the youtube video"""),
                    ],
                ),
            ]
            
            generate_content_config = types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(
                    thinking_budget=-1,
                ),
                response_mime_type="text/plain",
            )
            
            logger.info("Sending YouTube video analysis request...")
            
            # Collect the response
            response_text = ""
            for chunk in client.models.generate_content_stream(
                model=model_name,
                contents=contents,
                config=generate_content_config,
            ):
                if chunk.text:
                    response_text += chunk.text
            
            logger.info("YouTube Video Analysis Response:")
            logger.info(response_text)
            
            # Check if response contains meaningful content
            if response_text and len(response_text.strip()) > 50:
                logger.info("✅ YouTube video analysis test completed successfully!")
                youtube_success = True
            else:
                logger.error("❌ YouTube video analysis test failed - insufficient response")
                youtube_success = False
                
        except Exception as e:
            logger.error(f"❌ YouTube video analysis test failed: {e}")
            youtube_success = False
        
        # Test 2: Attached Video File Analysis
        logger.info("\nTest 2: Attached Video File Analysis")
        
        # Check if there's a sample video file in the input_images directory
        sample_video_path = Path("input_images/sample_video.mp4")
        video_file_success = False
        
        if sample_video_path.exists():
            logger.info(f"Found sample video file: {sample_video_path}")
            
            try:
                # Read the video file as binary data
                with open(sample_video_path, 'rb') as video_file:
                    video_data = video_file.read()
                
                # Test video file analysis with actual video data using proper SDK
                video_file_prompt = """
                Please analyze this video file and provide a comprehensive summary.
                
                Include:
                1. Video content and main subject
                2. Key visual and audio elements
                3. Duration and technical details
                4. Style and presentation
                5. Target audience
                6. Key messages or takeaways
                """
                
                logger.info("Sending video file analysis request with actual video data...")
                
                # Create content using the proper Google Generative AI SDK
                contents = [
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_bytes(
                                mime_type="video/mp4",
                                data=video_data
                            ),
                            types.Part.from_text(text=video_file_prompt),
                        ],
                    ),
                ]
                
                generate_content_config = types.GenerateContentConfig(
                    thinking_config=types.ThinkingConfig(
                        thinking_budget=-1,
                    ),
                    response_mime_type="text/plain",
                )
                
                # Collect the response
                response_text = ""
                for chunk in client.models.generate_content_stream(
                    model=model_name,
                    contents=contents,
                    config=generate_content_config,
                ):
                    if chunk.text:
                        response_text += chunk.text
                
                logger.info("Video File Analysis Response:")
                logger.info(response_text)
                
                # Check if response contains meaningful content
                if response_text and len(response_text.strip()) > 50:
                    logger.info("✅ Video file analysis test completed successfully!")
                    video_file_success = True
                else:
                    logger.error("❌ Video file analysis test failed - insufficient response")
                    video_file_success = False
                    
            except Exception as e:
                logger.error(f"❌ Video file analysis test failed: {e}")
                video_file_success = False
        else:
            logger.info("No sample video file found at input_images/sample_video.mp4")
            logger.info("To test video file analysis, please place a video file at input_images/sample_video.mp4")
            logger.info("Skipping video file analysis test...")
            video_file_success = False
        
        # Summary of results
        success_count = 0
        if youtube_success:
            success_count += 1
        if video_file_success:
            success_count += 1
        
        if success_count >= 1:
            logger.info(f"🎉 Video understanding tests completed! ({success_count}/2 tests passed)")
            logger.info("Note: YouTube video analysis may be limited by API capabilities.")
            return True
        else:
            logger.error("❌ All video understanding tests failed")
            return False
            
    except Exception as e:
        logger.error(f"Error testing Gemini video understanding: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Test Google Gemini integration')
    parser.add_argument('--browser-use', action='store_true', help='Test with browser-use for web automation')
    parser.add_argument('--model', type=str, default="gemini-2.0-flash", help='Model name to use for basic or browser-use tests (default: gemini-2.0-flash)')
    parser.add_argument('--aigc', action='store_true', help='Run interactive Gemini AIGC (image generation) test') 
    parser.add_argument('--aigc_model', type=str, default="models/gemini-2.0-flash-preview-image-generation", help='Model name for AIGC test (default: models/gemini-2.0-flash-preview-image-generation)')
    parser.add_argument('--code-exec', action='store_true', help='Run Gemini code execution test')
    parser.add_argument('--browser-use-code-exec', action='store_true', help='Run Gemini code execution test with browser-use Agent')
    parser.add_argument('--file-input', action='store_true', help='Run Gemini file input test with SDK')
    parser.add_argument('--video-understanding', action='store_true', help='Run Gemini video understanding test (YouTube and attached video)')
    
    args = parser.parse_args()
    
    if args.aigc: # Prioritize AIGC if flag is set
        success = asyncio.run(test_gemini_aigc(model_id=args.aigc_model)) 
        if success:
            print("\nGemini AIGC test completed.")
        else:
            print("\nGemini AIGC test failed or exited early.")
    elif args.browser_use_code_exec:
        success = test_with_browser_use_code_execution(args.model)
        if success:
            print("\nBrowser-use code execution test completed successfully!")
        else:
            print("\nBrowser-use code execution test failed. This confirms the bug.")
    elif args.browser_use:
        success = test_with_browser_use(args.model)
        if success:
            print("\nBrowser-use test completed successfully!")
        else:
            print("\nBrowser-use test failed. Please check the logs for details.")
    elif args.code_exec:
        success = asyncio.run(test_gemini_code_execution(model_name=args.model))
        if success:
            print("\nGemini code execution test completed successfully!")
        else:
            print("\nGemini code execution test failed.")
    elif args.file_input:
        success = asyncio.run(test_gemini_file_input_with_sdk(model_name=args.model))
        if success:
            print("\nGemini file input test completed successfully!")
        else:
            print("\nGemini file input test failed.")
    elif args.video_understanding:
        success = asyncio.run(test_gemini_video_understanding(model_name=args.model))
        if success:
            print("\nGemini video understanding test completed successfully!")
        else:
            print("\nGemini video understanding test failed.")
    else:
        success = test_gemini(args.model)
        if success:
            print("\nBasic test completed successfully!")
        else:
            print("\nTest failed. Please check the logs for details.") 