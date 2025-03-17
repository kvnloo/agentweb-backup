import os
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple
import boto3
import random
import logging
import sys
from urllib.parse import quote
from aws_utils import get_dynamodb_resource, get_s3_client, get_bedrock_client
from pydantic import SecretStr
from langchain_aws import ChatBedrock
from langchain_openai import AzureChatOpenAI, ChatOpenAI

# Configure logging
logger = logging.getLogger(__name__)

# Get table prefix based on NODE_ENV
TABLE_PREFIX = 'Dev-' if os.getenv('NODE_ENV') == 'development' else ''

# Global variable for vision support
global_use_vision = True

def get_downloads_path(user_id: Optional[str] = None, execution_id: Optional[str] = None) -> str:
    """Get the downloads path for storing task outputs
    
    This is a shared utility function used by both web_agent.py and deep_research_agent.py
    to ensure consistent file storage location.
    
    Args:
        user_id: Optional user ID to create user-specific directory
        execution_id: Optional execution ID to create execution-specific directory
    
    Returns:
        str: Path to the downloads directory
    """
    if not execution_id:
        # Fallback to user directory if no execution ID
        base_path = Path('downloads') / (user_id or 'default')
    else:
        # Create execution-specific directory
        base_path = Path('downloads') / (user_id or 'default') / execution_id
    
    base_path.mkdir(parents=True, exist_ok=True)
    return str(base_path)

def get_aws_bedrock_llm(model_name: str):
    """Initialize AWS Bedrock language model"""
    try:
        # Get Bedrock client with no retries
        bedrock = get_bedrock_client()

        return ChatBedrock(
            client=bedrock,
            model_id=model_name,
            model_kwargs={"temperature": 0.0}
        )
    except Exception as e:
        if "AccessDeniedException" in str(e):
            logger.error("Error: The AWS user lacks permission to invoke Claude model in Bedrock.")
            logger.error("Please ensure the user has the necessary permissions and the model exists.")
            sys.exit(1)
        raise

def get_azure_openai_llm(model_name: str):
    """Initialize Azure OpenAI language model"""
    try:
        deployment_name = model_name # use model name as deployment name in Azure portal
        
        return AzureChatOpenAI(
            model_name=model_name,
            azure_endpoint=os.getenv('AZURE_OPENAI_ENDPOINT'),
            azure_deployment=deployment_name,
            api_key=os.getenv('AZURE_OPENAI_API_KEY'),
            api_version=os.getenv('AZURE_OPENAI_API_VERSION', '2024-08-01-preview'),
            temperature=0.0
        )
    except Exception as e:
        logger.error(f"Error initializing Azure OpenAI: {e}")
        logger.error("Please ensure all Azure OpenAI environment variables are set correctly.")
        sys.exit(1)

def get_azure_openai_llm_o1(model_name: str):
    """Initialize Azure OpenAI language model"""
    try:
        deployment_name = model_name # use model name as deployment name in Azure portal
        
        # O1 series model does not support temperature
        return AzureChatOpenAI(
            model_name=model_name,
            azure_endpoint=os.getenv('AZURE_OPENAI_ENDPOINT'),
            azure_deployment=deployment_name,
            api_key=os.getenv('AZURE_OPENAI_API_KEY'),
            api_version=os.getenv('AZURE_OPENAI_API_VERSION', '2024-09-12')
        )
    except Exception as e:
        logger.error(f"Error initializing Azure OpenAI: {e}")
        logger.error("Please ensure all Azure OpenAI environment variables are set correctly.")
        sys.exit(1)

