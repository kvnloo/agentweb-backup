#!/usr/bin/env python3
"""
Regression test for ENG-1818.

Root cause (confirmed via a direct repro against the real production
environment, full traceback captured): every model in this codebase is
routed through OpenRouter via langchain_openai.ChatOpenAI
(openrouter_gateway.py), so self.llm.__class__.__name__ is always
"ChatOpenAI" regardless of the real provider. browser-use's Agent defaults
enable_memory=True and, when unset, constructs a mem0 Memory instance whose
embedder defaults to OpenAI based on that same class-name inference -- which
needs a real OPENAI_API_KEY that doesn't exist anywhere in this codebase
(everything routes through OPENROUTER_API_KEY by design, per commit
83f22aadd "eliminate gateway credential race", which removed the process-env
OPENAI_API_KEY shim that used to incidentally satisfy this same check).

That mem0 embedder construction raises openai.OpenAIError, which is NOT
caught by browser-use's own `except ImportError` around Memory(...), so it
propagates straight through Agent.__init__() and aborts every single task
before any real work starts. Memory was never an intentionally used feature
here (pure unrequested library default) -- disabling it explicitly is the
fix, not attempting to fake an OpenAI-shaped credential again.
"""

import os
import sys
import asyncio
import unittest
from unittest.mock import Mock, patch

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestEng1818MemoryDisabled(unittest.TestCase):
    """WebAgent.setup() must construct Agent(...) with enable_memory=False."""

    def test_agent_kwargs_disable_memory(self):
        with patch('web_agent.get_llm') as mock_get_llm, \
             patch('web_agent.Agent') as mock_agent_cls, \
             patch('web_agent.Browser') as mock_browser_cls:
            mock_llm = Mock()
            mock_llm.model_name = 'google/gemini-2.5-flash'
            mock_get_llm.return_value = (mock_llm, 'google->google->gemini-2.5-flash')
            mock_browser_cls.return_value = Mock()
            mock_agent_cls.return_value = Mock()

            from web_agent import WebAgent

            agent = WebAgent(user_id=None, full_llm_name='google->google->gemini-2.5-flash')
            agent.task = 'test task'
            agent.generate_gif = False

            asyncio.run(agent.setup(validate_output=False))

            self.assertTrue(mock_agent_cls.called, "Agent(...) was never constructed")
            _, kwargs = mock_agent_cls.call_args
            self.assertIn('enable_memory', kwargs)
            self.assertFalse(
                kwargs['enable_memory'],
                "enable_memory must be explicitly False -- browser-use's own "
                "True default constructs a mem0 Memory instance whose embedder "
                "wrongly infers a real OpenAI account from ChatOpenAI's class "
                "name (every model here is actually OpenRouter-routed "
                "ChatOpenAI), and that construction is not exception-contained "
                "for anything but ImportError -- this is the exact ENG-1818 crash."
            )


if __name__ == '__main__':
    unittest.main()
