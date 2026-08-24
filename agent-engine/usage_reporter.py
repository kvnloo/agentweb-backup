"""
usage_reporter — shadow usage metering for the agent-engine (Ship 1).

Collects per-LLM-call token usage from LangChain chat-model responses via a
callback handler, aggregates it in-process per (provider, model), and POSTs one
batch to the backend's POST /api/internal/usage endpoint when the task ends.

Auth: the same short-lived JWT the engine already uses for its other backend
calls (task_utils.create_jwt_token, signed with the shared JWT_SECRET), sent as
an Authorization: Bearer header.

FAIL-OPEN by design: metering must NEVER fail, slow, or alter a task. Every
public entry point swallows all exceptions and at most logs a warning.
"""

import logging
import math
import os
import threading
import uuid

logger = logging.getLogger(__name__)

try:
    # LangChain is always present in the engine env; the fallback keeps this
    # module importable (and unit-testable) without it.
    from langchain_core.callbacks import BaseCallbackHandler
except Exception:  # pragma: no cover - exercised only when langchain is absent
    BaseCallbackHandler = object


def parse_full_llm_name(full_llm_name):
    """Split a persisted route into its billing transport and model.

    Agent-engine persists the legacy ``platform->provider->model`` selector for
    backwards compatibility, but every valid text/tool route is served through
    OpenRouter. Falls back to ('unknown', <raw name>) for malformed input.
    """
    try:
        parts = (full_llm_name or "").split("->")
        if len(parts) == 3 and all(part.strip() for part in parts):
            return "openrouter", parts[2].strip()
    except Exception:
        pass
    return "unknown", (full_llm_name or "unknown")


def _coerce_count(value):
    """Best-effort non-negative int from whatever the SDK handed us."""
    try:
        n = int(value)
        return n if n >= 0 else 0
    except (TypeError, ValueError):
        return 0


def _non_negative_float(value):
    """Return a finite non-negative float, otherwise None."""
    try:
        number = float(value)
        return number if math.isfinite(number) and number >= 0 else None
    except (TypeError, ValueError):
        return None


def _dict_or_empty(value):
    """Treat malformed SDK metadata as absent instead of dropping all usage."""
    return value if isinstance(value, dict) else {}


def _openrouter_attribution(message, llm_output):
    """Extract the model actually served and OpenRouter's exact call cost."""
    metadata = _dict_or_empty(getattr(message, "response_metadata", None))
    llm_output = _dict_or_empty(llm_output)
    token_usage = _dict_or_empty(metadata.get("token_usage") or llm_output.get("token_usage"))
    model = metadata.get("model_name") or metadata.get("model") or llm_output.get("model_name")
    model = model.strip() if isinstance(model, str) and model.strip() else None

    is_byok = token_usage.get("is_byok", metadata.get("is_byok"))
    cost_details = _dict_or_empty(token_usage.get("cost_details") or metadata.get("cost_details"))
    if is_byok is True:
        cost = _non_negative_float(cost_details.get("upstream_inference_cost"))
    else:
        cost = _non_negative_float(token_usage.get("cost"))

    attribution = {}
    if model:
        attribution["model"] = model
    if cost is not None:
        attribution["cost_usd_override"] = cost
    return attribution


def extract_usage_from_llm_result(response):
    """Pull token usage out of a LangChain LLMResult, across providers.

    Checked in order:
      1. AIMessage.usage_metadata (LangChain-standardized: input_tokens /
         output_tokens, input_token_details.cache_read) — Azure OpenAI,
         Gemini, Bedrock Anthropic all populate this on modern langchain.
      2. llm_output['token_usage'] (OpenAI-style prompt/completion_tokens).
      3. llm_output['usage'] (Anthropic-style input/output_tokens with
         cache_read_input_tokens / cache_creation_input_tokens).

    Returns a dict {input_tokens, output_tokens, cache_read_tokens,
    cache_write_tokens} or None when no usage is exposed. Never raises.
    """
    try:
        # 1. Per-generation message usage_metadata
        generation_groups = getattr(response, "generations", None)
        for generations in generation_groups if isinstance(generation_groups, (list, tuple)) else []:
            for generation in generations if isinstance(generations, (list, tuple)) else []:
                message = getattr(generation, "message", None)
                meta = _dict_or_empty(getattr(message, "usage_metadata", None))
                if meta:
                    details = _dict_or_empty(meta.get("input_token_details"))
                    usage = {
                        "input_tokens": _coerce_count(meta.get("input_tokens")),
                        "output_tokens": _coerce_count(meta.get("output_tokens")),
                        "cache_read_tokens": _coerce_count(details.get("cache_read")),
                        "cache_write_tokens": _coerce_count(details.get("cache_creation")),
                    }
                    usage.update(_openrouter_attribution(message, getattr(response, "llm_output", None)))
                    return usage

        llm_output = _dict_or_empty(getattr(response, "llm_output", None))

        # 2. OpenAI-style token_usage
        token_usage = _dict_or_empty(llm_output.get("token_usage"))
        if token_usage:
            usage = {
                "input_tokens": _coerce_count(token_usage.get("prompt_tokens")),
                "output_tokens": _coerce_count(token_usage.get("completion_tokens")),
                "cache_read_tokens": _coerce_count(
                    _dict_or_empty(token_usage.get("prompt_tokens_details")).get("cached_tokens")
                ),
                "cache_write_tokens": 0,
            }
            usage.update(_openrouter_attribution(None, llm_output))
            return usage

        # 3. Anthropic-style usage
        usage = _dict_or_empty(llm_output.get("usage"))
        if usage:
            return {
                "input_tokens": _coerce_count(usage.get("input_tokens")),
                "output_tokens": _coerce_count(usage.get("output_tokens")),
                "cache_read_tokens": _coerce_count(usage.get("cache_read_input_tokens")),
                "cache_write_tokens": _coerce_count(usage.get("cache_creation_input_tokens")),
            }
    except Exception as e:
        logger.debug(f"usage_reporter: could not extract usage from response: {e}")
    return None