def get_deepseek_llm(model_name: str):
    """Initialize DeepSeek language model"""
    global global_use_vision
    try:
        global_use_vision = False
        api_key = os.getenv('DEEPSEEK_API_KEY')
        if not api_key:
            raise ValueError('DEEPSEEK_API_KEY is not set')
            
        return ChatOpenAI(
            base_url='https://api.deepseek.com',
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
    except Exception as e:
        logger.error(f"Error initializing DeepSeek: {e}")
        logger.error("Please ensure DEEPSEEK_API_KEY environment variable is set correctly.")
        sys.exit(1)

def get_pld_deepseek_llm(model_name: str):
    """Initialize DeepSeek language model hosted on Pale Blue Dot"""
    global global_use_vision
    try:
        global_use_vision = False
        api_key = os.getenv('PLD_DEEPSEEK_API_KEY')
        if not api_key:
            raise ValueError('PLD_DEEPSEEK_API_KEY is not set')
            
        return ChatOpenAI(
            base_url='https://www.palebluedot.ai/api',
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
    except Exception as e:
        logger.error(f"Error initializing DeepSeek: {e}")
        logger.error("Please ensure PLD_DEEPSEEK_API_KEY environment variable is set correctly.")
        sys.exit(1)

def get_openai_llm(model_name: str):
    """Initialize OpenAI language model"""
    try:
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            raise ValueError('OPENAI_API_KEY is not set')
            
        return ChatOpenAI(
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
    except Exception as e:
        logger.error(f"Error initializing OpenAI: {e}")
        logger.error("Please ensure OPENAI_API_KEY environment variable is set correctly.")
        sys.exit(1)

def get_openai_llm_think(model_name: str):
    """Initialize OpenAI language model"""
    global global_use_vision
    try:
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            raise ValueError('OPENAI_API_KEY is not set')
            
        # For think model such as o3-mini, we disable vision: https://github.com/browser-use/browser-use/issues/283
        global_use_vision = False
        logger.warning(f"Vision is disabled for {model_name}. Execution details in gif will not be available.")
        return ChatOpenAI(
            model=model_name,
            api_key=SecretStr(api_key),
            disabled_params={"parallel_tool_calls": None}
        )
    except Exception as e:
        logger.error(f"Error initializing OpenAI: {e}")
        logger.error("Please ensure OPENAI_API_KEY environment variable is set correctly.")
        sys.exit(1)

def get_gemini_llm(model_name: str):
    """Initialize Google Gemini language model"""
    try:
        api_key = os.getenv('GEMINI_API_KEY')
        if not api_key:
            raise ValueError('GEMINI_API_KEY is not set')
            
        # Import here to avoid requiring the package for all users
        from langchain_google_genai import ChatGoogleGenerativeAI
        
        return ChatGoogleGenerativeAI(
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
    except ImportError:
        logger.error("langchain_google_genai package is not installed. Install it with: pip install langchain-google-genai")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Error initializing Gemini: {e}")
        logger.error("Please ensure GEMINI_API_KEY environment variable is set correctly.")
        sys.exit(1)

def get_llm(full_llm_name: str) -> Tuple[Any, str]:
    """Get the appropriate language model based on provided configuration
    
    Args:
        full_llm_name: Full LLM name in format platform->provider->model
        
    Returns:
        Tuple containing the initialized LLM and the full LLM name
    """
    # Define valid platform-provider-model combinations with their initialization functions
    VALID_CONFIGURATIONS = {
        "aws": {
            "anthropic": {
                "anthropic.claude-3-5-sonnet-20241022-v2:0": get_aws_bedrock_llm,
                "us.anthropic.claude-3-7-sonnet-20250219-v1:0": get_aws_bedrock_llm
            }
        },
        "azure": {
            "openai": {
                "gpt-4o": get_azure_openai_llm,
                "o1-mini": get_azure_openai_llm_o1
            }
        },
        "deepseek": {
            "deepseek": {
                "deepseek-reasoner": get_deepseek_llm
            }
        },
        "pld": {
            "deepseek": {
                "DeepSeek-R1": get_pld_deepseek_llm
            }
        },
        "openai": {
            "openai": {
                "gpt-4o": get_openai_llm,
                "gpt-4o-mini": get_openai_llm,
                "o3-mini": get_openai_llm_think
            }
        },
        "google": {
            "google": {
                "gemini-2.0-flash": get_gemini_llm
            }
        }
    }

    try:
        # Split the full LLM name but only convert platform and provider to lowercase
        parts = full_llm_name.split('->')
        if len(parts) != 3:
            raise ValueError(f"Invalid format: {full_llm_name}")
            
        platform = parts[0].lower()
        provider = parts[1].lower()
        model_name = parts[2]  # Keep original case for model name
    except ValueError:
        logger.error(f"Invalid FULL_LLM_NAME format: {full_llm_name}")
        logger.error("Format should be <platform>-><provider>-><model>")
        sys.exit(1)
    
    logger.info(f"Initializing LLM - Platform: {platform}, Provider: {provider}, Model: {model_name}")

    # Get the provider mapping for the platform
    platform_config = VALID_CONFIGURATIONS.get(platform)
    if not platform_config:
        logger.error(f"Unsupported platform: {platform}")
        logger.error(f"Valid platforms are: {list(VALID_CONFIGURATIONS.keys())}")
        sys.exit(1)

    # Get the model mapping for the provider
    provider_config = platform_config.get(provider)
    if not provider_config:
        logger.error(f"Invalid provider '{provider}' for platform '{platform}'")
        logger.error(f"Valid providers for {platform} are: {list(platform_config.keys())}")
        sys.exit(1)

    # Get the initialization function for the model
    init_func = provider_config.get(model_name)
    if not init_func:
        logger.error(f"Invalid model '{model_name}' for provider '{provider}' on platform '{platform}'")
        logger.error(f"Valid models are: {list(provider_config.keys())}")
        sys.exit(1)

    # Initialize the LLM using the mapped function
    return init_func(model_name), full_llm_name

def upload_task_result_files(downloads_path: str, execution_id: str) -> List[Dict[str, str]]:
    """Upload task result files from downloads directory to S3
    
    Args:
        downloads_path: Path to the downloads directory
        execution_id: Current execution ID
        
    Returns:
        List of dictionaries containing file information (url, filename, token)
    """
    result_files = []
    downloads_dir = Path(downloads_path)
    
    if downloads_dir.exists():
        try:
            # Generate a random token for this batch of files
            random_token = ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=20))
            s3_client = get_s3_client()
            s3_bucket = os.getenv('AWS_S3_BUCKET')
            
            # Define viewable file types with their MIME types
            viewable_types = {
                # Text formats
                '.html': {'content_type': 'text/html; charset=utf-8', 'view_type': 'html'},
                '.htm': {'content_type': 'text/html; charset=utf-8', 'view_type': 'html'},
                '.txt': {'content_type': 'text/plain; charset=utf-8', 'view_type': 'text'},
                '.json': {'content_type': 'application/json; charset=utf-8', 'view_type': 'text'},
                '.csv': {'content_type': 'text/csv; charset=utf-8', 'view_type': 'text'},
                '.xml': {'content_type': 'application/xml; charset=utf-8', 'view_type': 'text'},
                '.md': {'content_type': 'text/markdown; charset=utf-8', 'view_type': 'text'},
                '.js': {'content_type': 'application/javascript; charset=utf-8', 'view_type': 'text'},
                '.css': {'content_type': 'text/css; charset=utf-8', 'view_type': 'text'},
                
                # Image formats
                '.jpg': {'content_type': 'image/jpeg', 'view_type': 'image'},
                '.jpeg': {'content_type': 'image/jpeg', 'view_type': 'image'},
                '.png': {'content_type': 'image/png', 'view_type': 'image'},
                '.gif': {'content_type': 'image/gif', 'view_type': 'image'},
                '.svg': {'content_type': 'image/svg+xml', 'view_type': 'image'},
                '.webp': {'content_type': 'image/webp', 'view_type': 'image'},
                
                # PDF format
                '.pdf': {'content_type': 'application/pdf', 'view_type': 'pdf'},
            }
            
            for file_path in downloads_dir.glob('*'):
                if file_path.is_file():
                    try:
                        # Upload file to S3 with random token in path
                        s3_key = f"task_results/{execution_id}/{random_token}/{file_path.name}"
                        
                        # Get file extension (lowercase)
                        file_ext = file_path.suffix.lower()
                        
                        # Set content type and disposition based on file type
                        extra_args = {}
                        
                        if file_ext in viewable_types:
                            # For viewable files, set inline disposition to open in browser
                            content_type = viewable_types[file_ext]['content_type']
                            view_type = viewable_types[file_ext]['view_type']
                            
                            extra_args = {
                                'ContentDisposition': f'inline; filename="{file_path.name}"',
                                'ContentType': content_type
                            }
                        else:
                            # For other files, keep attachment disposition for download
                            extra_args = {'ContentDisposition': f'attachment; filename="{file_path.name}"'}
                            
                        s3_client.upload_file(
                            str(file_path),
                            s3_bucket,
                            s3_key,
                            ExtraArgs=extra_args
                        )
                        # Generate URL with proper encoding
                        encoded_key = quote(s3_key)
                        url = f"https://{s3_bucket}.s3.amazonaws.com/{encoded_key}"
                        
                        # Create file info dictionary
                        file_info = {
                            'url': url,
                            'filename': file_path.name,
                            'token': random_token,  # Store token for potential future validation
                        }
                        
                        # Add view type flag if this is a viewable file
                        if file_ext in viewable_types:
                            file_info['view_type'] = viewable_types[file_ext]['view_type']
                            
                        result_files.append(file_info)
                        logger.info(f"Uploaded result file to S3: {url}")
                    except Exception as e:
                        logger.error(f"Error uploading file {file_path} to S3: {e}")

            # Update execution record with result files if any were uploaded
            if result_files:
                try:
                    table = get_dynamodb_resource().Table(f'{TABLE_PREFIX}AW-TaskExecutions')
                    table.update_item(
                        Key={'executionId': execution_id},
                        UpdateExpression='SET result_files = :files',
                        ExpressionAttributeValues={
                            ':files': result_files
                        }
                    )
                    logger.info(f"Updated execution record with {len(result_files)} result files")
                except Exception as e:
                    logger.error(f"Error updating execution record with result files: {e}")
                    
        except Exception as e:
            logger.error(f"Error processing downloads directory: {e}")
            
    return result_files

def upload_activity_log(log_file: str, user_id: str, execution_id: str) -> Optional[str]:
    """Upload activity log file to S3 and update execution record
    
    Args:
        log_file: Path to the log file
        user_id: User ID
        execution_id: Execution ID
        
    Returns:
        Optional[str]: URL of the uploaded log file if successful, None otherwise
    """
    try:
        log_path = Path(log_file)
        if not log_path.exists():
            return None
            
        s3_client = get_s3_client()
        s3_bucket = os.getenv('AWS_S3_BUCKET')
        
        # Generate a random token for this upload
        random_token = ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=20))
        s3_key = f"execution_logs/{user_id}/activities_{execution_id}_{random_token}.log"

        # Read the log file and escape HTML content
        import html
        with open(log_file, 'r') as f:
            log_content = f.read()
            
        # Escape HTML content to prevent browser interpretation
        escaped_content = html.escape(log_content)
        
        html_content = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        pre {{
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: monospace;
            padding: 20px;
            margin: 0;
        }}
    </style>
