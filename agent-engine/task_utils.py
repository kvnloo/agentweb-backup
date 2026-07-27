import os
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple, Union
import boto3
import random
import logging
import sys
import json
import hashlib
from urllib.parse import quote
import aiohttp
from browser_use.agent.views import ActionResult
from aws_utils import get_dynamodb_resource, get_s3_client, get_bedrock_client
import secrets_manager
from pydantic import SecretStr
from langchain_aws import ChatBedrock
from langchain_openai import AzureChatOpenAI, ChatOpenAI
import html
import time
import uuid
import base64
import xml.etree.ElementTree as ET
import yaml
import tempfile
import threading
import asyncio
import datetime
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import re
import requests

# Configure logging
logger = logging.getLogger(__name__)

# Get table prefix based on NODE_ENV
TABLE_PREFIX = 'Dev-' if os.getenv('NODE_ENV') == 'development' else ''

# Global variable for vision support
global_use_vision = True

# Initialize DynamoDB client
dynamodb = get_dynamodb_resource()

def convert_svg_to_png(svg_path: str, output_path: str, dpi: int = 300, width: int = None, height: int = None) -> bool:
    """
    Convert an SVG file to high-quality PNG format using cairosvg.
    
    Args:
        svg_path: Path to the input SVG file
        output_path: Path where the PNG file should be saved
        dpi: Dots per inch for high-quality output (default: 300)
        width: Target width in pixels (optional, maintains aspect ratio if not specified)
        height: Target height in pixels (optional, maintains aspect ratio if not specified)
        
    Returns:
        bool: True if conversion was successful, False otherwise
    """
    try:
        import cairosvg
        from PIL import Image
        import io
        
        # Convert SVG to high-resolution PNG bytes using cairosvg
        # Use high DPI for better quality
        png_bytes = cairosvg.svg2png(
            url=svg_path,
            dpi=dpi,
            output_width=width,
            output_height=height
        )
        
        # Open the PNG bytes with PIL to ensure it's a valid image
        image = Image.open(io.BytesIO(png_bytes))
        
        # Save as high-quality PNG with optimization
        image.save(output_path, "PNG", optimize=True, compress_level=6)
        
        logger.info(f"Successfully converted SVG {svg_path} to high-quality PNG {output_path} (DPI: {dpi}, Size: {image.size})")
        return True
        
    except ImportError:
        logger.error("cairosvg or PIL not installed. Install with: pip install cairosvg Pillow")
        return False
    except Exception as e:
        logger.error(f"Error converting SVG to PNG: {e}")
        return False

def create_jwt_token(user_id: str) -> str:
    """
    Create a JWT token for the given user_id using JWT_SECRET.
    
    Args:
        user_id: The user ID to create the token for
        
    Returns:
        JWT token string or None if creation fails
    """
    try:
        import jwt
        from datetime import datetime, timedelta
        
        jwt_secret = os.getenv('JWT_SECRET')
        if not jwt_secret:
            logger.error("JWT_SECRET environment variable not set")
            return None
            
        # Create payload with user_id and expiration
        payload = {
            'userId': user_id,
            'exp': datetime.utcnow() + timedelta(hours=1),  # Token expires in 1 hour
            'iat': datetime.utcnow()
        }
        
        # Create JWT token
        token = jwt.encode(payload, jwt_secret, algorithm='HS256')
        return token
        
    except Exception as e:
        logger.error(f"Error creating JWT token: {e}")
        return None

def generate_content_hash(content: Any) -> str:
    """Generate a hash of the content to use as a filename.
    
    This function converts the content to a sorted, normalized JSON string
    and then generates an MD5 hash of that string. This ensures that identical
    content will always produce the same hash, preventing duplicate files.
    
    Args:
        content: The content to hash (typically a JSON object)
        
    Returns:
        A 16-character hexadecimal hash string
    """
    # Convert the content to a sorted, normalized string to ensure consistent hashing
    content_str = json.dumps(content, sort_keys=True)
    # Generate a hash of the content
    return hashlib.md5(content_str.encode('utf-8')).hexdigest()[:16]

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

async def download_file_from_url(url: str, save_dir: Path, file_type: str = "file") -> Tuple[str, str]:
    """
    Download a file from a URL and save it to the specified directory.
    
    This is a common utility function that can be used for downloading both images and files.
    
    Args:
        url: The URL to download from
        save_dir: The directory to save the file in
        file_type: The type of file being downloaded (e.g., "image", "file", "report")
        
    Returns:
        Tuple of (filename, success_message) or raises an exception on failure
    """
    try:
        # Generate a random 8-character filename
        random_name = ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=8))
        
        # Get extension from URL or default based on file_type
        if '.' in url.split('/')[-1]:
            ext = url.split('.')[-1]
        else:
            # Default extensions based on file type
            if file_type == "image":
                ext = 'jpg'
            elif file_type == "report":
                ext = 'html'
            else:
                ext = 'txt'
        
        filename = f"{random_name}.{ext}"
        filepath = save_dir / filename
        
        # Download the file
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                if response.status != 200:
                    raise Exception(f"Failed to download {file_type}: HTTP {response.status}")
                
                # Read and save the file
                file_data = await response.read()
                filepath.write_bytes(file_data)
        
        msg = f"Downloaded {file_type} to {filename} in {save_dir.name} folder"
        logger.info(msg)
        return filename, msg
        
    except Exception as e:
        logger.error(f'Error in download_file_from_url: {str(e)}')
        raise Exception(f'Failed to download {file_type}: {str(e)}')

def get_agent_code_base_path(user_id: str, task_id: Optional[str] = None) -> str:
    """
    Get the base path for agent code files in the GitHub repository.
    
    This function constructs the path based on the environment (production or development)
    and the provided user_id and task_id.
    
    Args:
        user_id: The user ID
        task_id: Optional task ID to include in the path
        
    Returns:
        A string representing the path to the agent code directory in the GitHub repository
    """
    # Determine environment based on NODE_ENV
    env = os.getenv('NODE_ENV')
    env_path = 'dev' if env == 'development' else 'prod'
    
    # Create base path with user_id
    base_path = f"agent-scripts/{env_path}/{user_id}"
    
    # Add task_id if provided
    if task_id:
        base_path = f"{base_path}/{task_id}"
    
    return base_path

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
            azure_endpoint=secrets_manager.get_azure_openai_endpoint(),
            azure_deployment=deployment_name,
            api_key=secrets_manager.get_azure_openai_api_key(),
            api_version=secrets_manager.get_azure_openai_api_version(),
            temperature=0.0
        )
    except Exception as e:
        logger.error(f"Error initializing Azure OpenAI: {e}")
        logger.error("Please ensure all Azure OpenAI environment variables are set correctly.")
        sys.exit(1)

