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
import os
import threading

logger = logging.getLogger(__name__)

try:
    # LangChain is always present in the engine env; the fallback keeps this
    # module importable (and unit-testable) without it.
    from langchain_core.callbacks import BaseCallbackHandler
except Exception:  # pragma: no cover - exercised only when langchain is absent
    BaseCallbackHandler = object


def parse_full_llm_name(full_llm_name):
    """Split 'platform->provider->model' into (provider, model).

    Falls back to ('unknown', <raw name>) for anything malformed.
    """
    try:
        parts = (full_llm_name or "").split("->")
        if len(parts) == 3 and parts[1].strip() and parts[2].strip():
            return parts[1].strip().lower(), parts[2].strip()
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
        for generations in getattr(response, "generations", None) or []:
            for generation in generations or []:
                message = getattr(generation, "message", None)
                meta = getattr(message, "usage_metadata", None)
                if meta:
                    details = meta.get("input_token_details") or {}
                    return {
                        "input_tokens": _coerce_count(meta.get("input_tokens")),
                        "output_tokens": _coerce_count(meta.get("output_tokens")),
                        "cache_read_tokens": _coerce_count(details.get("cache_read")),
                        "cache_write_tokens": _coerce_count(details.get("cache_creation")),
                    }

        llm_output = getattr(response, "llm_output", None) or {}

        # 2. OpenAI-style token_usage
        token_usage = llm_output.get("token_usage") or {}
        if token_usage:
            return {
                "input_tokens": _coerce_count(token_usage.get("prompt_tokens")),
                "output_tokens": _coerce_count(token_usage.get("completion_tokens")),
                "cache_read_tokens": _coerce_count(
                    (token_usage.get("prompt_tokens_details") or {}).get("cached_tokens")
                ),
                "cache_write_tokens": 0,
            }

        # 3. Anthropic-style usage
        usage = llm_output.get("usage") or {}
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
                    },
                )
                bucket["input_tokens"] += _coerce_count(usage.get("input_tokens"))
                bucket["output_tokens"] += _coerce_count(usage.get("output_tokens"))
                bucket["cache_read_tokens"] += _coerce_count(usage.get("cache_read_tokens"))
                bucket["cache_write_tokens"] += _coerce_count(usage.get("cache_write_tokens"))
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
                records.append(
                    {
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
                )
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
                json={"records": records},
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
                self._reporter.add(usage)
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
