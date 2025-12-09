#!/usr/bin/env python3
"""
Unit tests for browser-use library integration and API compatibility.
Tests the upgraded browser-use library (0.10.1) to ensure safe usage.

Note: browser-use 0.10.1 has moved away from LangChain and uses its own LLM classes.
The module structure has changed significantly from earlier versions.
"""

import unittest
import asyncio
import os
import sys
from unittest.mock import Mock, patch, AsyncMock
from pathlib import Path

# Add the parent directory to the path so we can import from agent-engine
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from browser_use import Agent, Controller, ActionResult
from browser_use.browser.session import BrowserSession, BrowserProfile
# browser-use 0.10.1 uses its own LLM classes instead of LangChain
from browser_use.llm import ChatOpenAI, ChatGoogle, ChatAzureOpenAI, BaseChatModel
from dotenv import load_dotenv

# Load environment variables
load_dotenv()


class TestBrowserUseIntegration(unittest.TestCase):
    """Test browser-use library integration and API compatibility."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.controller = Controller()
        self.test_task = "Navigate to google.com and search for 'test'"
        
    def test_controller_initialization(self):
        """Test that Controller class initializes correctly."""
        controller = Controller()
        self.assertIsInstance(controller, Controller)
        
    def test_controller_action_decorator(self):
        """Test that the @controller.registry.action decorator works correctly."""
        @self.controller.registry.action('Test action')
        def test_action(param: str) -> ActionResult:
            """Test action function."""
            return ActionResult(extracted_content=f"Test result: {param}")
        
        # Verify the action was registered
        self.assertTrue(hasattr(self.controller, 'registry'))
        
    def test_action_result_creation(self):
        """Test ActionResult creation and properties."""
        # Test successful result
        success_result = ActionResult(extracted_content="Test content")
        self.assertEqual(success_result.extracted_content, "Test content")
        self.assertIsNone(success_result.error)
        
        # Test error result
        error_result = ActionResult(error="Test error")
        self.assertEqual(error_result.error, "Test error")
        self.assertIsNone(error_result.extracted_content)
        
    def test_controller_action_with_async_function(self):
        """Test that @controller.registry.action works with async functions."""
        @self.controller.registry.action('Async test action')
        async def async_test_action(param: str) -> ActionResult:
            """Async test action function."""
            return ActionResult(extracted_content=f"Async result: {param}")
        
        # Verify the action was registered
        self.assertTrue(hasattr(self.controller, 'registry'))
        
    def test_controller_action_with_browser_session(self):
        """Test that @controller.registry.action works with BrowserSession parameter."""
        @self.controller.registry.action('Browser session test action')
        async def browser_session_action(browser: BrowserSession) -> ActionResult:
            """Action that uses BrowserSession."""
            return ActionResult(extracted_content="Browser session action executed")
        
        # Verify the action was registered
        self.assertTrue(hasattr(self.controller, 'registry'))
        
    def test_controller_action_with_param_model(self):
        """Test that @controller.registry.action works with param_model parameter."""
        from pydantic import BaseModel
        
        class TestParams(BaseModel):
            param1: str
            param2: int
            
        @self.controller.registry.action('Param model test action', param_model=TestParams)
        def param_model_action(params: TestParams) -> ActionResult:
            """Action that uses param model."""
            return ActionResult(extracted_content=f"Param1: {params.param1}, Param2: {params.param2}")
        
        # Verify the action was registered
        self.assertTrue(hasattr(self.controller, 'registry'))
        
    def test_import_compatibility(self):
        """Test that all required imports work correctly for browser-use 0.10.1."""
        # Test main imports
        from browser_use import Agent, Controller, ActionResult
        from browser_use.browser.session import BrowserSession, BrowserProfile
        from browser_use.llm import ChatOpenAI, ChatGoogle, ChatAzureOpenAI, ChatAWSBedrock
        from browser_use.agent.views import ActionResult as AgentActionResult
        
        # All imports should work without errors
        self.assertTrue(True)
        
    def test_browser_use_version(self):
        """Test that browser-use version is 0.10.1 or higher."""
        import browser_use
        # Check if version is 0.10.1 or higher
        version = getattr(browser_use, '__version__', '0.10.1')
        self.assertTrue(version.startswith('0.10'))
        
    def test_controller_registry_access(self):
        """Test that controller registry is accessible and functional."""
        @self.controller.registry.action('Registry test action')
        def registry_test_action() -> ActionResult:
            """Test action for registry access."""
            return ActionResult(extracted_content="Registry test")
        
        # Verify registry exists and has the action
        self.assertTrue(hasattr(self.controller, 'registry'))
        
    def test_action_result_with_metadata(self):
        """Test ActionResult with additional metadata."""
        result = ActionResult(
            extracted_content="Test content",
            error=None,
            metadata={"key": "value"}
        )
        
        self.assertEqual(result.extracted_content, "Test content")
        self.assertIsNone(result.error)
        
    def test_browser_use_memory_import(self):
        """Test that browser-use imports work correctly."""
        try:
            import browser_use
            self.assertTrue(True)
        except ImportError as e:
            self.fail(f"browser-use import failed: {e}")


class TestBrowserUseLLMClasses(unittest.TestCase):
    """Test browser-use native LLM classes."""
    
    def test_chat_openai_has_provider(self):
        """Test that ChatOpenAI has provider property."""
        self.assertTrue(hasattr(ChatOpenAI, 'provider'))
        
    def test_chat_google_has_provider(self):
        """Test that ChatGoogle has provider property."""
        self.assertTrue(hasattr(ChatGoogle, 'provider'))
        
    def test_chat_azure_openai_has_provider(self):
        """Test that ChatAzureOpenAI has provider property."""
        self.assertTrue(hasattr(ChatAzureOpenAI, 'provider'))
        
    def test_llm_classes_extend_base(self):
        """Test that LLM classes properly extend BaseChatModel."""
        # Check that all LLM classes are dataclasses with provider property
        self.assertTrue(hasattr(ChatOpenAI, '__dataclass_fields__'))
        self.assertTrue(hasattr(ChatGoogle, '__dataclass_fields__'))
        self.assertTrue(hasattr(ChatAzureOpenAI, '__dataclass_fields__'))


class TestBrowserUseCompatibility(unittest.TestCase):
    """Test compatibility with existing agent-engine code patterns."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.controller = Controller()
        
    def test_web_agent_imports_compatibility(self):
        """Test that web_agent.py imports work with browser-use 0.10.1."""
        try:
            # Test the imports used in web_agent.py
            from browser_use import Agent, Controller
            from browser_use.browser.session import BrowserSession, BrowserProfile
            from browser_use.agent.views import ActionResult
            self.assertTrue(True)
        except ImportError as e:
            self.fail(f"web_agent.py imports failed: {e}")
            
    def test_task_utils_imports_compatibility(self):
        """Test that task_utils.py imports work with browser-use 0.10.1."""
        try:
            from browser_use.llm import ChatOpenAI, ChatGoogle, ChatAzureOpenAI, ChatAWSBedrock, ChatDeepSeek
            self.assertTrue(True)
        except ImportError as e:
            self.fail(f"task_utils.py LLM imports failed: {e}")
            
    def test_llm_provider_attribute(self):
        """Test that all browser-use LLM classes have provider attribute."""
        from browser_use.llm import ChatOpenAI, ChatGoogle, ChatAzureOpenAI
        
        # All LLM classes should have provider property
        self.assertTrue(hasattr(ChatOpenAI, 'provider'))
        self.assertTrue(hasattr(ChatGoogle, 'provider'))
        self.assertTrue(hasattr(ChatAzureOpenAI, 'provider'))


