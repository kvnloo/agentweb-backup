#!/usr/bin/env python3
import unittest
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add parent directory to path to import task_utils
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from task_utils import run_python_code_in_sandbox, get_openai_llm, get_openai_llm_think
from browser_use.agent.views import ActionResult

class TestRunPythonCodeInSandbox(unittest.TestCase):
    """Test the run_python_code_in_sandbox function."""
    
    def setUp(self):
        """Set up test fixtures."""
        # Create a temporary execution ID for testing
        self.execution_id = "test_execution_123"
        
        # Create a test directory and make sure it gets cleaned up
        self.temp_dir = tempfile.mkdtemp()
        self.original_temp_dir = tempfile.tempdir
        tempfile.tempdir = self.temp_dir
        
    def tearDown(self):
        """Tear down test fixtures."""
        # Reset tempfile.tempdir
        tempfile.tempdir = self.original_temp_dir
        
        # Clean up test directory
        execution_dir = os.path.join(self.temp_dir, f"execution_{self.execution_id}")
        if os.path.exists(execution_dir):
            for file in os.listdir(execution_dir):
                os.remove(os.path.join(execution_dir, file))
            os.rmdir(execution_dir)
            
        os.rmdir(self.temp_dir)
        
    def test_successful_execution(self):
        """Test that the function successfully executes valid Python code."""
        python_code = "print('Hello, World!')"
        
        result = run_python_code_in_sandbox(
            python_code=python_code,
            execution_id=self.execution_id,
            user_id="test_user",
            script_type="test"
        )
        
        self.assertIsInstance(result, ActionResult)
        self.assertEqual(result.extracted_content, "Hello, World!\n")
        self.assertIsNone(result.error)
        
    def test_execution_with_error(self):
        """Test that the function handles Python code with errors."""
        python_code = "print('This will run')\nx = 1/0\nprint('This will not run')"
        
        result = run_python_code_in_sandbox(
            python_code=python_code,
            execution_id=self.execution_id,
            user_id="test_user",
            script_type="test"
        )
        
        self.assertIsInstance(result, ActionResult)
        self.assertIsNotNone(result.error)
        self.assertIn("ZeroDivisionError", result.error)
        
    def test_timeout_handling(self):
        """Test that the function handles code that exceeds the timeout.

        The sandbox timeout is read from SANDBOX_TIMEOUT_SECONDS (default
        300s in prod - see agent-engine.service) rather than a hardcoded
        30s, so this overrides it to 2s and sleeps 5s to keep the test fast
        and deterministic regardless of the real default."""
        python_code = "import time\ntime.sleep(5)"

        with patch.dict(os.environ, {'SANDBOX_TIMEOUT_SECONDS': '2'}):
            result = run_python_code_in_sandbox(
                python_code=python_code,
                execution_id=self.execution_id,
                user_id="test_user",
                script_type="test"
            )

        self.assertIsInstance(result, ActionResult)
        self.assertIsNotNone(result.error)
        self.assertEqual(result.error, "Execution timed out after 2 seconds")
        
    def test_header_comment(self):
        """Test that the function correctly adds a header comment."""
        python_code = "print('Hello with header')"
        header_comment = "# Test header\n# Second line"
        
        # Mock open to check the file content
        original_open = open
        file_content = []
        
        def mock_open(*args, **kwargs):
            if args[0].endswith('.py') and 'w' in args[1]:
                mock_file = MagicMock()
                mock_file.__enter__ = MagicMock(return_value=mock_file)
                mock_file.__exit__ = MagicMock(return_value=None)
                mock_file.write = lambda x: file_content.append(x)
                return mock_file
            return original_open(*args, **kwargs)
        
        with patch('builtins.open', mock_open):
            result = run_python_code_in_sandbox(
                python_code=python_code,
                execution_id=self.execution_id,
                user_id="test_user",
                script_type="test",
                header_comment=header_comment
            )
        
        # Check that header was added before the code
        self.assertIn("# Test header\n# Second line\n\nprint('Hello with header')", "".join(file_content))
        
    def test_additional_env_vars(self):
        """Test that additional environment variables are passed to the subprocess."""
        python_code = "import os\nprint(f'TEST_VAR={os.environ.get(\"TEST_VAR\", \"NOT_FOUND\")}')"
        
        result = run_python_code_in_sandbox(
            python_code=python_code,
            execution_id=self.execution_id,
            user_id="test_user",
            script_type="test",
            additional_env_vars={"TEST_VAR": "TEST_VALUE"}
        )
        
        self.assertIsInstance(result, ActionResult)
        self.assertEqual(result.extracted_content, "TEST_VAR=TEST_VALUE\n")
        
    def test_file_cleanup(self):
        """Test that temporary files are cleaned up after execution."""
        python_code = "print('Testing cleanup')"
        
        run_python_code_in_sandbox(
            python_code=python_code,
            execution_id=self.execution_id,
            user_id="test_user",
            script_type="test"
        )
        
        # Check that no .py files remain in the execution directory
        execution_dir = os.path.join(self.temp_dir, f"execution_{self.execution_id}")
        if os.path.exists(execution_dir):
            py_files = [f for f in os.listdir(execution_dir) if f.endswith('.py')]
            self.assertEqual(len(py_files), 0, "Temporary Python files were not cleaned up")
        
    def test_permission_restrictions(self):
        """Test that the execution directory has restricted permissions."""
        python_code = "print('Testing permissions')"
        
        run_python_code_in_sandbox(
            python_code=python_code,
            execution_id=self.execution_id,
            user_id="test_user",
            script_type="test"
        )
        
        # Check permissions on the execution directory (should be 0o700 = rwx------)
        execution_dir = os.path.join(self.temp_dir, f"execution_{self.execution_id}")
        if os.path.exists(execution_dir):
            permissions = oct(os.stat(execution_dir).st_mode & 0o777)
            self.assertEqual(permissions, oct(0o700), "Execution directory does not have restricted permissions")
            
    def test_invalid_python_code(self):
        """Test handling of syntactically invalid Python code."""
        python_code = "print('This is invalid syntax'"  # Missing closing parenthesis
        
        result = run_python_code_in_sandbox(
            python_code=python_code,
            execution_id=self.execution_id,
            user_id="test_user",
            script_type="test"
        )
        
        self.assertIsInstance(result, ActionResult)
        self.assertIsNotNone(result.error)
        self.assertIn("SyntaxError", result.error)