</head>
<body>
    <pre>{escaped_content}</pre>
</body>
</html>"""

        # Create a temporary file for the HTML content
        html_file = log_file + '.html'
        with open(html_file, 'w') as f:
            f.write(html_content)

        # Upload HTML file to S3
        s3_client.upload_file(
            html_file,
            s3_bucket,
            s3_key,
            ExtraArgs={
                'ContentType': 'text/html; charset=utf-8',
                'ContentDisposition': 'inline'
            }
        )
        logger.info(f"Uploaded activity log to S3: {s3_key}")
        
        # Generate the URL
        url = f"https://{s3_bucket}.s3.amazonaws.com/{s3_key}"
        
        # Update execution record with log URL
        table = get_dynamodb_resource().Table(f'{TABLE_PREFIX}AW-TaskExecutions')
        table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET browser_use_log = :log_url',
            ExpressionAttributeValues={
                ':log_url': url
            }
        )
        
        # Clean up temporary files
        Path(html_file).unlink()
        Path(log_file).unlink()
        logger.info("Cleaned up temporary files")
        
        return url
        
    except Exception as e:
        logger.error(f"Error uploading activity log: {e}")
        # Clean up any temporary files
        for temp_file in [log_file, log_file + '.html']:
            try:
                if Path(temp_file).exists():
                    Path(temp_file).unlink()
            except Exception as cleanup_error:
                logger.error(f"Error cleaning up temporary file {temp_file}: {cleanup_error}")
        return None

def upload_gif(gif_path: str) -> Optional[str]:
    """Upload GIF file to S3
    
    Args:
        gif_path: Path to the GIF file
        
    Returns:
        Optional[str]: URL of the uploaded GIF if successful, None otherwise
    """
    try:
        gif_file = Path(gif_path)
        if not gif_file.exists():
            logger.warning(f"GIF file not found at path: {gif_path}")
            return None
            
        s3_client = get_s3_client()
        s3_bucket = os.getenv('AWS_S3_BUCKET')
        
        # Upload GIF to S3
        s3_key = f"execution_gifs/{gif_file.name}"
        
        s3_client.upload_file(
            gif_path,
            s3_bucket,
            s3_key,
            ExtraArgs={'ContentType': 'image/gif'}
        )
        
        # Generate and return URL
        url = f"https://{s3_bucket}.s3.amazonaws.com/{s3_key}"
        logger.info(f"Successfully uploaded GIF to S3, URL: {url}")
        
        # Clean up local file
        gif_file.unlink()
        logger.info(f"Removed local GIF file: {gif_path}")
        
        return url
        
    except Exception as e:
        logger.error(f"Error uploading GIF: {e}")
        return None

def validate_content_format(extension: str, content: str) -> Optional[str]:
    """Validate that the content matches the expected format for the given extension.
    
    Args:
        extension: File extension (lowercase, without the dot)
        content: Content to validate
        
    Returns:
        Optional[str]: Error message if validation fails, None if validation passes
    """
    try:
        # Skip validation for empty content
        if not content.strip():
            return "Content cannot be empty"
            
        # JSON validation
        if extension == 'json':
            try:
                import json
                json.loads(content)
            except json.JSONDecodeError as e:
                return f"Invalid JSON format: {str(e)}"
                
        # CSV validation
        elif extension == 'csv':
            # Basic CSV validation - check for comma-separated values
            lines = content.strip().split('\n')
            if not lines:
                return "CSV file must have at least one line"
                
            # Check if all rows have the same number of columns
            first_row_cols = lines[0].count(',') + 1
            for i, line in enumerate(lines[1:], 2):
                if line.count(',') + 1 != first_row_cols:
                    return f"CSV format error: Row {i} has a different number of columns than the header row"
                    
        # XML validation
        elif extension == 'xml':
            try:
                import xml.etree.ElementTree as ET
                ET.fromstring(content)
            except Exception as e:
                return f"Invalid XML format: {str(e)}"
                
        # HTML validation (basic check)
        elif extension == 'html' or extension == 'htm':
            if not content.strip().startswith(('<html', '<!DOCTYPE', '<HTML')):
                return "HTML content should start with <!DOCTYPE html> or <html> tag"
                
        # YAML validation
        elif extension == 'yaml' or extension == 'yml':
            try:
                import yaml
                yaml.safe_load(content)
            except Exception as e:
                return f"Invalid YAML format: {str(e)}"
                
        # No specific validation for other formats
        return None
            
    except Exception as e:
        logger.error(f"Error during content validation: {str(e)}")
        return f"Content validation error: {str(e)}"

def check_new_information(previous_result, current_result):
    """
    Use LLM to check if there is new information in the current task result compared to previous runs.
    
    Args:
        previous_result (str): The result of the previous task run
        current_result (str): The result of the current task run
        
    Returns:
        tuple: (has_new_info, summary) where has_new_info is a boolean indicating if new information was found
               and summary is a concise description of the new information (or None if no new info)
    """
    try:
        if not previous_result or not current_result:
            logger.info("Missing previous or current result for comparison")
            return False, None
            
        # Use O1-mini model for comparison
        llm = get_azure_openai_llm_o1('o1-mini')
        
        # Prepare the prompt for the LLM
        prompt = f"""
