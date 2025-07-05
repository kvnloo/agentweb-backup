#!/usr/bin/env python3
"""
Test script for OpenAI GPT Image generation.
This script tests the GPT Image 1 model for generating, editing, and manipulating images.
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
    api_key = os.getenv('OPENAI_API_KEY')
    if not api_key:
        logger.error("OPENAI_API_KEY environment variable is not set")
        return False
    
    # Print last 4 characters of API key for verification
    logger.info(f"Using OpenAI API key ending with: ...{api_key[-4:]}")
    
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

def test_customized_image_generation():
    """Test image generation with custom parameters"""
    # Load environment variables
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('OPENAI_API_KEY')
    if not api_key:
        logger.error("OPENAI_API_KEY environment variable is not set")
        return False
    
    # Print last 4 characters of API key for verification
    logger.info(f"Using OpenAI API key ending with: ...{api_key[-4:]}")
    
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
        
        # Test prompt with custom parameters
        prompt2 = "generate a portrait, pixel-art style, of a grey tabby cat dressed as a blond woman on a dark background."
        img_path2 = "generated_images/cat_portrait_pixel.jpg"
        
        logger.info("Generating customized image with GPT Image 1...")
        logger.info(f"Prompt: {prompt2}")
        
        # Generate the image with custom parameters
        result2 = client.images.generate(
            model="gpt-image-1",
            prompt=prompt2,
            quality="low",
            output_compression=50,
            output_format="jpeg",
            size="1024x1536"
        )
        
        # Save the image
        if result2.data and len(result2.data) > 0:
            image_base64 = result2.data[0].b64_json
            success = save_and_resize_image(image_base64, img_path2, size=(250, 375))
            if success:
                logger.info("✅ Customized image generation test completed successfully!")
                return True
            else:
                logger.error("❌ Failed to save customized image")
                return False
        else:
            logger.error("❌ No image data received from API")
            return False
            
    except Exception as e:
        logger.error(f"Error testing customized image generation: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_transparent_background():
    """Test image generation with transparent background"""
    # Load environment variables
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('OPENAI_API_KEY')
    if not api_key:
        logger.error("OPENAI_API_KEY environment variable is not set")
        return False
    
    # Print last 4 characters of API key for verification
    logger.info(f"Using OpenAI API key ending with: ...{api_key[-4:]}")
    
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
        
        # Test prompt for transparent background
        prompt3 = "generate a pixel-art style picture of a green bucket hat with a pink quill on a transparent background."
        img_path3 = "generated_images/hat.png"
        
        logger.info("Generating image with transparent background...")
        logger.info(f"Prompt: {prompt3}")
        
        # Generate the image with PNG format for transparency
        result3 = client.images.generate(
            model="gpt-image-1",
            prompt=prompt3,
            quality="low",
            output_format="png",
            size="1024x1024"
        )
        
        # Save the image
        if result3.data and len(result3.data) > 0:
            image_base64 = result3.data[0].b64_json
            success = save_and_resize_image(image_base64, img_path3, size=(250, 250))
            if success:
                logger.info("✅ Transparent background test completed successfully!")
                return True
            else:
                logger.error("❌ Failed to save transparent image")
                return False
        else:
            logger.error("❌ No image data received from API")
            return False
            
    except Exception as e:
        logger.error(f"Error testing transparent background: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_image_editing():
    """Test image editing with multiple input images"""
    # Load environment variables
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('OPENAI_API_KEY')
    if not api_key:
        logger.error("OPENAI_API_KEY environment variable is not set")
        return False
    
    # Print last 4 characters of API key for verification
    logger.info(f"Using OpenAI API key ending with: ...{api_key[-4:]}")
    
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
        
        # Check if required images exist
        img_path2 = "generated_images/cat_portrait_pixel.jpg"
        img_path3 = "generated_images/hat.png"
        
        if not os.path.exists(img_path2) or not os.path.exists(img_path3):
            logger.warning("Required images for editing test not found. Running basic generation first...")
            if not test_customized_image_generation():
                logger.error("Failed to generate required images for editing test")
                return False
            if not test_transparent_background():
                logger.error("Failed to generate required images for editing test")
                return False
        
        # Test image editing
        prompt_edit = """
        Combine the images of the cat and the hat to show the cat wearing the hat while being perched in a tree, still in pixel-art style.
        """
        img_path_edit = "generated_images/cat_with_hat.jpg"
        
        logger.info("Testing image editing with multiple inputs...")
        logger.info(f"Prompt: {prompt_edit}")
        
        # Open the input images
        with open(img_path2, "rb") as img1, open(img_path3, "rb") as img2:
            # Generate the new image
            result_edit = client.images.edit(
                model="gpt-image-1",
                image=[img1, img2], 
                prompt=prompt_edit,
                size="1024x1536"
            )
        
        # Save the edited image
        if result_edit.data and len(result_edit.data) > 0:
            image_base64 = result_edit.data[0].b64_json
            success = save_and_resize_image(image_base64, img_path_edit, size=(250, 375))
            if success:
                logger.info("✅ Image editing test completed successfully!")
                return True
            else:
                logger.error("❌ Failed to save edited image")
                return False
        else:
            logger.error("❌ No edited image data received from API")
            return False
            
    except Exception as e:
        logger.error(f"Error testing image editing: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_image_editing_with_mask():
    """Test image editing with a mask"""
    # Load environment variables
    load_dotenv()
    
    # Get API key from environment
    api_key = os.getenv('OPENAI_API_KEY')
    if not api_key:
        logger.error("OPENAI_API_KEY environment variable is not set")
        return False
    
    # Print last 4 characters of API key for verification
    logger.info(f"Using OpenAI API key ending with: ...{api_key[-4:]}")
    
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
        
        # Check if required image exists
        img_path1 = "generated_images/glorptak.jpg"
        
        if not os.path.exists(img_path1):
            logger.warning("Required image for mask editing test not found. Running basic generation first...")
            if not test_basic_image_generation():
                logger.error("Failed to generate required image for mask editing test")
                return False
        
        # Generate mask
        img_path_mask = "generated_images/mask.png"
        prompt_mask = "generate a mask delimiting the entire character in the picture, using white where the character is and black for the background. Return an image in the same size as the input image."
        
        logger.info("Generating mask for image editing...")
        
        with open(img_path1, "rb") as img_input:
            # Generate the mask
            result_mask = client.images.edit(
                model="gpt-image-1",
                image=img_input, 
                prompt=prompt_mask
            )
        
        # Save the mask
        if result_mask.data and len(result_mask.data) > 0:
            image_base64 = result_mask.data[0].b64_json
            success = save_and_resize_image(image_base64, img_path_mask, size=(300, 300))
            if not success:
                logger.error("❌ Failed to save mask")
                return False
        else:
            logger.error("❌ No mask data received from API")
            return False
        
        # Create alpha channel for mask
        logger.info("Creating alpha channel for mask...")
        mask = Image.open(img_path_mask).convert("L")
        mask_rgba = mask.convert("RGBA")
        mask_rgba.putalpha(mask)
        
        # Save mask with alpha channel
        img_path_mask_alpha = "generated_images/mask_alpha.png"
        mask_rgba.save(img_path_mask_alpha, format="PNG")
        logger.info(f"Mask with alpha channel saved to: {img_path_mask_alpha}")
        
        # Edit image with mask
        prompt_mask_edit = "A strange character on a colorful galaxy background, with lots of stars and planets."
        img_path_mask_edit = "generated_images/mask_edit.png"
        
        logger.info("Editing image with mask...")
        logger.info(f"Prompt: {prompt_mask_edit}")
        
        with open(img_path1, "rb") as img_input, open(img_path_mask_alpha, "rb") as mask:
            result_mask_edit = client.images.edit(
                model="gpt-image-1",         
                prompt=prompt_mask_edit,
                image=img_input,
                mask=mask,
                size="1024x1024"
            )
        
        # Save the edited image
        if result_mask_edit.data and len(result_mask_edit.data) > 0:
            image_base64 = result_mask_edit.data[0].b64_json
            success = save_and_resize_image(image_base64, img_path_mask_edit, size=(300, 300))
            if success:
                logger.info("✅ Image editing with mask test completed successfully!")
                return True
            else:
                logger.error("❌ Failed to save masked edited image")
                return False
        else:
            logger.error("❌ No masked edited image data received from API")
            return False
            
    except Exception as e:
        logger.error(f"Error testing image editing with mask: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_all_image_generation():
    """Run all image generation tests"""
    logger.info("🚀 Starting comprehensive GPT Image generation tests...")
    
    tests = [
        ("Basic Image Generation", test_basic_image_generation),
        ("Customized Image Generation", test_customized_image_generation),
        ("Transparent Background", test_transparent_background),
        ("Image Editing", test_image_editing),
        ("Image Editing with Mask", test_image_editing_with_mask),
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
    parser.add_argument('--customized', action='store_true', help='Test customized image generation')
    parser.add_argument('--transparent', action='store_true', help='Test transparent background generation')
    parser.add_argument('--editing', action='store_true', help='Test image editing')
    parser.add_argument('--mask', action='store_true', help='Test image editing with mask')
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
    elif args.customized:
        success = test_customized_image_generation()
        if success:
            print("\n✅ Customized image generation test completed successfully!")
        else:
            print("\n❌ Customized image generation test failed.")
    elif args.transparent:
        success = test_transparent_background()
        if success:
            print("\n✅ Transparent background test completed successfully!")
        else:
            print("\n❌ Transparent background test failed.")
    elif args.editing:
        success = test_image_editing()
        if success:
            print("\n✅ Image editing test completed successfully!")
        else:
            print("\n❌ Image editing test failed.")
    elif args.mask:
        success = test_image_editing_with_mask()
        if success:
            print("\n✅ Image editing with mask test completed successfully!")
        else:
            print("\n❌ Image editing with mask test failed.")
    else:
        # Default: run all tests
        success = test_all_image_generation()
        if success:
            print("\n🎉 All GPT Image tests completed successfully!")
        else:
            print("\n⚠️  Some GPT Image tests failed. Check the logs for details.") 