def get_azure_openai_llm2(model_name: str):
    """Initialize Azure OpenAI language model"""
    try:
        deployment_name = model_name # use model name as deployment name in Azure portal

        return AzureChatOpenAI(
            model_name=model_name,
            azure_endpoint=secrets_manager.get_azure_openai_endpoint2(),
            azure_deployment=deployment_name,
            api_key=secrets_manager.get_azure_openai_api_key2(),
            api_version=secrets_manager.get_azure_openai_api_version2(),
            temperature=0.0
        )
    except Exception as e:
        logger.error(f"Error initializing Azure OpenAI: {e}")
        logger.error("Please ensure all Azure OpenAI environment variables are set correctly.")
        sys.exit(1)

def get_azure_openai_llm3(model_name: str):
    """Initialize Azure OpenAI language model"""
    try:
        deployment_name = model_name # use model name as deployment name in Azure portal

        return AzureChatOpenAI(
            model_name=model_name,
            azure_endpoint=secrets_manager.get_azure_openai_endpoint3(),
            azure_deployment=deployment_name,
            api_key=secrets_manager.get_azure_openai_api_key3(),
            api_version=secrets_manager.get_azure_openai_api_version3(),
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
            azure_endpoint=secrets_manager.get_azure_openai_endpoint(),
            azure_deployment=deployment_name,
            api_key=secrets_manager.get_azure_openai_api_key(),
            api_version=secrets_manager.get_azure_openai_api_version(default='2024-09-12')
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
        api_key = secrets_manager.get_deepseek_api_key()
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
        api_key = secrets_manager.get_pld_deepseek_api_key()
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
    if model_name == "gpt-5":
        # Use Gemini 2.5 Flash as a proxy for gpt-5
        return get_gemini_llm("gemini-2.5-flash")
    
    """Initialize OpenAI language model"""
    try:
        api_key = secrets_manager.get_openai_api_key()
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
        api_key = secrets_manager.get_openai_api_key()
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

def get_gemini_llm(model_name: str, code_execution: bool = False):
    """Initialize Google Gemini language model"""
    try:
        api_key = secrets_manager.get_gemini_api_key()
        if not api_key:
            raise ValueError('GEMINI_API_KEY is not set')
            
        # Import here to avoid requiring the package for all users
        from langchain_google_genai import ChatGoogleGenerativeAI
        
        llm = ChatGoogleGenerativeAI(
            model=model_name,
            api_key=SecretStr(api_key),
            temperature=0.0
        )

        # Enable code execution for Gemini models only if requested
        if code_execution:
            return llm.bind(code_execution=True)
        else:
            return llm

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
    # Each provider can have a default function that will be used for any model not explicitly listed
    VALID_CONFIGURATIONS = {
        "aws": {
            "anthropic": {
                "__default__": get_aws_bedrock_llm,  # Default function for any AWS Anthropic model
                "anthropic.claude-3-5-sonnet-20241022-v2:0": get_aws_bedrock_llm,
                "us.anthropic.claude-3-7-sonnet-20250219-v1:0": get_aws_bedrock_llm
            }
        },
        "azure": {
            "openai": {
                "__default__": get_azure_openai_llm,  # Default function for any Azure OpenAI model
                "gpt-4o": get_azure_openai_llm,
                "o1-mini": get_azure_openai_llm_o1,
                "gpt-4.1": get_azure_openai_llm2,
                "gpt-5-chat": get_azure_openai_llm3,
            }
        },
        "deepseek": {
            "deepseek": {
                "__default__": get_deepseek_llm,  # Default function for any DeepSeek model
                "deepseek-reasoner": get_deepseek_llm
            }
        },
        "pld": {
            "deepseek": {
                "__default__": get_pld_deepseek_llm,  # Default function for any PLD DeepSeek model
                "DeepSeek-R1": get_pld_deepseek_llm
            }
        },
        "openai": {
            "openai": {
                "__default__": get_openai_llm,  # Default function for any OpenAI model
                "gpt-4o": get_openai_llm,
                "gpt-4o-mini": get_openai_llm,
                "o3-mini": get_openai_llm_think,
                "gpt-5": get_openai_llm,
            }
        },
        "google": {
            "google": {
                "__default__": get_gemini_llm,  # Default function for any Google Gemini model
                "gemini-2.0-flash": get_gemini_llm,
                "gemini-2.5-pro-preview-03-25": get_gemini_llm,
                "gemini-2.5-pro-preview-05-06": get_gemini_llm,
                "gemini-2.5-pro": get_gemini_llm,
                "gemini-2.0-flash-exp": get_gemini_llm,
                "gemini-2.5-flash": get_gemini_llm
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
        # Try to use the default function for this provider
        default_func = provider_config.get("__default__")
        if default_func:
            logger.info(f"Model '{model_name}' not explicitly configured for provider '{provider}' on platform '{platform}', using default function")
            init_func = default_func
        else:
            logger.error(f"Invalid model '{model_name}' for provider '{provider}' on platform '{platform}' and no default function available")
            logger.error(f"Valid models are: {[k for k in provider_config.keys() if k != '__default__']}")
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
            # Check if there are already uploaded files for this execution
            existing_files = []
            try:
                table = get_dynamodb_resource().Table(f'{TABLE_PREFIX}AW-TaskExecutions')
                response = table.get_item(Key={'executionId': execution_id})
                if 'Item' in response and 'result_files' in response['Item']:
                    existing_files = response['Item']['result_files']
                    logger.info(f"Found {len(existing_files)} previously uploaded files for execution {execution_id}")
            except Exception as e:
                logger.error(f"Error checking for existing files: {e}")
                # Continue with empty existing_files list
            
            # Extract existing filenames for quick lookup
            existing_filenames = {file_info.get('filename'): file_info for file_info in existing_files}
            
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
            
            # First, add all existing files to the result_files list
            result_files.extend(existing_files)
            
            for file_path in downloads_dir.glob('*'):
                if file_path.is_file():
                    try:
                        # Check if this file has already been uploaded
                        if file_path.name in existing_filenames:
                            logger.info(f"File {file_path.name} already uploaded, skipping")
                            continue
                        
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
                            # Also set file_type based on view_type
                            view_type = viewable_types[file_ext]['view_type']
                            if view_type == 'image':
                                file_info['file_type'] = 'image'
                            elif view_type == 'html':
                                file_info['file_type'] = 'html'
                            elif view_type == 'pdf':
                                file_info['file_type'] = 'pdf'
                            elif view_type == 'text':
                                file_info['file_type'] = 'text'
                            
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

class LogSyncManager:
    """Manages continuous syncing of log files to S3 using a simple polling approach"""
    
    def __init__(self, log_file: str, user_id: str, execution_id: str):
        """Initialize the LogSyncManager
        
        Args:
            log_file: Path to the log file
            user_id: User ID
            execution_id: Execution ID
        """
        self.log_file = log_file
        self.user_id = user_id
        self.execution_id = execution_id
        self.should_stop = False
        self.last_content_hash = None
        self.s3_url = None
        self.sync_thread = None
        self.sync_interval = 30  # seconds between sync checks
    
    def start_watching(self) -> Optional[str]:
        """Start syncing the log file periodically
        
        Returns:
            Optional[str]: URL of the uploaded log file if successful, None otherwise
        """
        try:
            log_path = Path(self.log_file)
            if not log_path.exists():
                # Create an empty placeholder file if it doesn't exist yet
                os.makedirs(os.path.dirname(self.log_file), exist_ok=True)
                with open(self.log_file, 'w') as f:
                    f.write(f"Log file initialized for execution {self.execution_id} at {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                logger.info(f"Created placeholder log file: {self.log_file}")
            
            # Initial upload
            self.s3_url = self.sync_log_file()
            
            # Start the sync thread
            self.should_stop = False
            self.sync_thread = threading.Thread(target=self._sync_loop)
            self.sync_thread.daemon = True
            self.sync_thread.start()
            logger.info(f"Started log sync thread for file: {self.log_file}")
            
            return self.s3_url
            
        except Exception as e:
            logger.error(f"Error starting log sync manager: {e}")
            self.stop_watching()
            return None
    
    def _sync_loop(self):
        """Background thread that syncs the log file at regular intervals"""
        try:
            while not self.should_stop:
                try:
                    # Use multiple smaller sleep intervals instead of one long sleep
                    # This allows the thread to respond to stop signals more quickly
                    for _ in range(int(self.sync_interval * 2)):  # Split into half-second intervals
                        if self.should_stop:
                            break
                        time.sleep(0.5)  # Sleep for half second at a time
                    
                    if not self.should_stop:
                        logger.info(f"Checking log file after {self.sync_interval}s interval")
                        self.sync_log_file()
                except Exception as e:
                    logger.error(f"Error in sync loop: {e}")
                    # If there's an error, wait a bit and continue
                    time.sleep(5)
        except Exception as e:
            logger.error(f"Fatal error in sync loop: {e}")
    
    def sync_log_file(self) -> Optional[str]:
        """Sync the log file to S3 using upload_activity_log for consistency
        
        Returns:
            Optional[str]: URL of the uploaded log file if successful, None otherwise
        """
        try:
            if not Path(self.log_file).exists():
                logger.warning(f"Log file does not exist during sync: {self.log_file}")
                return None
                
            # Read the log file and calculate hash to avoid redundant uploads
            try:
                with open(self.log_file, 'r') as f:
                    log_content = f.read()
                    
                # If file is empty, don't upload
                if not log_content.strip():
                    logger.debug("Log file is empty, skipping upload")
                    return self.s3_url
                    
                content_hash = hashlib.md5(log_content.encode()).hexdigest()
                
                # Skip upload if content hasn't changed
                if content_hash == self.last_content_hash and self.s3_url:
                    logger.debug("Log content unchanged, skipping upload")
                    return self.s3_url
                    
                logger.info(f"Log content changed (hash: {content_hash[:8]}), uploading to S3")
                self.last_content_hash = content_hash
            except Exception as read_error:
                logger.error(f"Error reading log file: {read_error}")
                # If we can't read the file, try to upload it anyway
                logger.info("Attempting to upload despite read error")
                
            # Use the standard upload_activity_log function for consistency
            url = upload_activity_log(self.log_file, self.user_id, self.execution_id)
            
            if url:
                self.s3_url = url
                logger.info(f"Successfully synced log to S3: {url}")
            else:
                logger.warning("Log sync completed but no URL was returned")
            
            return url
            
        except Exception as e:
            logger.error(f"Error syncing log file to S3: {e}")
            return None
    
    def stop_watching(self):
        """Stop syncing the log file"""
        try:
            # Stop the sync thread
            self.should_stop = True
            
            # Wait for thread to finish if it's running
            if self.sync_thread and self.sync_thread.is_alive():
                try:
                    # Use a shorter timeout to avoid hanging (2 seconds instead of 5)
                    timeout = 2.0
                    logger.info(f"Waiting up to {timeout}s for sync thread to complete...")
                    self.sync_thread.join(timeout=timeout)
                    
                    # Check if thread is still alive after timeout
                    if self.sync_thread.is_alive():
                        logger.warning(f"Sync thread did not terminate within {timeout}s timeout")
                        # We'll continue anyway since it's a daemon thread
                    else:
                        logger.info(f"Sync thread terminated successfully")
                        
                    logger.info(f"Stopped log sync thread for file: {self.log_file}")
                except Exception as join_error:
                    # Use print as a fallback in case logging is shutting down
                    print(f"Error stopping sync thread: {join_error}")
                
        except Exception as e:
            # Use print instead of logger to avoid issues during shutdown
            print(f"Error stopping log file watcher: {e}")
            try:
                logger.error(f"Error stopping log file watcher: {e}")
            except:
                pass

def start_log_sync(log_file_path: str, user_id: str, execution_id: str):
    """Start real-time log syncing for the given log file
    
    Args:
        log_file_path: Path to the log file to sync
        user_id: User ID
        execution_id: Execution ID
        
    Returns:
        LogSyncManager instance
    """
    # Create logs directory if needed
    os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
    
    # Initialize log file if it doesn't exist yet
    if not Path(log_file_path).exists():
        with open(log_file_path, 'w') as f:
            f.write(f"Log file initialized at {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
        logger.info(f"Created initial log file: {log_file_path}")
    
    # Start the log sync manager to upload log files in real-time
    log_sync_manager = LogSyncManager(log_file_path, user_id, execution_id)
    log_url = log_sync_manager.start_watching()
    if log_url:
        logger.info(f"Started real-time log syncing to S3: {log_url}")
        
    return log_sync_manager

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
        
        # Check if there's already an S3 URL for this execution
        table = get_dynamodb_resource().Table(f'{TABLE_PREFIX}AW-TaskExecutions')
        execution_record = table.get_item(
            Key={'executionId': execution_id},
            ProjectionExpression='browser_use_log'
        ).get('Item', {})
        
        existing_url = execution_record.get('browser_use_log')
        s3_key = None
        
        # Extract s3_key from existing URL if available
        if existing_url and existing_url.startswith(f"https://{s3_bucket}.s3.amazonaws.com/"):
            s3_key = existing_url.replace(f"https://{s3_bucket}.s3.amazonaws.com/", "")
            try:
                logger.info(f"Reusing existing S3 destination: {s3_key}")
            except:
                print(f"Reusing existing S3 destination: {s3_key}")
        else:
            # Generate a random token for this upload
            random_token = ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=20))
            s3_key = f"execution_logs/{user_id}/activities_{execution_id}_{random_token}.log"
            try:
                logger.info(f"Created new S3 destination: {s3_key}")
            except:
                print(f"Created new S3 destination: {s3_key}")

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
    <title>Task Execution Log - {execution_id}</title>
    <style>
        pre {{
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: monospace;
            padding: 20px;
            margin: 0;
        }}
        .timestamp {{
            color: #777;
            font-size: 0.8em;
            margin-top: 20px;
            text-align: right;
        }}
    </style>
    <script>
        // Check URL for refresh parameter and set up refresh if needed
        window.addEventListener('load', function() {{
            // Parse URL parameters
            const urlParams = new URLSearchParams(window.location.search);
            const refreshInterval = urlParams.get('refresh');
            
            // If refresh parameter exists and is a number, set up refresh
            if (refreshInterval && !isNaN(refreshInterval) && parseInt(refreshInterval) > 0) {{
                const refreshValue = parseInt(refreshInterval);
                console.log('Setting up refresh every ' + refreshValue + ' seconds');
                
                // Set up meta refresh
                const metaRefresh = document.createElement('meta');
                metaRefresh.setAttribute('http-equiv', 'refresh');
                metaRefresh.setAttribute('content', refreshValue.toString());
                document.head.appendChild(metaRefresh);
            }} else {{
                console.log('No refresh parameter found or invalid value, not refreshing');
            }}
        }});
    </script>
</head>
<body>
    <pre>{escaped_content}</pre>
    <div class="timestamp">Last updated: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</div>
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
        try:
            logger.info(f"Uploaded activity log to S3: {s3_key}")
        except:
            print(f"Uploaded activity log to S3: {s3_key}")
        
        # Generate the URL
        url = f"https://{s3_bucket}.s3.amazonaws.com/{s3_key}"
        
        # Update execution record with log URL if not already set
        if not existing_url:
            table.update_item(
                Key={'executionId': execution_id},
                UpdateExpression='SET browser_use_log = :log_url',
                ExpressionAttributeValues={
                    ':log_url': url
                }
            )
            try:
                logger.info(f"Updated execution record with log URL: {url}")
            except:
                print(f"Updated execution record with log URL: {url}")
        
        # Clean up temporary HTML file only
        Path(html_file).unlink()
        try:
            logger.debug("Cleaned up temporary HTML file")
        except:
            pass
        
        return url
        
    except Exception as e:
        try:
            logger.error(f"Error uploading activity log: {e}")
        except:
            print(f"Error uploading activity log: {e}")
            
        # Clean up any temporary files
        for temp_file in [log_file + '.html']:
            try:
                if Path(temp_file).exists():
                    Path(temp_file).unlink()
            except Exception as cleanup_error:
                try:
                    logger.error(f"Error cleaning up temporary file {temp_file}: {cleanup_error}")
                except:
                    print(f"Error cleaning up temporary file {temp_file}: {cleanup_error}")
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
            
        # Use the current Azure GPT-5 deployment for comparison
        llm = get_azure_openai_llm3('gpt-5-chat')
        
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
    """Extract JSON objects from content that contains ```json code blocks.
    
    This function specifically looks for JSON blocks that start with ```json.
    It handles both complete blocks (ending with ```) and truncated blocks.
    For truncated blocks, it attempts to find the last valid closing brace
    and completes the JSON structure.
    
    Args:
        content_list: List of content strings to extract JSON from
        
    Returns:
        List[Dict[str, Any]]: List of extracted JSON objects
    """
    import re
    import json
    
    json_objects = []
    
    if not isinstance(content_list, list):
        # If content_list is not a list, convert it to a list with a single item
        content_list = [content_list]
        
    for content in content_list:
        if not content or not isinstance(content, str):
            continue
            
        # Find all blocks that start with ```json
        # This pattern captures everything after ```json until the end of the string
        # or until the next ``` marker
        json_blocks = re.findall(r'```json\s*(.*?)(?:```|$)', content, re.DOTALL)
        
        for json_str in json_blocks:
            try:
                # Try to parse as is first
                json_obj = json.loads(json_str)
                json_objects.append(json_obj)
                logger.info("Successfully parsed complete JSON block")
            except json.JSONDecodeError:
                # If parsing fails, assume it might be truncated
                logger.info("JSON parsing failed, attempting to fix truncated JSON")
                
                # Determine if it's an object or array
                is_array = json_str.strip().startswith('[')
                
                if is_array:
                    # Handle truncated array
                    try:
                        # Find the last complete object in the array
                        last_brace_index = json_str.rfind('}')
                        if last_brace_index != -1:
                            # Extract up to the last closing brace and add closing bracket
                            fixed_json = json_str[:last_brace_index+1] + ']'
                            json_obj = json.loads(fixed_json)
                            json_objects.append(json_obj)
                            logger.info("Successfully extracted truncated JSON array")
                        else:
                            logger.warning("Could not find a complete object in the truncated array")
                    except json.JSONDecodeError as e:
                        logger.warning(f"Failed to extract truncated JSON array: {e}")
                else:
                    # Handle truncated object
                    try:
                        # Check if this is an object with a nested array that's truncated
                        array_pattern = r'"([^"]+)"\s*:\s*\[\s*{.*'
                        array_matches = re.findall(array_pattern, json_str, re.DOTALL)
                        
                        if array_matches:
                            # This is an object with a truncated array
                            array_key = array_matches[0]
                            
                            # Find the last complete object in the array
                            # First, find the array start
                            array_start = json_str.find('[', json_str.find(array_key))
                            
                            # Find all complete objects in the array
                            objects_in_array = []
                            open_braces = 0
                            start_pos = None
                            
                            for i in range(array_start + 1, len(json_str)):
                                if json_str[i] == '{' and open_braces == 0:
                                    start_pos = i
                                    open_braces += 1
                                elif json_str[i] == '{':
                                    open_braces += 1
                                elif json_str[i] == '}':
                                    open_braces -= 1
                                    if open_braces == 0 and start_pos is not None:
                                        # Found a complete object
                                        objects_in_array.append(json_str[start_pos:i+1])
                                        start_pos = None
                            
                            if objects_in_array:
                                # Reconstruct the JSON with the complete objects
                                # First, get everything before the array
                                prefix = json_str[:array_start+1]
                                
                                # Construct the fixed JSON
                                fixed_json = prefix + ','.join(objects_in_array) + ']}'
                                
                                try:
                                    json_obj = json.loads(fixed_json)
                                    json_objects.append(json_obj)
                                    logger.info("Successfully reconstructed object with truncated array")
                                except json.JSONDecodeError:
                                    # If that fails, try adding closing braces
                                    open_count = fixed_json.count('{')
                                    close_count = fixed_json.count('}')
                                    
                                    if open_count > close_count:
                                        fixed_json += '}' * (open_count - close_count)
                                        
                                        try:
                                            json_obj = json.loads(fixed_json)
                                            json_objects.append(json_obj)
                                            logger.info("Successfully fixed object with truncated array by adding closing braces")
                                        except json.JSONDecodeError:
                                            logger.warning("Failed to fix object with truncated array")
                        else:
                            # Regular truncated object without nested array
                            # Find the last valid closing brace
                            last_brace_index = json_str.rfind('}')
                            if last_brace_index != -1:
                                # Extract up to the last closing brace
                                fixed_json = json_str[:last_brace_index+1]
                                
                                # Try to parse the fixed JSON
                                try:
                                    json_obj = json.loads(fixed_json)
                                    json_objects.append(json_obj)
                                    logger.info("Successfully extracted truncated JSON object")
                                except json.JSONDecodeError:
                                    # If direct parsing fails, try a more aggressive approach
                                    # This handles cases where the JSON is truncated in the middle of a nested structure
                                    
                                    # Count opening and closing braces to find complete objects
                                    open_count = fixed_json.count('{')
                                    close_count = fixed_json.count('}')
                                    
                                    # If we have more opening braces than closing, we need to add closing braces
                                    if open_count > close_count:
                                        # Add missing closing braces
                                        fixed_json += '}' * (open_count - close_count)
                                        
                                        try:
                                            json_obj = json.loads(fixed_json)
                                            json_objects.append(json_obj)
                                            logger.info("Successfully extracted truncated JSON object with added closing braces")
                                        except json.JSONDecodeError:
                                            logger.warning("Failed to parse truncated JSON even with added closing braces")
                                            
                                            # If still failing, try to extract key properties
                                            # Extract all complete key-value pairs
                                            pattern = r'"([^"]+)"\s*:\s*("[^"]*"|null|true|false|\d+|\{[^}]*\})'
                                            matches = list(re.finditer(pattern, json_str))
                                            if matches:
                                                # Reconstruct a valid JSON object with the properties we found
                                                props = []
                                                for match in matches:
                                                    props.append(f'{match.group(0)}')
                                                fixed_json = '{' + ','.join(props) + '}'
                                                try:
                                                    json_obj = json.loads(fixed_json)
                                                    json_objects.append(json_obj)
                                                    logger.info("Successfully reconstructed partial JSON object")
                                                except json.JSONDecodeError:
                                                    logger.warning("Failed to reconstruct partial JSON object")
                            else:
                                # If no complete object is found, try to extract what we can
                                # Find the last property that has a complete value
                                pattern = r'"([^"]+)"\s*:\s*("[^"]*"|null|true|false|\d+)'
                                matches = list(re.finditer(pattern, json_str))
                                if matches:
                                    # Reconstruct a valid JSON object with the properties we found
                                    props = []
                                    for match in matches:
                                        props.append(f'{match.group(0)}')
                                    fixed_json = '{' + ','.join(props) + '}'
                                    try:
                                        json_obj = json.loads(fixed_json)
                                        json_objects.append(json_obj)
                                        logger.info("Successfully reconstructed partial JSON object")
                                    except json.JSONDecodeError:
                                        logger.warning("Failed to reconstruct partial JSON object")
                                else:
                                    logger.warning("Could not find any complete properties in the truncated object")
                    except Exception as e:
                        logger.warning(f"Failed to extract truncated JSON object: {e}")
    
    return json_objects 

async def call_github_api(
    method: str,
    endpoint: str,
    json_data: Optional[Dict[str, Any]] = None
) -> Tuple[int, Union[Dict[str, Any], List[Dict[str, Any]], str], Optional[str]]:
    """Make a call to the GitHub API with proper authentication and error handling.
    
    This function centralizes GitHub API calls to ensure consistent authentication,
    error handling, and logging across different API operations.
    
    Args:
        method: HTTP method ("get", "post", "put", "delete")
        endpoint: GitHub API endpoint path (e.g., "/repos/{owner}/{repo}/contents/{path}")
        json_data: Optional JSON data to send with the request (for POST/PUT methods)
        
    Returns:
        Tuple containing:
        - HTTP status code
        - Response data (parsed JSON or text if not JSON)
        - Error message if there was an error, None otherwise
    """
    # GitHub repository information
    owner = "john-the-dev"
    repo = "agentweb-agentcode"
    
    # Get GitHub API key
    github_api_key = os.getenv('GITHUB_API_KEY')
    if not github_api_key:
        return 401, {}, "GitHub API key not found in environment"
    
    # Set up headers with authorization
    headers = {
        "Authorization": f"token {github_api_key}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    # Format endpoint with owner and repo if needed
    if "{owner}" in endpoint and "{repo}" in endpoint:
        endpoint = endpoint.format(owner=owner, repo=repo)
    
    # Construct full URL
    api_base = "https://api.github.com"
    if not endpoint.startswith(api_base):
        # If endpoint starts with /, remove it to avoid double slash
        if endpoint.startswith('/'):
            endpoint = endpoint[1:]
        api_url = f"{api_base}/{endpoint}"
    else:
        api_url = endpoint
    
    logger.info(f"Making GitHub API {method.upper()} request to: {api_url}")
    
    # Make the API request
    try:
        async with aiohttp.ClientSession() as session:
            # Choose the appropriate method
            if method.lower() == "get":
                async with session.get(api_url, headers=headers) as response:
                    status = response.status
                    if status == 200:
                        try:
                            # Try to parse as JSON
                            result = await response.json()
                        except:
                            # If not JSON, return text
                            result = await response.text()
                        return status, result, None
                    else:
                        error_text = await response.text()
                        logger.error(f"GitHub API error: {status} - {error_text}")
                        return status, error_text, f"GitHub API error: {status}"
            
            elif method.lower() == "post":
                async with session.post(api_url, headers=headers, json=json_data) as response:
                    status = response.status
                    if status in [200, 201]:
                        try:
                            result = await response.json()
                        except:
                            result = await response.text()
                        return status, result, None
                    else:
                        error_text = await response.text()
                        logger.error(f"GitHub API error: {status} - {error_text}")
                        return status, error_text, f"GitHub API error: {status}"
            
            elif method.lower() == "put":
                async with session.put(api_url, headers=headers, json=json_data) as response:
                    status = response.status
                    if status in [200, 201]:
                        try:
                            result = await response.json()
                        except:
                            result = await response.text()
                        return status, result, None
                    else:
                        error_text = await response.text()
                        logger.error(f"GitHub API error: {status} - {error_text}")
                        return status, error_text, f"GitHub API error: {status}"
            
            elif method.lower() == "delete":
                async with session.delete(api_url, headers=headers) as response:
                    status = response.status
                    if status in [200, 204]:
                        try:
                            result = await response.json()
                        except:
                            result = await response.text() if response.content_length and response.content_length > 0 else ""
                        return status, result, None
                    else:
                        error_text = await response.text()
                        logger.error(f"GitHub API error: {status} - {error_text}")
                        return status, error_text, f"GitHub API error: {status}"
            else:
                return 400, {}, f"Unsupported HTTP method: {method}"
    
    except Exception as e:
        error_msg = f"Error making GitHub API request: {str(e)}"
        logger.error(error_msg)
        return 500, {}, error_msg 

def run_python_code_in_sandbox(
    python_code: str, 
    execution_id: str,
    user_id: str,
    script_type: str = "script",
    header_comment: Optional[str] = None,
    additional_env_vars: Optional[Dict[str, str]] = None
) -> ActionResult:
    """Execute Python code in a sandboxed environment.
    
    This function creates a temporary file in an isolated directory and executes
    the provided Python code with limited permissions and environment variables.
    It handles timeouts, captures output, and cleans up temporary files.
    
    Args:
        python_code: The Python code to execute
        execution_id: Current execution ID, used to create an isolated directory
        user_id: User ID for creating user-specific directories
        script_type: Type of script for naming (e.g., "github", "integration")
        header_comment: Optional header comment to add to the script
        additional_env_vars: Optional additional environment variables for the execution
        
    Returns:
        ActionResult object containing execution output or error
    """
    import tempfile
    import subprocess
    import uuid
    import os
    import shutil
    import zipfile
    from pathlib import Path
    from browser_use.agent.views import ActionResult
    
    try:
        # Create a temporary directory with the execution ID for isolation
        temp_dir = tempfile.gettempdir()
        execution_subdir = os.path.join(temp_dir, f"execution_{execution_id}")
        
        # Create the execution-specific directory if it doesn't exist
        os.makedirs(execution_subdir, exist_ok=True)
        
        # Set permissions to restrict access (0o700 = rwx------)
        os.chmod(execution_subdir, 0o700)
        
        # Create a temporary file within the execution-specific directory
        script_id = uuid.uuid4()
        temp_file_path = os.path.join(execution_subdir, f"{script_type}_{script_id}.py")
        
        # Add a header comment if provided
        if header_comment:
            final_code = f"{header_comment}\n\n{python_code}"
        else:
            final_code = python_code
            
        # Add python-dotenv import and loading at the start of the code
        final_code = f"""from dotenv import load_dotenv
import os

# Load environment variables from .env file
load_dotenv()

{final_code}
"""
        
        # Write the code to the temporary file
        with open(temp_file_path, "w") as f:
            f.write(final_code)
            
        # Create a temporary .env file with the credentials
        env_file_path = os.path.join(execution_subdir, ".env")
        with open(env_file_path, "w") as f:
            # Write any additional environment variables to .env
            if additional_env_vars:
                for key, value in additional_env_vars.items():
                    f.write(f"{key}={value}\n")
        
        logger.info(f"Created temporary script at {temp_file_path}")
        
        # Execute the script with a timeout
        try:
            # Get timeout from environment variable
            timeout_seconds = int(os.getenv('SANDBOX_TIMEOUT_SECONDS', '300'))
            logger.info(f"Executing {script_type} script with timeout of {timeout_seconds} seconds")
            
            # Use a restricted environment for the subprocess
            env = {
                "PATH": os.environ.get("PATH", ""),  # Needed to find Python executable
                "PYTHONPATH": execution_subdir,  # Set PYTHONPATH to only the execution directory for isolation
                "LANG": os.environ.get("LANG", "en_US.UTF-8"),  # Basic locale setting
                "PYTHONIOENCODING": os.environ.get("PYTHONIOENCODING", "utf-8"),  # Ensure proper encoding
                "TEMP": temp_dir,  # Provide access to temp directory
                "TMP": temp_dir,  # Provide access to temp directory
                "EXECUTION_ID": execution_id  # Allow tracking which execution this is
            }
            
            # Add any additional environment variables
            if additional_env_vars:
                env.update(additional_env_vars)
            
            result = subprocess.run(
                ["python", temp_file_path],
                capture_output=True,
                text=True,
                timeout=timeout_seconds,  # Use timeout from environment variable
                cwd=execution_subdir,  # Run from the isolated directory
                env=env  # Use the restricted environment
            )
            
            # Process the result
            if result.returncode == 0:
                output = result.stdout
                
                # Check if there are files in the data folder
                data_folder = os.path.join(execution_subdir, "data")
                if os.path.exists(data_folder) and any(os.scandir(data_folder)):
                    try:
                        # Create downloads directory with user_id
                        downloads_path = get_downloads_path(user_id=user_id, execution_id=execution_id)
                        os.makedirs(downloads_path, exist_ok=True)
                        
                        # Create zip file
                        zip_filename = "output.zip"
                        zip_path = os.path.join(downloads_path, zip_filename)
                        
                        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                            for root, _, files in os.walk(data_folder):
                                for file in files:
                                    file_path = os.path.join(root, file)
                                    arcname = os.path.relpath(file_path, data_folder)
                                    zipf.write(file_path, arcname)
                        
                        logger.info(f"Created zip file with output files at {zip_path}")
                    except Exception as e:
                        logger.error(f"Error creating zip file: {str(e)}")
                
                return ActionResult(extracted_content=output if output else f"Code executed successfully with no output")
            else:
                error_msg = result.stderr
                return ActionResult(error=f"Execution failed: {error_msg}")
                
        except subprocess.TimeoutExpired:
            return ActionResult(error=f"Execution timed out after {timeout_seconds} seconds")
            
        except Exception as e:
            return ActionResult(error=f"Error during execution: {str(e)}")
        
        finally:
            # Clean up
            try:
                if os.path.exists(temp_file_path):
                    os.remove(temp_file_path)
                if os.path.exists(env_file_path):
                    os.remove(env_file_path)
                logger.info(f"Cleaned up temporary files")
            except Exception as e:
                logger.warning(f"Failed to clean up temporary files: {str(e)}")
    
    except Exception as e:
        logger.error(f"Error setting up Python code execution: {str(e)}")
        return ActionResult(error=f"Failed to execute Python code: {str(e)}") 

def decrypt_password(encrypted_password: str, user_id: str, shared_by: str = None) -> str:
    """Decrypt password using JWT_SECRET. For shared passwords, use the sharer's userId."""
    try:
        import jwt
        import base64
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        
        # First try to decode as encrypted format
        logger.info(f"Decrypting password for user {user_id} with shared_by {shared_by}")
        try:
            # Decode base64 string
            combined = base64.b64decode(encrypted_password)
            
            # Extract IV (first 16 bytes), encrypted data, and auth tag (last 16 bytes)
            iv = combined[:16]
            auth_tag = combined[-16:]
            encrypted_data = combined[16:-16]
            
            # Derive key using PBKDF2 (same as in Node.js)
            kdf = PBKDF2HMAC(
                algorithm=hashes.SHA256(),
                length=32,
                salt=b'salt',
                iterations=100000,
            )
            # Convert JWT_SECRET to bytes for key derivation
            secret_bytes = os.getenv('JWT_SECRET').encode('utf-8')
            key = kdf.derive(secret_bytes)
            
            # Create AESGCM instance with derived key
            aesgcm = AESGCM(key)
            
            # Decrypt the data
            decrypted = aesgcm.decrypt(iv, encrypted_data + auth_tag, None)
            signed_password = decrypted.decode('utf-8')
            
            # Decode the signed password
            decoded = jwt.decode(signed_password, os.getenv('JWT_SECRET'), algorithms=['HS256'])
        except Exception as e:
            # If decryption fails, try as old signed format
            logger.info("Decryption failed, trying old signed format")
            decoded = jwt.decode(encrypted_password, os.getenv('JWT_SECRET'), algorithms=['HS256'])

        # For shared passwords, verify against the original sharer's userId
        expected_user_id = shared_by if shared_by else user_id
        if decoded['userId'] != expected_user_id:
            raise Exception("Invalid user ID in encrypted password")
        return decoded['password']
    except Exception as e:
        logger.error(f"Error decrypting password: {e}")
        raise Exception("Failed to decrypt password") 

def fetch_api_credentials(user_id: str, app_names=None):
    """
    Fetch API credentials for the specified apps or all available credentials if no app names provided.
    
    Args:
        user_id: The ID of the user whose API credentials to fetch
        app_names: Optional list of API app names to fetch credentials for.
                  If None, all available credentials are fetched.
    
    Returns:
        Dictionary containing:
        - api_credentials: Dict mapping app names to their credential values and placeholders
        - api_key_names: Dict mapping app names to their credential field names
    """
    if not user_id:
        return None, None
    
    try:
        table = dynamodb.Table(f'{TABLE_PREFIX}AW-Configs')
        api_credentials = {}
        api_key_names = {}
        
        # Build the filter expression based on whether specific app names were provided
        filter_expression = 'isApiConfig = :isApiConfig'
        expression_values = {
            ':userId': user_id,
            ':isApiConfig': True
        }
        
        if app_names:
            # Handle single app_name passed as string
            if isinstance(app_names, str):
                app_names = [app_names]
            
            # Verify all items in app_names are strings if provided
            if not all(isinstance(name, str) for name in app_names):
                logger.error("All API names must be strings")
                return None, None
            
            # Add app names to filter if specific ones were requested
            if len(app_names) == 1:
                filter_expression += ' AND appName = :appName'
                expression_values[':appName'] = app_names[0]
            else:
                app_name_values = {}
                app_name_filters = []
                
                for i, name in enumerate(app_names):
                    key = f':appName{i}'
                    app_name_values[key] = name
                    app_name_filters.append(f'appName = {key}')
                
                filter_expression += f" AND ({' OR '.join(app_name_filters)})"
                expression_values.update(app_name_values)
        
        # Get user's own API configs
        user_response = table.query(
            KeyConditionExpression='userId = :userId',
            FilterExpression=filter_expression,
            ExpressionAttributeValues=expression_values
        )
        
        items = user_response.get('Items', [])
        
        # If no direct matches or not all requested apps found, check for publicly shared API configs
        public_filter_expression = 'isApiConfig = :isApiConfig AND userId <> :userId'
        public_expression_values = {
            ':shareWithEveryone': 1,
            ':isApiConfig': True,
            ':userId': user_id
        }
        
        if app_names:
            # Add the same app name filtering for public configs
            if len(app_names) == 1:
                public_filter_expression += ' AND appName = :appName'
                public_expression_values[':appName'] = app_names[0]
            else:
                public_expression_values.update(app_name_values)
                public_filter_expression += f" AND ({' OR '.join(app_name_filters)})"
        
        public_response = table.query(
            IndexName='ShareWithEveryoneIndex',
            KeyConditionExpression='shareWithEveryone = :shareWithEveryone',
            FilterExpression=public_filter_expression,
            ExpressionAttributeValues=public_expression_values
        )
        items.extend(public_response.get('Items', []))
        
        # Process all API configs
        for config in items:
            app_name = config['appName']
            
            # Skip if we already have this app_name from user's own configs
            if app_name in api_credentials:
                continue
            
            shared_by = config.get('sharedBy')
            
            # Get the encrypted password from either encryptedPassword or legacy password field
            encrypted_password = config.get('encryptedPassword') or config.get('password')
            if not encrypted_password:
                logger.warning(f"No password found for {app_name}")
                continue
                
            # Decrypt the API key/secret
            api_key = decrypt_password(encrypted_password, user_id, shared_by)
            api_key_name = config['username']  # This is the API key name
            
            # Create the app-specific credential placeholder name
            app_name_clean = app_name.upper().replace(" ", "_").replace("-", "_")
            placeholder = f"YOUR_{app_name_clean}_API_CREDENTIAL"
            
            api_credentials[app_name] = {
                "value": api_key,
                "placeholder": placeholder
            }
            api_key_names[app_name] = api_key_name
            
            logger.info(f"Successfully retrieved credential for {app_name} (key name: {api_key_name})")
        
        return api_credentials, api_key_names
        
    except Exception as e:
        logger.error(f"Error fetching API credentials: {str(e)}")
        return None, None 

def get_all_configs(user_id: str, use_shared_browser: bool = False) -> List[Dict[str, Any]]:
    """
    Get configurations for a user based on the use_shared_browser flag.
    
    If use_shared_browser is True, it only fetches all publicly shared configurations (website and API).
    If use_shared_browser is False, it fetches only the user's own configurations (website and API).
    
    Args:
        user_id: The user ID to fetch configurations for
        use_shared_browser: Flag to indicate if running in shared browser mode
        
    Returns:
        A list of configuration dictionaries
    """
    if not user_id:
        logger.error("User ID not provided for get_all_configs")
        return []
        
    try:
        all_configs = []
        table = dynamodb.Table(f'{TABLE_PREFIX}AW-Configs')

        if use_shared_browser:
            logger.info(f"Fetching ALL publicly shared configurations, including user's own if public (use_shared_browser mode for user {user_id})")
            # Fetch all publicly shared configs (website and API)
            # regardless of who owns them.
            public_response = table.query(
                IndexName='ShareWithEveryoneIndex',
                KeyConditionExpression='shareWithEveryone = :shareWithEveryone',
                ExpressionAttributeValues={
                    ':shareWithEveryone': 1
                }
            )
            all_configs.extend(public_response.get('Items', []))
            logger.info(f"Retrieved {len(all_configs)} publicly shared configurations in use_shared_browser mode.")
        else:
            logger.info(f"Fetching USER'S OWN configurations for user {user_id} (standard mode, no public shared configs).")
            # Fetch only the user's own configs (website and API).
            response = table.query(
                KeyConditionExpression='userId = :userId',
                ExpressionAttributeValues={
                    ':userId': user_id
                }
            )
            all_configs.extend(response.get('Items', []))
            logger.info(f"Retrieved {len(all_configs)} of user's own configurations for user {user_id}.")
        
        return all_configs
        
    except Exception as e:
        logger.error(f"Error fetching configurations: {str(e)}")
        return []

def parse_json(text: str) -> Optional[Dict[str, Any]]:
    """
    Extract and parse JSON from text content.
    
    This function attempts to find and parse JSON in the provided text:
    1. First tries to parse the entire text directly
    2. If that fails, looks for content between the first { and last }
    
    Args:
        text: The text content that may contain JSON
        
    Returns:
        Parsed JSON object or None if no valid JSON was found
    """
    if not text or not isinstance(text, str):
        return None
    
    # Try parsing the entire text as JSON first (fastest path)
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass
    
    # If direct parsing fails, try to extract JSON between braces
    try:
        start_idx = text.find('{')
        end_idx = text.rfind('}')
        
        if start_idx != -1 and end_idx != -1 and start_idx < end_idx:
            potential_json = text[start_idx:end_idx+1]
            return json.loads(potential_json)
    except json.JSONDecodeError:
        pass
        
    # No valid JSON found
    return None

def is_page_broken(file_url: str, result_urls: list = None, timeout: int = 30) -> bool:
    """
    Check if an HTML page is broken by looking for relative image paths and missing referenced URLs.
    
    Args:
        file_url: URL of the HTML file to check
        result_urls: List of available URLs that should be referenced in the page
        timeout: Request timeout in seconds (default: 30)
        
    Returns:
        bool: True if the page is broken (has relative images or missing references), False otherwise
    """
    try:
        logger.info(f"🔍 Checking if page is broken: {file_url}")
        
        # Fetch the HTML content
        response = requests.get(file_url, timeout=timeout)
        if response.status_code != 200:
            logger.warning(f"⚠️  Could not fetch file to check for broken references: HTTP {response.status_code}")
            return True  # Consider it broken if we can't fetch it
        
        html_content = response.text
        
        # Check for relative image paths using regex
        relative_image_patterns = [
            r'src=["\'](?!https?://|data:)([^"\']*\.(?:png|jpg|jpeg|gif|svg|webp|bmp|ico))["\']',  # src="image.png" or src='image.png'
            r'src=["\'](?!https?://|data:)([^"\']*\.(?:png|jpg|jpeg|gif|svg|webp|bmp|ico))["\']',  # src="./image.png" or src='./image.png'
            r'src=["\'](?!https?://|data:)([^"\']*\.(?:png|jpg|jpeg|gif|svg|webp|bmp|ico))["\']',  # src="/assets/image.png" or src='/assets/image.png'
        ]
        
        has_relative_images = False
        for pattern in relative_image_patterns:
            if re.search(pattern, html_content, re.IGNORECASE):
                has_relative_images = True
                break
        
        # Check if any available URLs are not referenced in the HTML
        has_missing_references = False
        if result_urls:
            # Extract all URLs referenced in the HTML (src, href attributes)
            url_patterns = [
                r'src=["\']([^"\']+)["\']',  # src="url"
                r'href=["\']([^"\']+)["\']',  # href="url"
            ]
            
            referenced_urls = set()
            for pattern in url_patterns:
                matches = re.findall(pattern, html_content, re.IGNORECASE)
                for match in matches:
                    referenced_urls.add(match)
            
            # Check if any available URLs are not referenced in the HTML
            if result_urls:
                available_urls = set(result_urls)
                unreferenced_urls = available_urls - referenced_urls
                if unreferenced_urls:
                    has_missing_references = True
                    logger.info(f"🔍 Unreferenced available URLs: {list(unreferenced_urls)}")
        
        is_broken = has_relative_images or has_missing_references
        logger.info(f"🔍 Page broken: {is_broken} (relative_images: {has_relative_images}, missing_references: {has_missing_references})")
        return is_broken
        
    except Exception as e:
        logger.error(f"Error checking if page is broken in {file_url}: {e}")
        return True  # Consider it broken if we can't check it

# List of functions to be exported from this module
__all__ = [
    'get_downloads_path',
    'upload_task_result_files',
    'get_llm',
    'validate_content_format',
    'extract_json_from_content', 
    'generate_content_hash',
    'get_agent_code_base_path',
    'call_github_api',
    'run_python_code_in_sandbox',
    'decrypt_password',
    'fetch_api_credentials',
    'get_all_configs',
    'parse_json',
    'is_page_broken'
] 