Compare the following two task results and determine if the current result contains any new or different information compared to the previous result.
If there is new information, provide a very concise summary (max 50 characters) of what's new or different.
If there is no new information, respond with "NO_NEW_INFO".

Previous result:
{previous_result}

Current result:
{current_result}

Your response should be in the format:
[YES/NO]
[Concise summary of new information or "NO_NEW_INFO"]
"""
        
        # Call the LLM
        response = llm.invoke(prompt)
        
        # Parse the response
        if not response or not response.content:
            logger.warning("Empty response from LLM when comparing results")
            return False, None
            
        llm_response = response.content.strip()
        lines = llm_response.split('\n')
        
        if len(lines) < 2:
            logger.warning(f"Unexpected LLM response format: {llm_response}")
            return False, None
            
        has_new_info = lines[0].upper() == "YES"
        summary = lines[1] if has_new_info else None
        
        if summary == "NO_NEW_INFO":
            summary = None
            
        logger.info(f"LLM comparison result: has_new_info={has_new_info}, summary={summary}")
        return has_new_info, summary
        
    except Exception as e:
        logger.error(f"Error checking for new information: {e}")
        return False, None

def extract_json_from_content(content_list: List[str]) -> List[Dict[str, Any]]:
    """Extract JSON objects from the extracted content
    
    Args:
        content_list: List of content strings to extract JSON from
        
    Returns:
        List[Dict[str, Any]]: List of extracted JSON objects
    """
    import re
    import json
    import logging
    
    json_objects = []
    
    if not isinstance(content_list, list):
        # If content_list is not a list, convert it to a list with a single item
        content_list = [content_list]
        
    for content in content_list:
        if not content or not isinstance(content, str):
            continue
            
        # Only extract JSON from code blocks with ```json marker
        if "```json" in content:
            # Extract the JSON part from code blocks
            json_matches = re.findall(r'```json\s*(.*?)\s*```', content, re.DOTALL)
            for json_str in json_matches:
                try:
                    json_obj = json.loads(json_str)
                    json_objects.append(json_obj)
                except json.JSONDecodeError:
                    logging.error(f"Failed to parse JSON from code block: {json_str[:100]}...")
        # Skip direct JSON parsing if ```json marker doesn't exist
                
    return json_objects 