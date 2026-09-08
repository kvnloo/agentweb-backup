"""Single text/tool model transport for agent-engine.

Persisted task model names keep their legacy ``platform->provider->model`` shape
for attribution and backwards compatibility. Only this module translates them
to OpenRouter upstream IDs and constructs a client.
"""

from langchain_openai import ChatOpenAI
from pydantic import SecretStr

import secrets_manager


OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
_BROWSER_RAW_TOOL_MODELS = {"deepseek-r1", "deepseek-reasoner"}

# ENG-1822: langchain_openai.ChatOpenAI's `request_timeout` field defaults to
# None and gets forwarded to `openai.OpenAI(timeout=...)` as an *explicit*
# None, not omitted. openai's own SDK only substitutes its 600s DEFAULT_TIMEOUT
# when the `timeout` kwarg is genuinely unset (its own `NotGiven` sentinel,
# see openai/_utils/_utils.py's `is_given`); an explicit None is passed
# straight through to httpx.Client(timeout=None), which httpx's own docs
# define as "No timeouts." -- confirmed empirically against the exact
# package versions running in production (langchain-openai==0.3.11,
# openai==1.109.1, httpx==0.28.1): the constructed client's underlying httpx
# timeout was literally `None` with no `timeout` kwarg passed here, i.e. this
# gateway has never had ANY effective request timeout, bounded only by
# task_monitor.py's 900s/1800s process-level kill switch. Live-verified in
# production (execution 1788877994807): a single browser-use per-step
# get_next_action() call took ~7m45s before returning a malformed response
# after ENG-1820 removed require_parameters. browser-use's per-step call is
# `with_structured_output(..., method="function_calling")`, a single
# tool_choice-forced call with a small bounded JSON output (not a long
# streaming generation), so a short bound is correct for it; the other two
# call sites through this same gateway (task_utils.check_new_information's
# short comparison, and task_monitor's end-of-task knowledge-base-summary
# regeneration) are both non-interactive, backgrounded, and already wrapped
# in broad try/except that degrades gracefully on failure -- so one shared,
# generous-but-bounded timeout is safe for all current callers without
# needing per-call-site plumbing.
REQUEST_TIMEOUT_SECONDS = 120

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
        # ENG-1820: require_parameters=True made OpenRouter hard-reject any request
        # carrying a parameter the target model doesn't explicitly declare as
        # supported. browser-use's real per-step call
        # (with_structured_output(method="function_calling")) always adds
        # parallel_tool_calls=false, and OpenRouter's own /models/{id}/endpoints
        # metadata doesn't list parallel_tool_calls as supported for essentially
        # any model in the catalog (confirmed directly for gpt-4.1, gpt-5,
        # gpt-5.1, gpt-5.4, gpt-5.6-terra, gpt-5.6-luna) -- so with this flag on,
        # the first real action of every task, on every model, got 0 matching
        # providers and a 404. tool_choice (forcing one specific function by
        # name) is what actually guarantees single-tool-call behavior here and
        # stays enforced regardless; parallel_tool_calls was redundant for this
        # usage pattern, not the real safety mechanism.
        #
        # ENG-1822: don't re-add require_parameters here. Confirmed against
        # OpenRouter's own docs that it's genuinely all-or-nothing across
        # *every* parameter in the request -- there's no way to require
        # tool_choice/tools support while excluding parallel_tool_calls, so
        # turning it back on would just resurrect the ENG-1820 404. OpenRouter
        # already applies a documented soft preference for providers that
        # support `tools`/`response_format` even with require_parameters=false,
        # so routing isn't fully unconstrained today. REQUEST_TIMEOUT_SECONDS
        # above is the actual fix for the slow/degraded-provider hang this
        # ticket investigates; scoping provider selection further (e.g.
        # `provider.order`/`provider.only` allow-listing known-good providers
        # per model family) is a plausible follow-up but needs live-traffic
        # validation this investigation couldn't do (no OPENROUTER_API_KEY
        # access), so it's deliberately left out of this change.
        "provider": {"allow_fallbacks": True},
        "plugins": [{"id": "context-compression"}],
    }
    kwargs = {
        "base_url": OPENROUTER_BASE_URL,
        "model": model,
        "api_key": SecretStr(api_key),
        # One SDK retry covers transient network/gateway failures. Agent Engine
        # has no provider-specific transport retry loop.
        "max_retries": 1,
        # ENG-1822: see REQUEST_TIMEOUT_SECONDS above -- without this, the
        # client has no request timeout at all (not even the openai SDK's own
        # 600s default), so a slow/degraded provider can block indefinitely.
        "timeout": REQUEST_TIMEOUT_SECONDS,
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


def browser_tool_calling_method(model: str) -> str:
    """Match browser-use's no-tool list after OpenRouter adds a namespace."""
    model_slug = (model or "").rsplit("/", 1)[-1].lower()
    return "raw" if model_slug in _BROWSER_RAW_TOOL_MODELS else "auto"


def get_openrouter_llm(full_llm_name: str):
    return create_openrouter_llm(resolve_openrouter_model(full_llm_name))
