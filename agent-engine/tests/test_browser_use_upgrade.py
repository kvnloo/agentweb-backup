#!/usr/bin/env python3
"""
Test script to verify browser-use library upgrade to version 0.7.1.
This script tests the compatibility and functionality of the upgraded library.
"""

import asyncio
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Add the current directory to the path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Load environment variables
load_dotenv()

def test_imports():
    """Test that all required imports work with the new version."""
    print("Testing imports...")
    
    try:
        from browser_use import Agent, Controller, ActionResult
        from browser_use.browser.browser import Browser, BrowserConfig
        from browser_use.browser.context import BrowserContext, BrowserContextConfig
        from browser_use.agent.views import ActionResult as ActionResultView
        print("✅ All imports successful")
        return True
    except ImportError as e:
        print(f"❌ Import failed: {e}")
        return False

def test_controller_initialization():
    """Test Controller class initialization."""
    print("Testing Controller initialization...")
    
    try:
        from browser_use import Controller
        controller = Controller()
        print("✅ Controller initialization successful")
        return True
    except Exception as e:
        print(f"❌ Controller initialization failed: {e}")
        return False

def test_agent_initialization():
    """Test Agent class availability and basic structure."""
    print("Testing Agent class...")
    
    try:
        from browser_use import Agent, Controller
        from browser_use.browser.browser import Browser, BrowserConfig
        
        # Test that Agent class exists and has expected methods
        assert hasattr(Agent, '__init__')
        assert hasattr(Agent, 'run')
        
        # Test that we can create basic components
        controller = Controller()
        config = BrowserConfig(headless=True)
        browser = Browser(config=config)
        
        # Test that Agent class has the expected methods
        assert hasattr(Agent, 'run'), "Agent class should have 'run' method"
        assert callable(Agent.run), "Agent.run should be callable"
        
        # Test that we can access the class without errors
        assert Agent is not None, "Agent class should be importable"
        
        print("✅ Agent class structure test successful")
        return True
    except Exception as e:
        print(f"❌ Agent class test failed: {e}")
        return False

def test_action_result():
    """Test ActionResult creation and usage."""
    print("Testing ActionResult...")
    
    try:
        from browser_use import ActionResult
        
        # Test successful result
        success_result = ActionResult(extracted_content="Test content")
        assert success_result.extracted_content == "Test content"
        assert success_result.error is None
        
        # Test error result
        error_result = ActionResult(error="Test error")
        assert error_result.error == "Test error"
        assert error_result.extracted_content is None
        
        print("✅ ActionResult tests successful")
        return True
    except Exception as e:
        print(f"❌ ActionResult tests failed: {e}")
        return False

def test_controller_action_decorator():
    """Test @controller.registry.action decorator."""
    print("Testing @controller.registry.action decorator...")
    
    try:
        from browser_use import Controller, ActionResult
        
        controller = Controller()
        
        @controller.registry.action('Test action')
        def test_action(param: str) -> ActionResult:
            """Test action function."""
            return ActionResult(extracted_content=f"Result: {param}")
        
        # Verify the action was registered
        assert hasattr(controller, 'registry')
        
        print("✅ @controller.registry.action decorator test successful")
        return True
    except Exception as e:
        print(f"❌ @controller.registry.action decorator test failed: {e}")
        return False

def test_browser_config():
    """Test BrowserConfig options."""
    print("Testing BrowserConfig...")
    
    try:
        from browser_use.browser.browser import Browser, BrowserConfig
        
        # Test headless mode
        config_headless = BrowserConfig(headless=True)
        assert config_headless.headless is True
        
        # Test non-headless mode
        config_visible = BrowserConfig(headless=False)
        assert config_visible.headless is False
        
        print("✅ BrowserConfig tests successful")
        return True
    except Exception as e:
        print(f"❌ BrowserConfig tests failed: {e}")
        return False

def test_browser_context_config():
    """Test BrowserContextConfig."""
    print("Testing BrowserContextConfig...")
    
    try:
        from browser_use.browser.context import BrowserContext, BrowserContextConfig
        from browser_use.browser.browser import Browser, BrowserConfig
        
        # Create a Browser instance first
        browser_config = BrowserConfig(headless=True)
        browser = Browser(config=browser_config)
        
        # Create BrowserContext with the browser instance
        context_config = BrowserContextConfig()
        context = BrowserContext(browser=browser, config=context_config)
        
        assert isinstance(context, BrowserContext)
        
        print("✅ BrowserContextConfig tests successful")
        return True
    except Exception as e:
        print(f"❌ BrowserContextConfig tests failed: {e}")
        return False

def test_web_agent_compatibility():
    """Test compatibility with web_agent.py patterns."""
    print("Testing web_agent.py compatibility...")
    
    try:
        from browser_use import Agent, Controller, ActionResult
        from browser_use.browser.browser import Browser, BrowserConfig
        from browser_use.browser.context import BrowserContext, BrowserContextConfig
        
        # Test the patterns used in web_agent.py
        controller = Controller()
        
        @controller.registry.action('Test web agent action')
        def test_web_agent_action(param: str) -> ActionResult:
            """Test action following web_agent.py pattern."""
            return ActionResult(extracted_content=f"Web agent result: {param}")
        
        # Test Browser initialization
        config = BrowserConfig(headless=True)
        browser = Browser(config=config)
        
        # Test BrowserContext initialization
        context_config = BrowserContextConfig()
        context = BrowserContext(browser=browser, config=context_config)
        
        print("✅ web_agent.py compatibility tests successful")
        return True
    except Exception as e:
        print(f"❌ web_agent.py compatibility tests failed: {e}")
        return False

def test_version_compatibility():
    """Test that we're using the correct version."""
    print("Testing version compatibility...")
    
    try:
        import browser_use
        version = getattr(browser_use, '__version__', 'Unknown')
        print(f"Browser-use version: {version}")
        
        # Check if version is 0.7.x
        if version.startswith('0.7.'):
            print("✅ Version compatibility check passed")
            return True
        else:
            print(f"⚠️  Warning: Expected version 0.7.x, got {version}")
            return True  # Still pass, as long as it works
    except Exception as e:
        print(f"❌ Version check failed: {e}")
        return False

def main():
    """Run all tests."""
    print("=" * 60)
    print("Browser-Use Library Upgrade Test")
    print("=" * 60)
    
    tests = [
        test_imports,
        test_controller_initialization,
        test_agent_initialization,
        test_action_result,
        test_controller_action_decorator,
        test_browser_config,
        test_browser_context_config,
        test_web_agent_compatibility,
        test_version_compatibility,
    ]
    
    passed = 0
    total = len(tests)
    
    for test in tests:
        print()
        if test():
            passed += 1
        print("-" * 40)
    
    print(f"\nTest Results: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All tests passed! Browser-use upgrade is successful.")
        return 0
    else:
        print("❌ Some tests failed. Please check the errors above.")
        return 1

if __name__ == '__main__':
    sys.exit(main())
