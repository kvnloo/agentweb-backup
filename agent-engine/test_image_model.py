#!/usr/bin/env python3
"""
Test script for image model selection functionality.
This script tests the GenerateImageParams and model selection logic.
"""

import os
import sys
from pathlib import Path

# Add the current directory to the Python path
sys.path.insert(0, str(Path(__file__).parent))

from web_agent import GenerateImageParams

def test_image_model_params():
    """Test the GenerateImageParams with different model values"""
    
    print("Testing GenerateImageParams with different model values...")
    
    # Test default model
    params1 = GenerateImageParams(
        input_file_names=[],
        prompt="A beautiful sunset",
        output_file_name="sunset.png"
    )
    print(f"Default model: {params1.model}")
    assert params1.model == "openai-image-1", f"Expected 'openai-image-1', got '{params1.model}'"
    
    # Test FLUX model
    params2 = GenerateImageParams(
        input_file_names=[],
        prompt="A beautiful sunset",
        output_file_name="sunset.png",
        model="FLUX.1-Kontext-pro"
    )
    print(f"FLUX model: {params2.model}")
    assert params2.model == "FLUX.1-Kontext-pro", f"Expected 'FLUX.1-Kontext-pro', got '{params2.model}'"
    
    # Test custom model
    params3 = GenerateImageParams(
        input_file_names=[],
        prompt="A beautiful sunset",
        output_file_name="sunset.png",
        model="custom-model"
    )
    print(f"Custom model: {params3.model}")
    assert params3.model == "custom-model", f"Expected 'custom-model', got '{params3.model}'"
    
    print("✅ All GenerateImageParams tests passed!")

def test_environment_variables():
    """Test that required environment variables are accessible"""
    
    print("\nTesting environment variables...")
    
    # Test OpenAI API key
    openai_key = os.getenv('OPENAI_IMAGE_API_KEY')
    if openai_key:
        print(f"✅ OPENAI_IMAGE_API_KEY is set (ends with ...{openai_key[-4:]})")
    else:
        print("⚠️  OPENAI_IMAGE_API_KEY is not set")
    
    # Test Azure AI Services API key
    azure_key = os.getenv('AZURE_OPENAI_API_KEY2')
    if azure_key:
        print(f"✅ AZURE_OPENAI_API_KEY2 is set (ends with ...{azure_key[-4:]})")
    else:
        print("⚠️  AZURE_OPENAI_API_KEY2 is not set")
    
    print("✅ Environment variable tests completed!")

if __name__ == "__main__":
    try:
        test_image_model_params()
        test_environment_variables()
        print("\n🎉 All tests passed successfully!")
    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        sys.exit(1)
