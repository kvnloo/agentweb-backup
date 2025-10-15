#!/usr/bin/env python3
"""
Test script for OpenAI GPT Image generation.
This script tests the GPT Image 1 model for generating and editing images.
Based on the OpenAI cookbook: https://cookbook.openai.com/examples/generate_images_with_gpt_image
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

def create_images_folder():
    """Create the generated_images/ folder for storing generated images"""
    folder_path = "generated_images"
    os.makedirs(folder_path, exist_ok=True)
    logger.info(f"Created/verified images folder: {folder_path}")
    return folder_path

def save_and_resize_image(image_base64: str, output_path: str, size: tuple = (300, 300), quality: int = 80):
    """Save base64 image to file and resize/compress it"""
    try:
        # Decode base64 image
        image_bytes = base64.b64decode(image_base64)
        
        # Open and resize image
        image = Image.open(BytesIO(image_bytes))
        image = image.resize(size, Image.LANCZOS)
        
        # Determine format from file extension
        file_ext = Path(output_path).suffix.lower()
        if file_ext == '.png':
            image.save(output_path, format="PNG")
        else:
            image.save(output_path, format="JPEG", quality=quality, optimize=True)
        
        logger.info(f"Image saved to: {output_path}")
        return True
    except Exception as e:
        logger.error(f"Error saving image: {e}")
        return False

def test_basic_image_generation():
    """Test basic image generation with GPT Image 1"""
    # Load environment variables
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('OPENAI_IMAGE_API_KEY')
    if not api_key:
        logger.error("OPENAI_IMAGE_API_KEY environment variable is not set")
        return False
    
    # Print last 4 characters of API key for verification
    logger.info(f"Using OpenAI Image API key ending with: ...{api_key[-4:]}")
    
    try:
        # Import OpenAI client
        try:
            from openai import OpenAI
        except ImportError:
            logger.error("openai package is not installed. Install it with: pip install openai")
            return False
        
        # Create OpenAI client
        client = OpenAI(api_key=api_key)
        
        # Create images folder
        create_images_folder()
        
        # Test prompt for a character
        prompt1 = """
        Render a realistic image of this character:
        Blobby Alien Character Spec Name: Glorptak (or nickname: "Glorp")
        Visual Appearance Body Shape: Amorphous and gelatinous. Overall silhouette resembles a teardrop or melting marshmallow, shifting slightly over time. Can squish and elongate when emotional or startled.
        Material Texture: Semi-translucent, bio-luminescent goo with a jelly-like wobble. Surface occasionally ripples when communicating or moving quickly.
        Color Palette:
        - Base: Iridescent lavender or seafoam green
        - Accents: Subsurface glowing veins of neon pink, electric blue, or golden yellow
        - Mood-based color shifts (anger = dark red, joy = bright aqua, fear = pale gray)
        Facial Features:
        - Eyes: 3–5 asymmetrical floating orbs inside the blob that rotate or blink independently
        - Mouth: Optional—appears as a rippling crescent on the surface when speaking or emoting
        - No visible nose or ears; uses vibration-sensitive receptors embedded in goo
        - Limbs: None by default, but can extrude pseudopods (tentacle-like limbs) when needed for interaction or locomotion. Can manifest temporary feet or hands.
        Movement & Behavior Locomotion:
        - Slides, bounces, and rolls.
        - Can stick to walls and ceilings via suction. When scared, may flatten and ooze away quickly.
        Mannerisms:
        - Constant wiggling or wobbling even at rest
        - Leaves harmless glowing slime trails
        - Tends to absorb nearby small objects temporarily out of curiosity
        """
        
        img_path1 = "generated_images/glorptak.jpg"
        
        logger.info("Generating image with GPT Image 1...")
        logger.info(f"Prompt: {prompt1[:100]}...")
        
        # Generate the image
        result1 = client.images.generate(
            model="gpt-image-1",
            prompt=prompt1,
            size="1024x1024"
        )
        
        # Save the image
        if result1.data and len(result1.data) > 0:
            image_base64 = result1.data[0].b64_json
            success = save_and_resize_image(image_base64, img_path1)
            if success:
                logger.info("✅ Basic image generation test completed successfully!")
                return True
            else:
                logger.error("❌ Failed to save generated image")
                return False
        else:
            logger.error("❌ No image data received from API")
            return False
            
    except Exception as e:
        logger.error(f"Error testing basic image generation: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_input_images():
    """Test image generation with input images (e.g., logo editing)"""
    # Load environment variables
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('OPENAI_IMAGE_API_KEY')
    if not api_key:
        logger.error("OPENAI_IMAGE_API_KEY environment variable is not set")
        return False
    
    # Print last 4 characters of API key for verification
    logger.info(f"Using OpenAI Image API key ending with: ...{api_key[-4:]}")
    
    try:
        # Import OpenAI client
        try:
            from openai import OpenAI
        except ImportError:
            logger.error("openai package is not installed. Install it with: pip install openai")
            return False
        
        # Create OpenAI client
        client = OpenAI(api_key=api_key)
        
        # Create images folder
        create_images_folder()
        
        # Check if we have a logo image to work with
        logo_path = "input_images/test-logo.png"  # You can place your logo here
        if not os.path.exists(logo_path):
            logger.error(f"Logo file not found at {logo_path}")
            logger.error("Please add a logo file at input_images/test-logo.png")
            return False
        
        # Test prompt for logo editing
        prompt_edit = """
        Take this logo and create a modern, minimalist version with a gradient background. 
        Make it suitable for a tech startup. Use clean lines and contemporary design principles.
        """
        
        output_path = "generated_images/edited_logo.png"
        
        logger.info("Testing image editing with input logo...")
        logger.info(f"Input image: {logo_path}")
        logger.info(f"Prompt: {prompt_edit}")
        
        # Open the input image
        with open(logo_path, "rb") as img_input:
            # Generate the edited image
            result = client.images.edit(
                model="gpt-image-1",
                image=img_input,
                prompt=prompt_edit,
                size="1024x1024"
            )
        
        # Save the edited image
        if result.data and len(result.data) > 0:
            image_base64 = result.data[0].b64_json
            success = save_and_resize_image(image_base64, output_path, size=(400, 400))
            if success:
                logger.info("✅ Input images test completed successfully!")
                return True
            else:
                logger.error("❌ Failed to save edited image")
                return False
        else:
            logger.error("❌ No edited image data received from API")
            return False
            
    except Exception as e:
        logger.error(f"Error testing input images: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_multiple_input_images():
    """Test image generation with multiple input images (logo + landscape)"""
    # Load environment variables
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('OPENAI_IMAGE_API_KEY')
    if not api_key:
        logger.error("OPENAI_IMAGE_API_KEY environment variable is not set")
        return False
    
    # Print last 4 characters of API key for verification
    logger.info(f"Using OpenAI Image API key ending with: ...{api_key[-4:]}")
    
    try:
        # Import OpenAI client
        try:
            from openai import OpenAI
        except ImportError:
            logger.error("openai package is not installed. Install it with: pip install openai")
            return False
        
        # Create OpenAI client
        client = OpenAI(api_key=api_key)
        
        # Create images folder
        create_images_folder()
        
        # Check if we have the required input images
        logo_path = "input_images/test-logo.png"
        landscape_path = "input_images/test-landscape.jpg"
        
        if not os.path.exists(logo_path):
            logger.error(f"Logo file not found at {logo_path}")
            logger.error("Please add a logo file at input_images/test-logo.png")
            return False
            
        if not os.path.exists(landscape_path):
            logger.error(f"Landscape file not found at {landscape_path}")
            logger.error("Please add a landscape file at input_images/test-landscape.jpg")
            return False
        
        # Test prompt for combining logo with landscape
        prompt_combine = """
        Take this logo and integrate it naturally into this landscape scene. 
        Place the logo as a subtle watermark or as part of the landscape design.
        Make it look professional and well-integrated.
        """
        
        output_path = "generated_images/logo_landscape_combined.png"
        
        logger.info("Testing image editing with multiple input images...")
        logger.info(f"Input images: {logo_path}, {landscape_path}")
        logger.info(f"Prompt: {prompt_combine}")
        
        # Open both input images
        with open(logo_path, "rb") as img1, open(landscape_path, "rb") as img2:
            # Generate the combined image using multiple input images
            result = client.images.edit(
                model="gpt-image-1",
                image=[img1, img2],  # Pass both images as a list
                prompt=prompt_combine,
                size="1024x1024"
            )
        
        # Save the combined image
        if result.data and len(result.data) > 0:
            image_base64 = result.data[0].b64_json
            success = save_and_resize_image(image_base64, output_path, size=(800, 600))
            if success:
                logger.info("✅ Multiple input images test completed successfully!")
                return True
            else:
                logger.error("❌ Failed to save combined image")
                return False
        else:
            logger.error("❌ No combined image data received from API")
            return False
            
    except Exception as e:
        logger.error(f"Error testing multiple input images: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_all_image_generation():
    """Run all image generation tests"""
    logger.info("🚀 Starting GPT Image generation tests...")
    
    tests = [
        ("Basic Image Generation", test_basic_image_generation),
        ("Input Images", test_input_images),
        ("Multiple Input Images", test_multiple_input_images),
    ]
    
    results = []
    for test_name, test_func in tests:
        logger.info(f"\n{'='*50}")
        logger.info(f"Running: {test_name}")
        logger.info(f"{'='*50}")
        
        try:
            success = test_func()
            results.append((test_name, success))
            if success:
                logger.info(f"✅ {test_name} PASSED")
            else:
                logger.error(f"❌ {test_name} FAILED")
        except Exception as e:
            logger.error(f"❌ {test_name} FAILED with exception: {e}")
            results.append((test_name, False))
    
    # Summary
    logger.info(f"\n{'='*50}")
    logger.info("TEST SUMMARY")
    logger.info(f"{'='*50}")
    
    passed = sum(1 for _, success in results if success)
    total = len(results)
    
    for test_name, success in results:
        status = "✅ PASSED" if success else "❌ FAILED"
        logger.info(f"{test_name}: {status}")
    
    logger.info(f"\nOverall: {passed}/{total} tests passed")
    
    if passed == total:
        logger.info("🎉 All tests completed successfully!")
        return True
    else:
        logger.warning(f"⚠️  {total - passed} test(s) failed")
        return False

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Test OpenAI GPT Image generation')
    parser.add_argument('--basic', action='store_true', help='Test basic image generation')
    parser.add_argument('--input-images', action='store_true', help='Test image editing with input images')
    parser.add_argument('--multiple-input-images', action='store_true', help='Test image editing with multiple input images')
    parser.add_argument('--all', action='store_true', help='Run all tests')
    
    args = parser.parse_args()
    
    if args.all:
        success = test_all_image_generation()
        if success:
            print("\n🎉 All GPT Image tests completed successfully!")
        else:
            print("\n⚠️  Some GPT Image tests failed. Check the logs for details.")
    elif args.basic:
        success = test_basic_image_generation()
        if success:
            print("\n✅ Basic image generation test completed successfully!")
        else:
            print("\n❌ Basic image generation test failed.")
    elif args.input_images:
        success = test_input_images()
        if success:
            print("\n✅ Input images test completed successfully!")
        else:
            print("\n❌ Input images test failed.")
    elif args.multiple_input_images:
        success = test_multiple_input_images()
        if success:
            print("\n✅ Multiple input images test completed successfully!")
        else:
            print("\n❌ Multiple input images test failed.")
    else:
        # Default: run all tests
        success = test_all_image_generation()
        if success:
            print("\n🎉 All GPT Image tests completed successfully!")
        else:
            print("\n⚠️  Some GPT Image tests failed. Check the logs for details.") 