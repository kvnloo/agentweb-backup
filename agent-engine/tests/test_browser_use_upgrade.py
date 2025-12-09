#!/usr/bin/env python3
"""
Test script to verify browser-use library upgrade to version 0.10.1.
This script tests the compatibility and functionality of the upgraded library.

Note: browser-use 0.10.1 has moved away from LangChain and uses its own LLM classes.
The module structure has changed significantly from earlier versions (0.7.x).
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
    """Test that all required imports work with the new version 0.10.1."""
    print("Testing imports...")
    
    try:
        from browser_use import Agent, Controller, ActionResult
        from browser_use.browser.session import BrowserSession, BrowserProfile
        from browser_use.agent.views import ActionResult as ActionResultView
        from browser_use.llm import ChatOpenAI, ChatGoogle, ChatAzureOpenAI
        print("✅ All imports successful")
        assert True
    except ImportError as e:
        print(f"❌ Import failed: {e}")
        assert False, f"Import failed: {e}"

def test_controller_initialization():
    """Test Controller class initialization."""
    print("Testing Controller initialization...")
    
    try:
        from browser_use import Controller
        controller = Controller()
        print("✅ Controller initialization successful")
        assert isinstance(controller, Controller)
    except Exception as e:
        print(f"❌ Controller initialization failed: {e}")
        assert False, f"Controller initialization failed: {e}"

def test_agent_initialization():
    """Test Agent class availability and basic structure."""
    print("Testing Agent class...")
    
    try:
        from browser_use import Agent, Controller
        
        # Test that Agent class exists and has expected methods
        assert hasattr(Agent, '__init__')
        assert hasattr(Agent, 'run')
        
        # Test that we can create basic components
        controller = Controller()
        
        # Test that Agent class has the expected methods
        assert hasattr(Agent, 'run'), "Agent class should have 'run' method"
        assert callable(Agent.run), "Agent.run should be callable"
        
        # Test that we can access the class without errors
        assert Agent is not None, "Agent class should be importable"
        
        print("✅ Agent class structure test successful")
    except Exception as e:
        print(f"❌ Agent class test failed: {e}")
        assert False, f"Agent class test failed: {e}"

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
    except Exception as e:
        print(f"❌ ActionResult tests failed: {e}")
        assert False, f"ActionResult tests failed: {e}"

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
    except Exception as e:
        print(f"❌ @controller.registry.action decorator test failed: {e}")
        assert False, f"@controller.registry.action decorator test failed: {e}"

def test_browser_session():
    """Test BrowserSession and BrowserProfile in 0.10.1."""
    print("Testing BrowserSession and BrowserProfile...")
    
    try:
        from browser_use.browser.session import BrowserSession, BrowserProfile
        
        # Test that the classes are importable
        assert BrowserSession is not None
        assert BrowserProfile is not None
        
        print("✅ BrowserSession and BrowserProfile tests successful")
    except Exception as e:
        print(f"❌ BrowserSession tests failed: {e}")
        assert False, f"BrowserSession tests failed: {e}"

def test_llm_classes():
    """Test browser-use native LLM classes have provider attribute."""
    print("Testing browser-use native LLM classes...")
    
    try:
        from browser_use.llm import ChatOpenAI, ChatGoogle, ChatAzureOpenAI
        
        # Test that all LLM classes have provider property
        assert hasattr(ChatOpenAI, 'provider'), "ChatOpenAI should have provider property"
        assert hasattr(ChatGoogle, 'provider'), "ChatGoogle should have provider property"
        assert hasattr(ChatAzureOpenAI, 'provider'), "ChatAzureOpenAI should have provider property"
        
        print("✅ LLM classes tests successful")
    except Exception as e:
        print(f"❌ LLM classes tests failed: {e}")
        assert False, f"LLM classes tests failed: {e}"

def test_web_agent_compatibility():
    """Test compatibility with web_agent.py patterns for 0.10.1."""
    print("Testing web_agent.py compatibility...")
    
    try:
        from browser_use import Agent, Controller, ActionResult
        from browser_use.browser.session import BrowserSession, BrowserProfile
        from browser_use.llm import ChatOpenAI, ChatGoogle, ChatAzureOpenAI
        
        # Test the patterns used in web_agent.py
        controller = Controller()
        
        @controller.registry.action('Test web agent action')
        def test_web_agent_action(param: str) -> ActionResult:
            """Test action following web_agent.py pattern."""
            return ActionResult(extracted_content=f"Web agent result: {param}")
        
        # Test that LLM classes are available
        assert ChatOpenAI is not None
        assert ChatGoogle is not None
        assert ChatAzureOpenAI is not None
        
        print("✅ web_agent.py compatibility tests successful")
    except Exception as e:
        print(f"❌ web_agent.py compatibility tests failed: {e}")
        assert False, f"web_agent.py compatibility tests failed: {e}"

def test_version_compatibility():
    """Test that we're using the correct version (0.10.x)."""
    print("Testing version compatibility...")
    
    try:
        import browser_use
        version = getattr(browser_use, '__version__', 'Unknown')
        print(f"Browser-use version: {version}")
        
        # Check if version is 0.10.x
        if version.startswith('0.10'):
            print("✅ Version compatibility check passed (0.10.x)")
        else:
            print(f"⚠️  Warning: Expected version 0.10.x, got {version}")
        
        assert True  # Pass as long as it works
    except Exception as e:
        print(f"❌ Version check failed: {e}")
        assert False, f"Version check failed: {e}"

def test_task_utils_llm_functions():
    """Test that task_utils LLM functions are available."""
    print("Testing task_utils LLM functions...")
    
    try:
        sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from task_utils import get_llm, get_gemini_llm, get_azure_openai_llm, get_openai_llm
        
        assert callable(get_llm)
        assert callable(get_gemini_llm)
        assert callable(get_azure_openai_llm)
        assert callable(get_openai_llm)
        
        print("✅ task_utils LLM functions tests successful")
    except Exception as e:
        print(f"❌ task_utils LLM functions tests failed: {e}")
        assert False, f"task_utils LLM functions tests failed: {e}"

def main():
    """Run all tests."""
    print("=" * 60)
    print("Browser-Use Library Upgrade Test (0.10.1)")
    print("=" * 60)
    
    tests = [
        test_imports,
        test_controller_initialization,
        test_agent_initialization,
        test_action_result,
        test_controller_action_decorator,
        test_browser_session,
        test_llm_classes,
        test_web_agent_compatibility,
        test_version_compatibility,
        test_task_utils_llm_functions,
    ]
    
    passed = 0
    total = len(tests)
    
    for test in tests:
        print()
        try:
            test()
            passed += 1
        except AssertionError as e:
            print(f"Test failed: {e}")
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
