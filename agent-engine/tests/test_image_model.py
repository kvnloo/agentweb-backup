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

def test_generate_image_params_no_model_field():
    """Verify GenerateImageParams does not accept or expose a model field."""
    print("Testing GenerateImageParams has no 'model' field...")

    params = GenerateImageParams(
        input_file_names=[],
        prompt="A beautiful sunset",
        output_file_name="sunset.png"
    )

    # Accessing params.model should raise AttributeError
    try:
        _ = getattr(params, "model")
        raise AssertionError("GenerateImageParams unexpectedly has a 'model' field")
    except AttributeError:
        print("✅ 'model' field is not present, as expected")

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
        test_generate_image_params_no_model_field()
        test_environment_variables()
        print("\n🎉 All tests passed successfully!")
    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        sys.exit(1)
