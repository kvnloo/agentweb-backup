import os
from pathlib import Path
from typing import Optional, Dict, Any, List
import boto3
import random
import logging
from urllib.parse import quote
from aws_utils import get_dynamodb_resource, get_s3_client

# Configure logging
logger = logging.getLogger(__name__)

# Get table prefix based on NODE_ENV
TABLE_PREFIX = 'Dev-' if os.getenv('NODE_ENV') == 'development' else ''

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
                        s3_client.upload_file(
                            str(file_path),
                            s3_bucket,
                            s3_key,
                            ExtraArgs={'ContentDisposition': f'attachment; filename="{file_path.name}"'}
                        )
                        # Generate URL with proper encoding
                        encoded_key = quote(s3_key)
                        url = f"https://{s3_bucket}.s3.amazonaws.com/{encoded_key}"
                        result_files.append({
                            'url': url,
                            'filename': file_path.name,
                            'token': random_token  # Store token for potential future validation
                        })
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