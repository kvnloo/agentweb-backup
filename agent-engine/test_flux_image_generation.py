#!/usr/bin/env python3
"""
Test script for FLUX Kontext Max image generation via ReelMind API.
This script tests the image generation functionality without requiring the full web agent setup.
"""

import os
import requests
import json
import time
from pathlib import Path

# Load environment variables from .env file
try:
    from dotenv import load_dotenv
    # Try to load from parent directory first, then current directory
    load_dotenv('../.env')
    load_dotenv('.env')
    print("🔧 Loaded environment variables from .env file")
except ImportError:
    print("⚠️  python-dotenv not installed. Install with: pip install python-dotenv")
    print("   Or set environment variables manually before running the script.")
except Exception as e:
    print(f"⚠️  Could not load .env file: {e}")
    print("   Please ensure environment variables are set manually.")

def test_flux_image_generation():
    """Test FLUX Kontext Max image generation"""
    
    # Get API key from environment
    api_key = os.getenv('REELMIND_API_KEY')
    if not api_key:
        print("❌ REELMIND_API_KEY environment variable is not set")
        return False
    
    print("🔑 API Key found")
    
    # Test parameters
    test_prompt = "A beautiful sunset over a mountain landscape, digital art style, high quality"
    test_aspect_ratio = "16:9"
    
    # Prepare request data
    request_data = {
        "prompt": test_prompt,
        "model_id": "FLUX Kontext Max",  # Must be exactly 'FLUX Kontext Pro' or 'FLUX Kontext Max'
        "aspect_ratio": test_aspect_ratio,
        "guidance_scale": 3.5,
        "negative_prompt": "blur, low quality, distorted, ugly"  # Add negative prompt
    }
    
    print(f"📝 Test prompt: {test_prompt}")
    print(f"🖼️  Aspect ratio: {test_aspect_ratio}")
    
    # Make request to ReelMind API
    headers = {
        "Authorization": api_key,  # No Bearer prefix needed
        "Content-Type": "application/json"
    }
    
    # Check if API key looks correct (don't print the full key for security)
    print(f"🔑 API Key format: {api_key[:10]}...{api_key[-10:] if len(api_key) > 20 else 'short'}")
    print(f"🔑 Authorization header: {api_key[:10]}...")
    
    try:
        print("🚀 Sending request to ReelMind API...")
        print(f"📤 Request URL: https://nestapi.reelmind.ai/external-api/image/generate")
        print(f"📤 Request headers: {json.dumps(headers, indent=2)}")
        print(f"📤 Request data: {json.dumps(request_data, indent=2)}")
        
        response = requests.post(
            "https://nestapi.reelmind.ai/external-api/image/generate",
            headers=headers,
            json=request_data,
            timeout=60
        )
        
        print(f"📡 Response status: {response.status_code}")
        
        if response.status_code not in [200, 201]:
            print(f"❌ API request failed with status {response.status_code}")
            print(f"📊 Request data sent: {json.dumps(request_data, indent=2)}")
            print(f"📊 Response headers: {dict(response.headers)}")
            print(f"📊 Response body: {response.text}")
            
            # Try to parse error response for more details
            try:
                error_data = response.json()
                if "errors" in error_data:
                    print(f"🔍 Detailed errors: {json.dumps(error_data['errors'], indent=2)}")
            except:
                pass
            
            return False
        
        response_data = response.json()
        print(f"📊 Response data: {json.dumps(response_data, indent=2)}")
        
        # The ReelMind API always returns a task ID that needs to be queried for results
        if "data" in response_data and "task_id" in response_data["data"]:
            # Task-based response - poll for completion
            task_id = response_data["data"]["task_id"]
            print(f"🔄 Task created with ID: {task_id}")
            
            # Poll for completion
            max_attempts = 60  # 5 minutes max (5 second intervals)
            attempt = 0
            
            while attempt < max_attempts:
                time.sleep(5)  # Wait 5 seconds between polls
                attempt += 1
                
                print(f"⏳ Checking task status (attempt {attempt}/{max_attempts})...")
                
                # Check task status
                status_response = requests.get(
                    f"https://nestapi.reelmind.ai/external-api/image/task/{task_id}",
                    headers=headers,
                    timeout=10
                )
                
                if status_response.status_code not in [200, 201]:
                    print(f"⚠️  Status check failed: {status_response.status_code} - {status_response.text}")
                    continue
                
                status_data = status_response.json()
                task_status = status_data.get("data", {}).get("status")
                
                print(f"📊 Task status: {task_status}")
                
                if task_status == "completed":
                    # Extract image URL from the response
                    output_result = status_data.get("data", {}).get("output_result", {})
                    image_url = output_result.get("image_url")
                    if image_url:
                        print(f"✅ Image completed successfully: {image_url}")
                        return True
                    else:
                        print("❌ Image completed but no image_url provided")
                        return False
                        
                elif task_status == "failed":
                    error_msg = status_data.get("error", "Image generation failed.")
                    print(f"❌ Image generation failed: {error_msg}")
                    return False
                    
                elif task_status in ["pending", "processing"]:
                    # Continue polling
                    continue
                else:
                    print(f"⚠️  Unknown task status: {task_status}")
                    continue
            
            print(f"⏰ Task timed out after {max_attempts * 5} seconds")
            return False
            
        else:
            # Unexpected response format
            print(f"❌ Unexpected response format: {response_data}")
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"❌ API request error: {str(e)}")
        return False
    except Exception as e:
        print(f"❌ Unexpected error: {str(e)}")
        return False

