#!/usr/bin/env python3
"""
Test Azure OpenAI models with memory fix applied.
This test verifies that gpt-4o and gpt-4.1 work after fixing the memory issue.
"""

import os
import sys
import unittest
from unittest.mock import patch, Mock

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Apply memory fix before importing other modules
try:
    from memory_fix import cleanup_memory_databases, setup_memory_environment
    cleanup_memory_databases()
    setup_memory_environment()
except ImportError:
    print("Memory fix module not available, using fallback cleanup")
    import glob
    import shutil
    mem0_dirs = glob.glob("/tmp/mem0_*")
    for mem0_dir in mem0_dirs:
        try:
            shutil.rmtree(mem0_dir)
        except:
            pass

from task_utils import get_llm

class TestAzureOpenAIWithMemoryFix(unittest.TestCase):
    """Test Azure OpenAI models with memory fix applied."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.original_env = os.environ.copy()
        
    def tearDown(self):
        """Clean up after tests."""
        os.environ.clear()
        os.environ.update(self.original_env)
    
    def test_azure_openai_gpt4o_with_memory_fix(self):
        """Test gpt-4o initialization with memory fix."""
        print("\n=== Testing gpt-4o with Memory Fix ===")
        
        # Mock the ChatAzureOpenAI class from browser_use.llm to avoid actual API calls
        with patch('browser_use.llm.ChatAzureOpenAI') as mock_azure:
            mock_instance = Mock()
            mock_azure.return_value = mock_instance
            
            # Set up environment variables for gpt-4o
            os.environ['AZURE_OPENAI_ENDPOINT'] = 'https://test.openai.azure.com/'
            os.environ['AZURE_OPENAI_API_KEY'] = 'test-api-key'
            os.environ['AZURE_OPENAI_API_VERSION'] = '2024-08-01-preview'
            
            # Test gpt-4o initialization
            try:
                llm, llm_name = get_llm("azure->openai->gpt-4o")
                
                # Verify the LLM was created
                self.assertIsNotNone(llm)
                self.assertEqual(llm_name, "azure->openai->gpt-4o")
                
                # Verify ChatAzureOpenAI was called with correct parameters
                mock_azure.assert_called_once()
                call_args = mock_azure.call_args
                self.assertEqual(call_args[1]['model'], 'gpt-4o')
                self.assertEqual(call_args[1]['azure_endpoint'], 'https://test.openai.azure.com/')
                self.assertEqual(call_args[1]['api_key'], 'test-api-key')
                
                print("✅ gpt-4o initialization successful with memory fix")
                
            except Exception as e:
                self.fail(f"gpt-4o initialization failed: {e}")
    
    def test_azure_openai_gpt41_with_memory_fix(self):
        """Test gpt-4.1 initialization with memory fix."""
        print("\n=== Testing gpt-4.1 with Memory Fix ===")
        
        # Mock the ChatAzureOpenAI class from browser_use.llm to avoid actual API calls
        with patch('browser_use.llm.ChatAzureOpenAI') as mock_azure:
            mock_instance = Mock()
            mock_azure.return_value = mock_instance
            
            # Set up environment variables for gpt-4.1
            os.environ['AZURE_OPENAI_ENDPOINT2'] = 'https://test2.openai.azure.com/'
            os.environ['AZURE_OPENAI_API_KEY2'] = 'test-api-key-2'
            os.environ['AZURE_OPENAI_API_VERSION2'] = '2024-12-01-preview'
            
            # Test gpt-4.1 initialization
            try:
                llm, llm_name = get_llm("azure->openai->gpt-4.1")
                
                # Verify the LLM was created
                self.assertIsNotNone(llm)
                self.assertEqual(llm_name, "azure->openai->gpt-4.1")
                
                # Verify ChatAzureOpenAI was called with correct parameters
                mock_azure.assert_called_once()
                call_args = mock_azure.call_args
                self.assertEqual(call_args[1]['model'], 'gpt-4.1')
                self.assertEqual(call_args[1]['azure_endpoint'], 'https://test2.openai.azure.com/')
                self.assertEqual(call_args[1]['api_key'], 'test-api-key-2')
                
                print("✅ gpt-4.1 initialization successful with memory fix")
                
            except Exception as e:
                self.fail(f"gpt-4.1 initialization failed: {e}")
    
    def test_memory_environment_variables(self):
        """Test that memory environment variables are set correctly."""
        print("\n=== Testing Memory Environment Variables ===")
        
        # Check that memory environment variables are set
        self.assertEqual(os.environ.get('MEM0_DATABASE_URL'), 'sqlite:///:memory:')
        self.assertEqual(os.environ.get('MEM0_BACKEND'), 'sqlite')
        
        print("✅ Memory environment variables set correctly")
    
    def test_web_agent_import_with_memory_fix(self):
        """Test that web_agent.py can be imported with memory fix applied."""
        print("\n=== Testing WebAgent Import with Memory Fix ===")
        
        try:
            # This should work without the old_history error
            from web_agent import WebAgent
            print("✅ WebAgent imported successfully with memory fix")
            
            # Set required environment variable for CookieSync
            os.environ['AWS_S3_BUCKET_INTERNAL'] = 'test-bucket'
            
            # Test that WebAgent can be instantiated (with mock LLM and CookieSync)
            with patch('web_agent.get_llm') as mock_get_llm, \
                 patch('web_agent.CookieSync') as mock_cookie_sync:
                mock_llm = Mock()
                mock_get_llm.return_value = (mock_llm, "test-llm")
                mock_cookie_sync.return_value = Mock()
                
                agent = WebAgent(user_id="test", full_llm_name="test-llm")
                self.assertIsNotNone(agent)
                print("✅ WebAgent instantiated successfully with memory fix")
                
        except Exception as e:
            self.fail(f"WebAgent import/instantiation failed: {e}")

def test_actual_azure_models():
    """Test actual Azure models if credentials are available."""
    print("\n=== Testing Actual Azure Models ===")
    
    # Check if Azure credentials are available
    azure_endpoint = os.getenv('AZURE_OPENAI_ENDPOINT')
    azure_key = os.getenv('AZURE_OPENAI_API_KEY')
    
    if azure_endpoint and azure_key:
        print("Azure credentials found, testing actual models...")
        
        try:
            # Test gpt-4o
            llm, llm_name = get_llm("azure->openai->gpt-4o")
            print(f"✅ gpt-4o initialized successfully: {llm_name}")
            
        except Exception as e:
            print(f"❌ gpt-4o initialization failed: {e}")
        
        # Check for gpt-4.1 credentials
        azure_endpoint2 = os.getenv('AZURE_OPENAI_ENDPOINT2')
        azure_key2 = os.getenv('AZURE_OPENAI_API_KEY2')
        
        if azure_endpoint2 and azure_key2:
            try:
                # Test gpt-4.1
                llm2, llm_name2 = get_llm("azure->openai->gpt-4.1")
                print(f"✅ gpt-4.1 initialized successfully: {llm_name2}")
                
            except Exception as e:
                print(f"❌ gpt-4.1 initialization failed: {e}")
        else:
            print("⚠️  gpt-4.1 credentials not found (AZURE_OPENAI_ENDPOINT2, AZURE_OPENAI_API_KEY2)")
    else:
        print("⚠️  Azure credentials not found (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY)")
        print("Set these environment variables to test actual Azure models:")
        print("  export AZURE_OPENAI_ENDPOINT='https://your-resource.openai.azure.com/'")
        print("  export AZURE_OPENAI_API_KEY='your-api-key'")

def main():
    """Run the Azure OpenAI with memory fix tests."""
    print("Azure OpenAI with Memory Fix Test")
    print("=" * 50)
    
    # Test actual Azure models if credentials are available
    test_actual_azure_models()
    
    # Run unit tests
    print(f"\n{'='*50}")
    print("Running Unit Tests")
    print("=" * 50)
    
    unittest.main(argv=[''], exit=False, verbosity=2)

if __name__ == '__main__':
    main()
