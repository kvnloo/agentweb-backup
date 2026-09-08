"""ENG-1450 contract for the agent-engine OpenRouter cutover."""

import importlib.util
import os
from pathlib import Path

from usage_reporter import parse_full_llm_name


AGENT_ENGINE_ROOT = Path(__file__).resolve().parents[1]
GATEWAY_PATH = AGENT_ENGINE_ROOT / "openrouter_gateway.py"


def load_gateway():
    assert GATEWAY_PATH.exists(), "agent-engine must expose one OpenRouter gateway module"
    spec = importlib.util.spec_from_file_location("openrouter_gateway_contract", GATEWAY_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_legacy_provider_models_resolve_to_live_openrouter_ids():
    gateway = load_gateway()

    assert gateway.resolve_openrouter_model("azure->openai->gpt-4.1") == "openai/gpt-4.1"
    assert gateway.resolve_openrouter_model(
        "aws->anthropic->anthropic.claude-3-5-sonnet-20241022-v2:0"
    ) == "anthropic/claude-sonnet-4.6"
    assert gateway.resolve_openrouter_model("google->google->gemini-3.5-flash") == "google/gemini-3.5-flash"


def test_gateway_client_delegates_fallback_and_compression_to_openrouter(monkeypatch):
    gateway = load_gateway()
    captured = {}

    class FakeChatOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(gateway, "ChatOpenAI", FakeChatOpenAI)
    monkeypatch.setattr(gateway.secrets_manager, "get_openrouter_api_key", lambda: "or-test-key")
    monkeypatch.setenv("OPENAI_API_KEY", "direct-openai-key")

    gateway.create_openrouter_llm("openai/gpt-4.1")

    assert captured["base_url"] == "https://openrouter.ai/api/v1"
    assert captured["model"] == "openai/gpt-4.1"
    assert captured["api_key"].get_secret_value() == "or-test-key"
    assert captured["max_retries"] == 1
    assert captured["temperature"] == 0.0
    assert os.environ["OPENAI_API_KEY"] == "direct-openai-key"
    # ENG-1820: require_parameters=True no longer applies -- it made OpenRouter hard-reject
    # every request carrying parallel_tool_calls (auto-added by browser-use's real
    # with_structured_output(method="function_calling") call), since that parameter isn't
    # declared as supported by essentially any model in OpenRouter's catalog. Broke the first
    # real action of every task, on every model. tool_choice alone still guarantees
    # single-tool-call behavior for this usage pattern.
    assert captured["extra_body"] == {
        "provider": {"allow_fallbacks": True},
        "plugins": [{"id": "context-compression"}],
    }


def test_gateway_sets_an_explicit_bounded_request_timeout(monkeypatch):
    # ENG-1822: langchain_openai.ChatOpenAI's `request_timeout` field defaults
    # to None, and that None gets forwarded verbatim to openai.OpenAI(timeout=...)
    # -- which, because it's an *explicit* None rather than an omitted kwarg,
    # skips the openai SDK's own 600s DEFAULT_TIMEOUT fallback and lands on
    # httpx.Client(timeout=None), i.e. no timeout at all. Confirmed live in
    # production: a single browser-use per-step LLM call took ~7m45s to
    # return (and was still unbounded -- it could have hung indefinitely).
    # Guard that the gateway always passes a concrete, finite timeout.
    gateway = load_gateway()
    captured = {}

    class FakeChatOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(gateway, "ChatOpenAI", FakeChatOpenAI)
    monkeypatch.setattr(gateway.secrets_manager, "get_openrouter_api_key", lambda: "or-test-key")

    gateway.create_openrouter_llm("openai/gpt-4.1")

    assert "timeout" in captured
    assert captured["timeout"] is not None
    assert 0 < captured["timeout"] <= 300, (
        "request timeout should be short enough to fail fast on a "
        "slow/degraded provider (browser-use's per-step call is a single "
        "forced tool-call with a small bounded output, not a long "
        "streaming generation)"
    )


def test_gateway_client_has_no_unbounded_timeout(monkeypatch):
    # Same regression as above, but end-to-end through the real ChatOpenAI/
    # openai/httpx construction path (no mocking of ChatOpenAI) -- this is
    # the same three-library interaction that silently produced an unbounded
    # timeout in production, so assert directly against the constructed
    # client's actual underlying httpx timeout rather than just the kwarg
    # we passed in, in case a future langchain_openai/openai upgrade changes
    # how `timeout` is threaded through.
    gateway = load_gateway()
    monkeypatch.setattr(gateway.secrets_manager, "get_openrouter_api_key", lambda: "or-test-key")

    llm = gateway.create_openrouter_llm("openai/gpt-4.1")
    underlying_timeout = llm.client._client.timeout

    assert underlying_timeout is not None
    assert underlying_timeout == gateway.REQUEST_TIMEOUT_SECONDS


def test_reasoning_routes_omit_temperature(monkeypatch):
    gateway = load_gateway()
    captured = {}
    monkeypatch.setattr(gateway, "ChatOpenAI", lambda **kwargs: captured.update(kwargs))
    monkeypatch.setattr(gateway.secrets_manager, "get_openrouter_api_key", lambda: "or-test-key")

    gateway.create_openrouter_llm("openai/o3-mini")

    assert "temperature" not in captured


def test_browser_construction_has_no_process_global_credential_shim():
    gateway = load_gateway()
    web_agent_source = (AGENT_ENGINE_ROOT / "web_agent.py").read_text()

    assert not hasattr(gateway, "openrouter_browser_compatibility_env")
    assert "openrouter_browser_compatibility_env" not in web_agent_source


def test_openrouter_browser_model_uses_raw_tools_for_no_tool_slugs():
    gateway = load_gateway()

    assert gateway.browser_tool_calling_method("deepseek/deepseek-r1") == "raw"
    assert gateway.browser_tool_calling_method("deepseek/deepseek-reasoner") == "raw"
    assert gateway.browser_tool_calling_method("openai/gpt-4.1") == "auto"


def test_openrouter_key_uses_the_existing_environment_aware_secret_seam():
    source = (AGENT_ENGINE_ROOT / "secrets_manager.py").read_text()

    assert "def get_openrouter_api_key()" in source
    assert "_env_or_string_secret('OPENROUTER_API_KEY', 'openrouter')" in source


def test_legacy_execution_name_is_attributed_to_the_openrouter_transport():
    # The persisted task label remains unchanged; the usage provider reflects
    # the gateway that actually served and billed the request.
    assert parse_full_llm_name("azure->openai->gpt-4.1") == ("openrouter", "gpt-4.1")