def test_flux_image_to_image():
    """Test FLUX Kontext Max image-to-image generation API structure"""
    
    # Get API key from environment
    api_key = os.getenv('REELMIND_API_KEY')
    if not api_key:
        print("❌ REELMIND_API_KEY environment variable is not set")
        return False
    
    print("🔑 API Key found for image-to-image test")
    
    # Test parameters
    test_prompt = "Transform this image into a futuristic cyberpunk style with neon lights and high-tech elements"
    test_aspect_ratio = "1:1"
    
    # For this test, we'll use a valid image URL from your S3 bucket
    # This should be a publicly accessible image URL
    test_image_url = "https://agentweb-user-files.s3.us-west-2.amazonaws.com/tasks/1753828463661/executions/1753980029371/uploads/1754087113685-c074ee474a5c5f4d0faa5c18a10b2bd9-AgentWeb_GoogleMeet2.webp"
    
    # Prepare request data
    request_data = {
        "prompt": test_prompt,
        "model_id": "FLUX Kontext Max",
        "aspect_ratio": test_aspect_ratio,
        "guidance_scale": 3.5,
        "image_url": test_image_url
    }
    
    print(f"📝 Test prompt: {test_prompt}")
    print(f"🖼️  Aspect ratio: {test_aspect_ratio}")
    print(f"🖼️  Input image: {test_image_url}")
    
    # Make request to ReelMind API
    headers = {
        "Authorization": api_key,  # No Bearer prefix needed
        "Content-Type": "application/json"
    }
    
    # Check if API key looks correct (don't print the full key for security)
    print(f"🔑 API Key format: {api_key[:10]}...{api_key[-10:] if len(api_key) > 20 else 'short'}")
    print(f"🔑 Authorization header: {api_key[:10]}...")
    
    try:
        print("🚀 Sending image-to-image request to ReelMind API...")
        print(f"📤 Request URL: https://nestapi.reelmind.ai/external-api/image/generate")
        print(f"📤 Request headers: {json.dumps(headers, indent=2)}")
        print(f"📤 Request data: {json.dumps(request_data, indent=2)}")
        
        response = requests.post(
            "https://nestapi.reelmind.ai/external-api/image/generate",
            headers=headers,
            json=request_data,
            timeout=60
        )
        
        print(f"📡 Response status: {response.status_code}")
        
        if response.status_code not in [200, 201]:
            print(f"❌ API request failed with status {response.status_code}")
            print(f"📊 Request data sent: {json.dumps(request_data, indent=2)}")
            print(f"📊 Response headers: {dict(response.headers)}")
            print(f"📊 Response body: {response.text}")
            
            # Try to parse error response for more details
            try:
                error_data = response.json()
                if "errors" in error_data:
                    print(f"🔍 Detailed errors: {json.dumps(error_data['errors'], indent=2)}")
            except:
                pass
            
            return False
        
        response_data = response.json()
        print(f"📊 Response data: {json.dumps(response_data, indent=2)}")
        
        # Check if we got a task ID (expected behavior)
        if "data" in response_data and "task_id" in response_data["data"]:
            print("✅ Image-to-image API call structure is correct - received task ID")
            return True
        else:
            print("❌ Unexpected response format - no task ID received")
            return False
        
    except requests.exceptions.RequestException as e:
        print(f"❌ API request error: {str(e)}")
        return False
    except Exception as e:
        print(f"❌ Unexpected error: {str(e)}")
        return False

if __name__ == "__main__":
    print("🧪 Testing FLUX Kontext Max Image Generation")
    print("=" * 50)
    
    # Test 1: Text-to-image generation
    print("\n📸 Test 1: Text-to-Image Generation")
    print("-" * 30)
    success1 = test_flux_image_generation()
    
    # Test 2: Image-to-image generation (structure test)
    print("\n🔄 Test 2: Image-to-Image Generation (Structure Test)")
    print("-" * 30)
    success2 = test_flux_image_to_image()
    
    # Summary
    print("\n📋 Test Summary")
    print("=" * 50)
    print(f"Text-to-Image: {'✅ PASS' if success1 else '❌ FAIL'}")
    print(f"Image-to-Image API Structure: {'✅ PASS' if success2 else '❌ FAIL'}")
    
    if success1 and success2:
        print("\n🎉 All tests passed! FLUX Kontext Max integration is working.")
    else:
        print("\n⚠️  Some tests failed. Check the output above for details.")
    
    print("\n📝 Note: The image-to-image test validates API structure only.")
    print("   For actual image-to-image generation, you need a valid input image URL.")