class UsageReporter:
    """Buffers token usage for one task run and flushes it at task end."""

    def __init__(self, full_llm_name, feature="agent_task", token_factory=None):
        self.provider, self.model = parse_full_llm_name(full_llm_name)
        self.feature = feature
        self._token_factory = token_factory  # injectable for tests
        self._lock = threading.Lock()
        # (provider, model) -> aggregated counters
        self._totals = {}
        # ENG-1251: one reporter is constructed per WebAgent (one per task-
        # execution process — see web_agent.py), and flush() runs exactly
        # once, in a finally block. This id lets the backend tell "this exact
        # HTTP submission retried" (same instance, same buffered totals, same
        # id — dedupe it) apart from "a genuinely new execution" (a new
        # WebAgent/UsageReporter instance always gets a new id — charge it in
        # full, even if the measurements happen to be identical).
        self.report_id = uuid.uuid4().hex

    def add(self, usage, model=None, provider=None):
        """Aggregate one LLM call's usage. Never raises."""
        try:
            if not usage:
                return
            key = (provider or self.provider, model or self.model)
            with self._lock:
                bucket = self._totals.setdefault(
                    key,
                    {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                        "calls": 0,
                        "cost_usd_override": 0.0,
                        "cost_override_complete": True,
                    },
                )
                bucket["input_tokens"] += _coerce_count(usage.get("input_tokens"))
                bucket["output_tokens"] += _coerce_count(usage.get("output_tokens"))
                bucket["cache_read_tokens"] += _coerce_count(usage.get("cache_read_tokens"))
                bucket["cache_write_tokens"] += _coerce_count(usage.get("cache_write_tokens"))
                cost_override = _non_negative_float(usage.get("cost_usd_override"))
                if cost_override is None:
                    bucket["cost_override_complete"] = False
                else:
                    bucket["cost_usd_override"] += cost_override
                bucket["calls"] += 1
        except Exception as e:
            logger.debug(f"usage_reporter: add failed: {e}")

    def build_records(self, user_id, task_id=None):
        """Materialize the buffered totals as API-shaped records."""
        records = []
        with self._lock:
            for (provider, model), totals in self._totals.items():
                if totals["input_tokens"] == 0 and totals["output_tokens"] == 0:
                    continue
                record = {
                    "userId": user_id,
                    "taskId": task_id,
                    "model": model,
                    "provider": provider,
                    "feature": self.feature,
                    "inputTokens": totals["input_tokens"],
                    "outputTokens": totals["output_tokens"],
                    "cacheReadTokens": totals["cache_read_tokens"],
                    "cacheWriteTokens": totals["cache_write_tokens"],
                }
                if totals["cost_override_complete"]:
                    record["costUsdOverride"] = totals["cost_usd_override"]
                records.append(record)
        return records

    def _create_token(self, user_id):
        if self._token_factory:
            return self._token_factory(user_id)
        # Same JWT mechanism the engine uses for all its other backend calls.
        from task_utils import create_jwt_token

        return create_jwt_token(user_id)

    def flush(self, user_id, task_id=None, timeout=10):
        """POST the buffered usage batch to the backend. Never raises.

        Returns True when the batch was accepted, False otherwise (including
        "nothing to send"). On failure the buffer is kept (a later retry could
        resend), but callers are not required to retry — this is shadow data.
        """
        try:
            records = self.build_records(user_id, task_id)
            if not records:
                return False

            token = self._create_token(user_id)
            if not token:
                logger.warning("usage_reporter: no JWT available, dropping usage batch")
                return False

            backend_url = os.getenv("BACKEND_URL", "http://localhost:3001")
            import requests

            response = requests.post(
                f"{backend_url}/api/internal/usage",
                json={"records": records, "reportId": self.report_id},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                timeout=timeout,
            )
            if response.status_code >= 300:
                logger.warning(
                    f"usage_reporter: backend rejected usage batch "
                    f"({response.status_code}): {response.text[:200]}"
                )
                return False

            with self._lock:
                self._totals.clear()
            logger.info(
                f"usage_reporter: reported {len(records)} usage record(s) for task {task_id}"
            )
            return True
        except Exception as e:
            # Metering is shadow-only — the task result is never affected.
            logger.warning(f"usage_reporter: flush failed (task unaffected): {e}")
            return False


class UsageCallbackHandler(BaseCallbackHandler):
    """LangChain callback that feeds every LLM response into a UsageReporter."""

    raise_error = False

    def __init__(self, reporter):
        self._reporter = reporter

    def on_llm_end(self, response, **kwargs):
        try:
            usage = extract_usage_from_llm_result(response)
            if usage:
                self._reporter.add(
                    usage,
                    model=usage.get("model"),
                    provider="openrouter",
                )
        except Exception as e:
            logger.debug(f"usage_reporter: on_llm_end failed: {e}")


def attach_usage_callback(llm, reporter):
    """Attach a usage callback to a LangChain chat model. Never raises.

    Returns True when attached, False when the model doesn't support callbacks
    (metering is simply skipped in that case).
    """
    try:
        handler = UsageCallbackHandler(reporter)
        existing = getattr(llm, "callbacks", None)
        if existing is None:
            llm.callbacks = [handler]
        elif isinstance(existing, list):
            llm.callbacks = existing + [handler]
        else:
            # BaseCallbackManager-style object
            existing.add_handler(handler, inherit=True)
        return True
    except Exception as e:
        logger.warning(f"usage_reporter: could not attach usage callback: {e}")
        return False
