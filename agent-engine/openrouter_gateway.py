"""Single text/tool model transport for agent-engine.

Persisted task model names keep their legacy ``platform->provider->model`` shape
for attribution and backwards compatibility. Only this module translates them
to OpenRouter upstream IDs and constructs a client.
"""

import os
from contextlib import contextmanager

from langchain_openai import ChatOpenAI
from pydantic import SecretStr

import secrets_manager


OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
_BROWSER_RAW_TOOL_MODELS = {"deepseek-r1", "deepseek-reasoner"}

# Only aliases whose old upstream ID no longer exists on OpenRouter belong here.
LEGACY_MODEL_UPGRADES = {
    "anthropic.claude-3-5-sonnet-20241022-v2:0": "claude-sonnet-4.6",
    "us.anthropic.claude-3-7-sonnet-20250219-v1:0": "claude-sonnet-4.6",
    "anthropic.claude-sonnet-4-6": "claude-sonnet-4.6",
    "gemini-2.0-flash": "gemini-3.5-flash",
    "gemini-2.0-flash-exp": "gemini-3.5-flash",
    "gemini-2.5-pro-preview-03-25": "gemini-2.5-pro",
    "gemini-2.5-pro-preview-05-06": "gemini-2.5-pro",
    "o1-mini": "o3-mini",
    "gpt-5-chat": "gpt-5.6-terra",
    "deepseek-reasoner": "deepseek-r1",
    "DeepSeek-R1": "deepseek-r1",
}

PROVIDER_NAMESPACE = {
    ("aws", "anthropic"): "anthropic",
    ("azure", "openai"): "openai",
    ("openai", "openai"): "openai",
    ("google", "google"): "google",
    ("deepseek", "deepseek"): "deepseek",
    ("pld", "deepseek"): "deepseek",
}


def resolve_openrouter_model(full_llm_name: str) -> str:
    """Translate a persisted agent-engine model selector to an upstream ID."""
    parts = full_llm_name.split("->")
    if len(parts) != 3 or not all(parts):
        raise ValueError(f"Invalid FULL_LLM_NAME format: {full_llm_name}")

    platform, provider, model = parts
    platform = platform.lower()
    provider = provider.lower()
    if platform == "openrouter":
        namespace = provider
    else:
        namespace = PROVIDER_NAMESPACE.get((platform, provider))
    if not namespace:
        raise ValueError(f"Unsupported model route: {platform}->{provider}")

    upstream_model = LEGACY_MODEL_UPGRADES.get(model, model)
    if upstream_model.startswith(f"{namespace}/"):
        return upstream_model
    return f"{namespace}/{upstream_model}"


def create_openrouter_llm(model: str):
    """Create one gateway client; OpenRouter owns routing and provider fallback."""
    api_key = (secrets_manager.get_openrouter_api_key() or "").strip()
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY is not set")

    extra_body = {
        "provider": {"allow_fallbacks": True, "require_parameters": True},
        "plugins": [{"id": "context-compression"}],
    }
    # Agent-engine tasks can include browser screenshots, so its
    # gateway-managed overflow fallback must remain multimodal.
    if model != "google/gemini-3.5-flash":
        extra_body["models"] = ["google/gemini-3.5-flash"]

    kwargs = {
        "base_url": OPENROUTER_BASE_URL,
        "model": model,
        "api_key": SecretStr(api_key),
        # One SDK retry covers transient network/gateway failures. Agent Engine
        # has no provider-specific transport retry loop.
        "max_retries": 1,
        "default_headers": {
            "HTTP-Referer": "https://app.agentweb.pro",
            "X-Title": "AgentWeb Agent Engine",
        },
        "extra_body": extra_body,
    }
    # OpenAI reasoning families reject temperature. Other incumbent routes used
    # temperature=0 before the cutover, so retain it where the model accepts it.
    if not model.startswith(("openai/o", "openai/gpt-5")):
        kwargs["temperature"] = 0.0
    return ChatOpenAI(**kwargs)


@contextmanager
def openrouter_browser_compatibility_env():
    """Expose the gateway key only while browser-use validates its LLM."""
    api_key = (secrets_manager.get_openrouter_api_key() or "").strip()
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY is not set")

    previous = os.environ.get("OPENAI_API_KEY")
    os.environ["OPENAI_API_KEY"] = api_key
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("OPENAI_API_KEY", None)
        else:
            os.environ["OPENAI_API_KEY"] = previous


def browser_tool_calling_method(model: str) -> str:
    """Match browser-use's no-tool list after OpenRouter adds a namespace."""
    model_slug = (model or "").rsplit("/", 1)[-1].lower()
    return "raw" if model_slug in _BROWSER_RAW_TOOL_MODELS else "auto"


def get_openrouter_llm(full_llm_name: str):
    return create_openrouter_llm(resolve_openrouter_model(full_llm_name))
