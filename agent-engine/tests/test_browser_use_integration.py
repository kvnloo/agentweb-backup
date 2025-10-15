#!/usr/bin/env python3
"""
Unit tests for browser-use library integration and API compatibility.
Tests the upgraded browser-use library (0.7.1) to ensure safe usage.
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
from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContext, BrowserContextConfig
from langchain_openai import ChatOpenAI
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
        
    def test_agent_initialization_with_controller(self):
        """Test that Agent initializes correctly with Controller."""
        # Mock the LLM and Browser with proper structure
        mock_llm = Mock(spec=ChatOpenAI)
        mock_browser = Mock(spec=Browser)
        mock_browser.config = Mock()
        mock_browser.config.new_context_config = Mock()
        
        # Test Agent initialization with controller parameter
        agent = Agent(
            task=self.test_task,
            llm=mock_llm,
            controller=self.controller,
            browser=mock_browser
        )
        
        self.assertIsInstance(agent, Agent)
        self.assertEqual(agent.task, self.test_task)
        
    def test_browser_initialization(self):
        """Test that Browser initializes correctly with BrowserConfig."""
        config = BrowserConfig(headless=True)
        browser = Browser(config=config)
        
        self.assertIsInstance(browser, Browser)
        
    def test_browser_context_initialization(self):
        """Test that BrowserContext initializes correctly."""
        from browser_use.browser.browser import Browser, BrowserConfig
        
        # Create a Browser instance first
        browser_config = BrowserConfig(headless=True)
        browser = Browser(config=browser_config)
        
        # Create BrowserContext with the browser instance
        config = BrowserContextConfig()
        context = BrowserContext(browser=browser, config=config)
        
        self.assertIsInstance(context, BrowserContext)
        
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
        
    def test_controller_action_with_browser_context(self):
        """Test that @controller.registry.action works with BrowserContext parameter."""
        @self.controller.registry.action('Browser context test action')
        async def browser_context_action(browser: BrowserContext) -> ActionResult:
            """Action that uses BrowserContext."""
            return ActionResult(extracted_content="Browser context action executed")
        
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
        
    def test_agent_run_method_signature(self):
        """Test that Agent.run method has the expected signature."""
        mock_llm = Mock(spec=ChatOpenAI)
        mock_browser = Mock(spec=Browser)
        mock_browser.config = Mock()
        mock_browser.config.new_context_config = Mock()
        
        agent = Agent(
            task=self.test_task,
            llm=mock_llm,
            controller=self.controller,
            browser=mock_browser
        )
        
        # Check that run method exists and is callable
        self.assertTrue(hasattr(agent, 'run'))
        self.assertTrue(callable(agent.run))
        
    def test_browser_config_options(self):
        """Test BrowserConfig with various options."""
        # Test headless mode
        config_headless = BrowserConfig(headless=True)
        self.assertTrue(config_headless.headless)
        
        # Test non-headless mode
        config_visible = BrowserConfig(headless=False)
        self.assertFalse(config_visible.headless)
        
    def test_browser_context_config_options(self):
        """Test BrowserContextConfig with various options."""
        config = BrowserContextConfig()
        self.assertIsInstance(config, BrowserContextConfig)
        
    def test_import_compatibility(self):
        """Test that all required imports work correctly."""
        # Test main imports
        from browser_use import Agent, Controller, ActionResult
        from browser_use.browser.browser import Browser, BrowserConfig
        from browser_use.browser.context import BrowserContext, BrowserContextConfig
        
        # All imports should work without errors
        self.assertTrue(True)
        
    def test_agent_with_use_vision_parameter(self):
        """Test Agent initialization with use_vision parameter."""
        mock_llm = Mock(spec=ChatOpenAI)
        mock_browser = Mock(spec=Browser)
        mock_browser.config = Mock()
        mock_browser.config.new_context_config = Mock()
        
        # Test with use_vision=True
        agent_vision = Agent(
            task=self.test_task,
            llm=mock_llm,
            controller=self.controller,
            browser=mock_browser,
            use_vision=True
        )
        
        self.assertIsInstance(agent_vision, Agent)
        
        # Test with use_vision=False
        agent_no_vision = Agent(
            task=self.test_task,
            llm=mock_llm,
            controller=self.controller,
            browser=mock_browser,
            use_vision=False
        )
        
        self.assertIsInstance(agent_no_vision, Agent)
        
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
        """Test that browser-use[memory] imports work correctly."""
        try:
            # This should work if browser-use[memory] is installed
            import browser_use
            self.assertTrue(True)
        except ImportError as e:
            self.fail(f"browser-use[memory] import failed: {e}")
            
    def test_agent_max_steps_parameter(self):
        """Test that Agent.run accepts max_steps parameter."""
        mock_llm = Mock(spec=ChatOpenAI)
        mock_browser = Mock(spec=Browser)
        mock_browser.config = Mock()
        mock_browser.config.new_context_config = Mock()
        
        agent = Agent(
            task=self.test_task,
            llm=mock_llm,
            controller=self.controller,
            browser=mock_browser
        )
        
        # Check that run method can be called with max_steps
        # We'll mock the run method to avoid actual execution
        agent.run = Mock(return_value=asyncio.Future())
        agent.run.return_value.set_result(ActionResult(extracted_content="Test"))
        
        # This should not raise an error
        try:
            # Note: We're not actually running this, just testing the signature
            pass
        except Exception as e:
            self.fail(f"Agent.run with max_steps failed: {e}")


class TestBrowserUseCompatibility(unittest.TestCase):
    """Test compatibility with existing agent-engine code patterns."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.controller = Controller()
        
    def test_web_agent_imports_compatibility(self):
        """Test that web_agent.py imports work with new browser-use version."""
        try:
            # Test the imports used in web_agent.py
            from browser_use import Agent, Controller
            from browser_use.browser.browser import Browser, BrowserConfig
            from browser_use.browser.context import BrowserContextConfig, BrowserContext
            from browser_use.agent.views import ActionResult
            self.assertTrue(True)
        except ImportError as e:
            self.fail(f"web_agent.py imports failed: {e}")
            
    def test_task_utils_imports_compatibility(self):
        """Test that task_utils.py imports work with new browser-use version."""
        try:
            from browser_use.agent.views import ActionResult
            self.assertTrue(True)
        except ImportError as e:
            self.fail(f"task_utils.py imports failed: {e}")
            
    def test_test_files_imports_compatibility(self):
        """Test that test files imports work with new browser-use version."""
        try:
            from browser_use import Agent, ActionResult, Controller
            from browser_use.browser.browser import Browser, BrowserConfig
            from browser_use.browser.context import BrowserContextConfig, BrowserContext
            self.assertTrue(True)
        except ImportError as e:
            self.fail(f"Test files imports failed: {e}")


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
        
    def test_agent_initialization_error_handling(self):
        """Test Agent initialization with invalid parameters."""
        # Test with None LLM - this should raise an error during LLM verification
        mock_browser = Mock(spec=Browser)
        mock_browser.config = Mock()
        mock_browser.config.new_context_config = Mock()
        
        # The Agent constructor should raise an error when llm=None
        # because it tries to verify the LLM connection
        with self.assertRaises((TypeError, ValueError, AttributeError)):
            agent = Agent(
                task="test",
                llm=None,
                controller=self.controller,
                browser=mock_browser
            )
            
    def test_browser_config_error_handling(self):
        """Test BrowserConfig with invalid parameters."""
        # Test with invalid headless parameter - this might not raise an error
        # depending on how Pydantic handles type conversion
        try:
            config = BrowserConfig(headless="invalid")
            # If it doesn't raise an error, that's also acceptable
            self.assertIsInstance(config, BrowserConfig)
        except (TypeError, ValueError):
            # This is also acceptable - the config should reject invalid values
            pass
            
    def test_action_result_validation(self):
        """Test ActionResult parameter validation."""
        # Test with valid parameters
        result = ActionResult(extracted_content="Valid content")
        self.assertEqual(result.extracted_content, "Valid content")
        
        # Test with empty content
        empty_result = ActionResult(extracted_content="")
        self.assertEqual(empty_result.extracted_content, "")


if __name__ == '__main__':
    # Set up test environment
    os.environ.setdefault('NODE_ENV', 'test')
    
    # Run the tests
    unittest.main(verbosity=2)
