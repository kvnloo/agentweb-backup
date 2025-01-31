import os
import json
import hashlib
from pathlib import Path
from typing import Optional, Dict
import logging
from aws_utils import get_s3_client
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class CookieSync:
    def __init__(self):
        # Initialize S3 client
        self.s3 = get_s3_client()
        self.bucket_name = os.getenv('AWS_S3_BUCKET_INTERNAL')
        if not self.bucket_name:
            raise ValueError("AWS_S3_BUCKET_INTERNAL environment variable must be set")
        self._cookie_hashes: Dict[str, str] = {}
        # Get environment prefix for S3 paths
        self.env_prefix = 'dev/' if os.getenv('NODE_ENV') == 'development' else 'prod/'
        logger.info(f"Initialized CookieSync with environment prefix: {self.env_prefix}")

    def _calculate_file_hash(self, file_path: str) -> str:
        """Calculate SHA-256 hash of a file"""
        sha256_hash = hashlib.sha256()
        with open(file_path, "rb") as f:
            for byte_block in iter(lambda: f.read(4096), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()

    def _get_hash_key(self, user_id: str, cookie_path: Path) -> str:
        """Get the hash key for a user's cookie file"""
        return f"{self.env_prefix}{user_id}:{cookie_path.name}"

    def _get_s3_key(self, user_id: str, cookie_path: Path) -> str:
        """Get the S3 key with environment prefix"""
        return f"{self.env_prefix}cookies/{user_id}/{cookie_path.name}"

    def upload_cookies(self, user_id: str, cookie_file_path: str) -> bool:
        """
        Upload cookie file to S3 if changed
        
        Args:
            user_id: The user's ID
            cookie_file_path: Path to the cookie file
            
        Returns:
            bool: True if successful, False otherwise
        """
        try:
            cookie_path = Path(cookie_file_path)
            if not cookie_path.exists():
                logger.error(f"Cookie file not found: {cookie_file_path}")
                return False

            # Calculate current file hash
            current_hash = self._calculate_file_hash(cookie_file_path)
            hash_key = self._get_hash_key(user_id, cookie_path)

            # Check if file has changed
            if hash_key in self._cookie_hashes and self._cookie_hashes[hash_key] == current_hash:
                logger.info(f"Cookie file unchanged for user {user_id}, skipping upload")
                return True

            s3_key = self._get_s3_key(user_id, cookie_path)
            
            # Upload file to S3
            self.s3.upload_file(
                Filename=str(cookie_path),
                Bucket=self.bucket_name,
                Key=s3_key
            )
            
            # Update hash after successful upload
            self._cookie_hashes[hash_key] = current_hash
            logger.info(f"Successfully uploaded cookies to S3: {s3_key}")
            return True
            
        except Exception as e:
            logger.error(f"Error uploading cookies to S3: {str(e)}")
            return False

    def download_cookies(self, user_id: str, cookie_file_path: str) -> bool:
        """
        Download cookie file from S3
        
        Args:
            user_id: The user's ID
            cookie_file_path: Path where to save the cookie file
            
        Returns:
            bool: True if successful, False otherwise
        """
        try:
            cookie_path = Path(cookie_file_path)
            s3_key = self._get_s3_key(user_id, cookie_path)
            
            # Create directory if it doesn't exist
            cookie_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Download file from S3
            self.s3.download_file(
                Bucket=self.bucket_name,
                Key=s3_key,
                Filename=str(cookie_path)
            )
            
            # Store hash of downloaded file
            current_hash = self._calculate_file_hash(cookie_file_path)
            hash_key = self._get_hash_key(user_id, cookie_path)
            self._cookie_hashes[hash_key] = current_hash
            
            logger.info(f"Successfully downloaded cookies from S3: {s3_key}")
            return True
            
        except Exception as e:
            logger.error(f"Error downloading cookies from S3: {str(e)}")
            return False

    def delete_cookies(self, user_id: str, cookie_file_name: str) -> bool:
        """
        Delete cookie file from S3
        
        Args:
            user_id: The user's ID
            cookie_file_name: Name of the cookie file
            
        Returns:
            bool: True if successful, False otherwise
        """
        try:
            cookie_path = Path(cookie_file_name)
            s3_key = self._get_s3_key(user_id, cookie_path)
            
            # Delete file from S3
            self.s3.delete_object(
                Bucket=self.bucket_name,
                Key=s3_key
            )
            
            # Remove hash record
            hash_key = self._get_hash_key(user_id, cookie_path)
            self._cookie_hashes.pop(hash_key, None)
            
            logger.info(f"Successfully deleted cookies from S3: {s3_key}")
            return True
            
        except Exception as e:
            logger.error(f"Error deleting cookies from S3: {str(e)}")
            return False 