"""ENG-1450 contract for the agent-engine OpenRouter cutover."""

import importlib.util
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

    gateway.create_openrouter_llm("openai/gpt-4.1")

    assert captured["base_url"] == "https://openrouter.ai/api/v1"
    assert captured["model"] == "openai/gpt-4.1"
    assert captured["max_retries"] == 0
    assert captured["extra_body"] == {
        "provider": {"allow_fallbacks": True, "require_parameters": True},
        "plugins": [{"id": "context-compression"}],
    }


def test_openrouter_key_uses_the_existing_environment_aware_secret_seam():
    source = (AGENT_ENGINE_ROOT / "secrets_manager.py").read_text()

    assert "def get_openrouter_api_key()" in source
    assert "_env_or_string_secret('OPENROUTER_API_KEY', 'openrouter')" in source


def test_legacy_execution_name_remains_available_for_usage_attribution():
    # Characterization: transport changes must not rewrite the persisted task label.
    assert parse_full_llm_name("azure->openai->gpt-4.1") == ("openai", "gpt-4.1")