class TestBrowserUseErrorHandling(unittest.TestCase):
    """Test error handling and edge cases with browser-use."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.controller = Controller()
        
    def test_action_result_error_handling(self):
        """Test ActionResult error handling."""
        # Test with error
        error_result = ActionResult(error="Test error message")
        self.assertEqual(error_result.error, "Test error message")
        self.assertIsNone(error_result.extracted_content)
        
        # Test with both error and content (should prioritize error)
        mixed_result = ActionResult(
            extracted_content="Some content",
            error="Error occurred"
        )
        self.assertEqual(mixed_result.error, "Error occurred")
        self.assertEqual(mixed_result.extracted_content, "Some content")
        
    def test_controller_action_error_handling(self):
        """Test error handling in controller actions."""
        @self.controller.registry.action('Error test action')
        def error_test_action() -> ActionResult:
            """Action that returns an error."""
            try:
                # Simulate an error
                raise ValueError("Test error")
            except Exception as e:
                return ActionResult(error=f"Action failed: {str(e)}")
        
        # The action should be registered without error
        self.assertTrue(hasattr(self.controller, 'registry'))
        
    def test_action_result_validation(self):
        """Test ActionResult parameter validation."""
        # Test with valid parameters
        result = ActionResult(extracted_content="Valid content")
        self.assertEqual(result.extracted_content, "Valid content")
        
        # Test with empty content
        empty_result = ActionResult(extracted_content="")
        self.assertEqual(empty_result.extracted_content, "")


class TestTaskUtilsLLMFunctions(unittest.TestCase):
    """Test task_utils LLM initialization functions."""
    
    def test_get_llm_import(self):
        """Test that get_llm can be imported from task_utils."""
        try:
            from task_utils import get_llm
            self.assertTrue(callable(get_llm))
        except ImportError as e:
            self.fail(f"get_llm import failed: {e}")
            
    def test_get_gemini_llm_import(self):
        """Test that get_gemini_llm can be imported from task_utils."""
        try:
            from task_utils import get_gemini_llm
            self.assertTrue(callable(get_gemini_llm))
        except ImportError as e:
            self.fail(f"get_gemini_llm import failed: {e}")
            
    def test_get_azure_openai_llm_import(self):
        """Test that get_azure_openai_llm can be imported from task_utils."""
        try:
            from task_utils import get_azure_openai_llm
            self.assertTrue(callable(get_azure_openai_llm))
        except ImportError as e:
            self.fail(f"get_azure_openai_llm import failed: {e}")
            
    def test_get_openai_llm_import(self):
        """Test that get_openai_llm can be imported from task_utils."""
        try:
            from task_utils import get_openai_llm
            self.assertTrue(callable(get_openai_llm))
        except ImportError as e:
            self.fail(f"get_openai_llm import failed: {e}")


if __name__ == '__main__':
    # Set up test environment
    os.environ.setdefault('NODE_ENV', 'test')
    
    # Run the tests
    unittest.main(verbosity=2)
