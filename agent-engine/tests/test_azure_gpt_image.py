#!/usr/bin/env python3
"""
Test script for Azure OpenAI gpt-image-1 model integration.
This script tests the Azure OpenAI gpt-image-1 model for generating images.
"""

import os
import sys
import logging
import asyncio
import base64
import tempfile
from pathlib import Path
from typing import List, Optional, Dict, Any
from dotenv import load_dotenv
from PIL import Image
from io import BytesIO

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def test_azure_gpt_image_generation():
    """Test Azure AI Services gpt-image-1 image generation"""
    try:
        import requests
    except ImportError as e:
        logger.error(f"Required packages not installed: {e}")
        logger.error("Install with: pip install requests")
        return False
    
    # Load environment variables
    load_dotenv()
    
    # Azure AI Services configuration (same as FLUX)
    api_key = os.getenv('AZURE_IMAGE_API_KEY')
    if not api_key:
        logger.error("AZURE_IMAGE_API_KEY environment variable is not set")
        return False
    
    azure_endpoint = (os.getenv('AZURE_IMAGE_ENDPOINT') or '').strip().rstrip('/')
    if not azure_endpoint:
        logger.error("AZURE_IMAGE_ENDPOINT environment variable is not set")
        return False

    deployment_name = "gpt-image-1"
    api_version = "2025-04-01-preview"
    
    logger.info(f"Testing Azure AI Services gpt-image-1 model")
    logger.info(f"Endpoint: {azure_endpoint}")
    logger.info(f"Deployment: {deployment_name}")
    logger.info(f"API Version: {api_version}")
    
    # Test image generation
    url = f"{azure_endpoint}/openai/deployments/{deployment_name}/images/generations"
    headers = {
        "Content-Type": "application/json",
        "api-key": api_key
    }
    data = {
        "prompt": "create a cartoon of mountain rainier",
        "size": "1536x1024",
        "n": 1,
        "quality": "medium",
        "output_format": "png"
    }
    
    logger.info(f"Generating image with prompt: {data['prompt']}")
    
    try:
        generation_response = requests.post(url, headers=headers, json=data, params={"api-version": api_version})
        
        if generation_response.status_code != 200:
            logger.error(f"Azure AI Services API error: {generation_response.status_code} - {generation_response.text}")
            return False
        
        result_data = generation_response.json()
        if not result_data.get('data') or len(result_data['data']) == 0:
            logger.error("No image data received from Azure AI Services API")
            return False
        
        # Extract the image data
        image_base64 = result_data['data'][0].get('b64_json')
        if not image_base64:
            logger.error("No b64_json data in Azure AI Services response")
            return False
        
        # Create generated_images folder if it doesn't exist
        generated_images_dir = "generated_images"
        os.makedirs(generated_images_dir, exist_ok=True)
        
        # Save the image
        image_bytes = base64.b64decode(image_base64)
        output_path = os.path.join(generated_images_dir, "test_azure_gpt_image.png")
        with open(output_path, "wb") as f:
            f.write(image_bytes)
        
        logger.info(f"✅ Image generated successfully and saved to: {output_path}")
        
        # Verify the image can be opened
        try:
            with Image.open(output_path) as img:
                logger.info(f"Image verification successful: {img.size} pixels, {img.format} format")
        except Exception as e:
            logger.error(f"Image verification failed: {e}")
            return False
        
        return True
        
    except Exception as e:
        logger.error(f"Image generation failed: {e}")
        return False

def main():
    """Main test function"""
    logger.info("Starting Azure AI Services gpt-image-1 test...")
    
    success = test_azure_gpt_image_generation()
    
    if success:
        logger.info("✅ All tests passed!")
        return 0
    else:
        logger.error("❌ Tests failed!")
        return 1

if __name__ == "__main__":
    sys.exit(main())
