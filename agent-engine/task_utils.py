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
        deployment_name = os.getenv('AZURE_OPENAI_DEPLOYMENT', 'agentweb')
        
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

def get_deepseek_llm(model_name: str):
    """Initialize DeepSeek language model"""
    try:
        api_key = os.getenv('DEEPSEEK_API_KEY')
        if not api_key:
            raise ValueError('DEEPSEEK_API_KEY is not set')
            
        return ChatOpenAI(
            base_url='https://api.deepseek.com/v1',
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )
    except Exception as e:
        logger.error(f"Error initializing DeepSeek: {e}")
        logger.error("Please ensure DEEPSEEK_API_KEY environment variable is set correctly.")
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
                "gpt-4o": get_azure_openai_llm
            }
        },
        "deepseek": {
            "deepseek": {
                "deepseek-reasoner": get_deepseek_llm
            }
        },
        "openai": {
            "openai": {
                "gpt-4o": get_openai_llm,
                "o3-mini": get_openai_llm_think
            }
        }
    }

    try:
        platform, provider, model_name = full_llm_name.lower().split('->')
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
            
            for file_path in downloads_dir.glob('*'):
                if file_path.is_file():
                    try:
                        # Upload file to S3 with random token in path
                        s3_key = f"task_results/{execution_id}/{random_token}/{file_path.name}"
                        
                        # Set different ContentDisposition for HTML files to allow viewing in browser
                        extra_args = {}
                        if file_path.suffix.lower() == '.html':
                            # For HTML files, set inline disposition to open in browser
                            extra_args = {'ContentDisposition': f'inline; filename="{file_path.name}"', 
                                         'ContentType': 'text/html; charset=utf-8'}
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
                        
                        # Add a flag to indicate if this is a viewable HTML file
                        file_info = {
                            'url': url,
                            'filename': file_path.name,
                            'token': random_token,  # Store token for potential future validation
                        }
                        
                        # Add a flag to indicate if this is a viewable HTML file
                        if file_path.suffix.lower() == '.html':
                            file_info['is_html'] = True
                            
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

        # Read the log file and wrap it in HTML with pre-formatting
        with open(log_file, 'r') as f:
            log_content = f.read()
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
    <pre>{log_content}</pre>
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
            return None
            
        s3_client = get_s3_client()
        s3_bucket = os.getenv('AWS_S3_BUCKET')
        
        # Upload GIF to S3
        s3_client.upload_file(
            gif_path,
            s3_bucket,
            f"execution_gifs/{gif_file.name}",
            ExtraArgs={'ContentType': 'image/gif'}
        )
        
        # Generate and return URL
        url = f"https://{s3_bucket}.s3.amazonaws.com/execution_gifs/{gif_file.name}"
        
        # Clean up local file
        gif_file.unlink()
        
        return url
        
    except Exception as e:
        logger.error(f"Error uploading GIF: {e}")
        return None 