class TestOpenAIExportsEnvVar(unittest.TestCase):
    """ENG-389: browser-use's own preflight check (browser_use/agent/views.py's
    REQUIRED_LLM_API_ENV_VARS = {'ChatOpenAI': ['OPENAI_API_KEY']}) reads
    OPENAI_API_KEY directly from os.environ, independent of the api_key
    passed to ChatOpenAI's constructor. Without exporting it, every
    openai->openai-> task failed with "The api_key client option must be
    set..." even though the secret itself was fine - found via live testing
    against the real pipeline (Dev tables), confirmed by inspecting the
    installed browser-use package on the VM directly."""

    def setUp(self):
        self.original_env = os.environ.pop('OPENAI_API_KEY', None)

    def tearDown(self):
        if self.original_env is not None:
            os.environ['OPENAI_API_KEY'] = self.original_env
        else:
            os.environ.pop('OPENAI_API_KEY', None)

    @patch('task_utils.secrets_manager.get_openai_api_key', return_value='sk-test-key-123')
    def test_get_openai_llm_exports_env_var(self, mock_get_key):
        self.assertNotIn('OPENAI_API_KEY', os.environ)
        get_openai_llm('gpt-4o')
        self.assertEqual(os.environ.get('OPENAI_API_KEY'), 'sk-test-key-123')

    @patch('task_utils.secrets_manager.get_openai_api_key', return_value='sk-test-key-456')
    def test_get_openai_llm_think_exports_env_var(self, mock_get_key):
        self.assertNotIn('OPENAI_API_KEY', os.environ)
        get_openai_llm_think('o3-mini')
        self.assertEqual(os.environ.get('OPENAI_API_KEY'), 'sk-test-key-456')


if __name__ == '__main__':
    unittest.main() 