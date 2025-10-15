#!/usr/bin/env python3
"""
Test Azure OpenAI configuration and environment variable handling.
This test helps diagnose why gpt-4o and gpt-4.1 are not working.
"""

import os
import sys
import unittest
from unittest.mock import patch, Mock
import logging

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from task_utils import get_azure_openai_llm, get_azure_openai_llm2, get_llm

class TestAzureOpenAIConfig(unittest.TestCase):
    """Test Azure OpenAI configuration and environment variable handling."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.original_env = os.environ.copy()
        
    def tearDown(self):
        """Clean up after tests."""
        os.environ.clear()
        os.environ.update(self.original_env)
    
    def test_azure_openai_environment_variables(self):
        """Test that Azure OpenAI functions check for correct environment variables."""
        print("\n=== Testing Azure OpenAI Environment Variables ===")
        
        # Test get_azure_openai_llm (for gpt-4o)
        print("Testing get_azure_openai_llm (gpt-4o)...")
        
        # Clear Azure environment variables
        azure_vars = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_VERSION']
        for var in azure_vars:
            if var in os.environ:
                del os.environ[var]
        
        # Test with missing environment variables
        with self.assertRaises(SystemExit) as cm:
            get_azure_openai_llm("gpt-4o")
        
        print(f"✅ get_azure_openai_llm correctly exits when environment variables are missing")
        
        # Test get_azure_openai_llm2 (for gpt-4.1)
        print("Testing get_azure_openai_llm2 (gpt-4.1)...")
        
        # Clear Azure environment variables for llm2
        azure_vars2 = ['AZURE_OPENAI_ENDPOINT2', 'AZURE_OPENAI_API_KEY2', 'AZURE_OPENAI_API_VERSION2']
        for var in azure_vars2:
            if var in os.environ:
                del os.environ[var]
        
        # Test with missing environment variables
        with self.assertRaises(SystemExit) as cm:
            get_azure_openai_llm2("gpt-4.1")
        
        print(f"✅ get_azure_openai_llm2 correctly exits when environment variables are missing")
    
    def test_azure_openai_with_mock_credentials(self):
        """Test Azure OpenAI initialization with mock credentials."""
        print("\n=== Testing Azure OpenAI with Mock Credentials ===")
        
        # Mock the AzureChatOpenAI class to avoid actual API calls
        with patch('task_utils.AzureChatOpenAI') as mock_azure:
            mock_instance = Mock()
            mock_azure.return_value = mock_instance
            
            # Set up environment variables for gpt-4o
            os.environ['AZURE_OPENAI_ENDPOINT'] = 'https://test.openai.azure.com/'
            os.environ['AZURE_OPENAI_API_KEY'] = 'test-api-key'
            os.environ['AZURE_OPENAI_API_VERSION'] = '2024-08-01-preview'
            
            # Test gpt-4o initialization
            result = get_azure_openai_llm("gpt-4o")
            
            # Verify the AzureChatOpenAI was called with correct parameters
            mock_azure.assert_called_once_with(
                model_name="gpt-4o",
                azure_endpoint='https://test.openai.azure.com/',
                azure_deployment="gpt-4o",
                api_key='test-api-key',
                api_version='2024-08-01-preview',
                temperature=0.0
            )
            
            print("✅ gpt-4o initialization with mock credentials successful")
            
            # Test gpt-4.1 initialization
            os.environ['AZURE_OPENAI_ENDPOINT2'] = 'https://test2.openai.azure.com/'
            os.environ['AZURE_OPENAI_API_KEY2'] = 'test-api-key-2'
            os.environ['AZURE_OPENAI_API_VERSION2'] = '2024-12-01-preview'
            
            result2 = get_azure_openai_llm2("gpt-4.1")
            
            # Verify the AzureChatOpenAI was called with correct parameters for gpt-4.1
            mock_azure.assert_called_with(
                model_name="gpt-4.1",
                azure_endpoint='https://test2.openai.azure.com/',
                azure_deployment="gpt-4.1",
                api_key='test-api-key-2',
                api_version='2024-12-01-preview',
                temperature=0.0
            )
            
            print("✅ gpt-4.1 initialization with mock credentials successful")
    
    def test_get_llm_azure_configuration(self):
        """Test the get_llm function with Azure OpenAI configurations."""
        print("\n=== Testing get_llm with Azure OpenAI ===")
        
        with patch('task_utils.AzureChatOpenAI') as mock_azure:
            mock_instance = Mock()
            mock_azure.return_value = mock_instance
            
            # Test gpt-4o configuration
            os.environ['AZURE_OPENAI_ENDPOINT'] = 'https://test.openai.azure.com/'
            os.environ['AZURE_OPENAI_API_KEY'] = 'test-api-key'
            
            llm, llm_name = get_llm("azure->openai->gpt-4o")
            
            self.assertEqual(llm_name, "azure->openai->gpt-4o")
            print("✅ gpt-4o LLM configuration successful")
            
            # Test gpt-4.1 configuration
            os.environ['AZURE_OPENAI_ENDPOINT2'] = 'https://test2.openai.azure.com/'
            os.environ['AZURE_OPENAI_API_KEY2'] = 'test-api-key-2'
            
            llm2, llm_name2 = get_llm("azure->openai->gpt-4.1")
            
            self.assertEqual(llm_name2, "azure->openai->gpt-4.1")
            print("✅ gpt-4.1 LLM configuration successful")
    
    def test_environment_variable_validation(self):
        """Test environment variable validation and error messages."""
        print("\n=== Testing Environment Variable Validation ===")
        
        # Test missing AZURE_OPENAI_ENDPOINT
        os.environ.pop('AZURE_OPENAI_ENDPOINT', None)
        os.environ['AZURE_OPENAI_API_KEY'] = 'test-key'
        
        with self.assertRaises(SystemExit):
            get_azure_openai_llm("gpt-4o")
        print("✅ Correctly handles missing AZURE_OPENAI_ENDPOINT")
        
        # Test missing AZURE_OPENAI_API_KEY
        os.environ['AZURE_OPENAI_ENDPOINT'] = 'https://test.openai.azure.com/'
        os.environ.pop('AZURE_OPENAI_API_KEY', None)
        
        with self.assertRaises(SystemExit):
            get_azure_openai_llm("gpt-4o")
        print("✅ Correctly handles missing AZURE_OPENAI_API_KEY")
    
    def test_azure_openai_deployment_names(self):
        """Test that deployment names are correctly set."""
        print("\n=== Testing Azure OpenAI Deployment Names ===")
        
        with patch('task_utils.AzureChatOpenAI') as mock_azure:
            mock_instance = Mock()
            mock_azure.return_value = mock_instance
            
            os.environ['AZURE_OPENAI_ENDPOINT'] = 'https://test.openai.azure.com/'
            os.environ['AZURE_OPENAI_API_KEY'] = 'test-api-key'
            
            # Test that deployment name matches model name
            get_azure_openai_llm("gpt-4o")
            
            # Check that azure_deployment was set to the model name
            call_args = mock_azure.call_args
            self.assertEqual(call_args[1]['azure_deployment'], 'gpt-4o')
            print("✅ Deployment name correctly set to model name for gpt-4o")
            
            # Test gpt-4.1
            os.environ['AZURE_OPENAI_ENDPOINT2'] = 'https://test2.openai.azure.com/'
            os.environ['AZURE_OPENAI_API_KEY2'] = 'test-api-key-2'
            
            get_azure_openai_llm2("gpt-4.1")
            
            # Check that azure_deployment was set to the model name
            call_args = mock_azure.call_args
            self.assertEqual(call_args[1]['azure_deployment'], 'gpt-4.1')
            print("✅ Deployment name correctly set to model name for gpt-4.1")

def test_current_environment():
    """Test the current environment configuration."""
    print("\n=== Current Environment Configuration ===")
    
    azure_vars = [
        'AZURE_OPENAI_ENDPOINT',
        'AZURE_OPENAI_API_KEY', 
        'AZURE_OPENAI_API_VERSION',
        'AZURE_OPENAI_ENDPOINT2',
        'AZURE_OPENAI_API_KEY2',
        'AZURE_OPENAI_API_VERSION2'
    ]
    
    print("Current Azure OpenAI environment variables:")
    for var in azure_vars:
        value = os.getenv(var)
        if value:
            # Mask the API key for security
            if 'KEY' in var:
                masked_value = value[:8] + '...' + value[-4:] if len(value) > 12 else '***'
                print(f"  {var}: {masked_value}")
            else:
                print(f"  {var}: {value}")
        else:
            print(f"  {var}: NOT SET")
    
    print("\nTo fix the Azure OpenAI issue, set these environment variables:")
    print("  export AZURE_OPENAI_ENDPOINT='https://your-resource.openai.azure.com/'")
    print("  export AZURE_OPENAI_API_KEY='your-api-key'")
    print("  export AZURE_OPENAI_API_VERSION='2024-08-01-preview'")
    print("\nFor gpt-4.1, also set:")
    print("  export AZURE_OPENAI_ENDPOINT2='https://your-resource2.openai.azure.com/'")
    print("  export AZURE_OPENAI_API_KEY2='your-api-key-2'")
    print("  export AZURE_OPENAI_API_VERSION2='2024-12-01-preview'")

def main():
    """Run the tests and environment check."""
    print("Azure OpenAI Configuration Test")
    print("=" * 50)
    
    # Run environment check first
    test_current_environment()
    
    # Run unit tests
    print("\n" + "=" * 50)
    print("Running Unit Tests")
    print("=" * 50)
    
    unittest.main(argv=[''], exit=False, verbosity=2)

if __name__ == '__main__':
    main()
