"""Single text/tool model transport for agent-engine.

Persisted task model names keep their legacy ``platform->provider->model`` shape
for attribution and backwards compatibility. Only this module translates them
to OpenRouter upstream IDs and constructs a client.
"""

import asyncio
import queue
import threading

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
# task_monitor.py's process-level kill switch (TASK_EXECUTION_TIMEOUT_SECONDS,
# default 900s for regular tasks; COMPLEX_TASK_EXECUTION_TIMEOUT_SECONDS,
# 5400s in production via the systemd unit's real Environment= override, not
# the code's own 1800s fallback default). Live-verified in production
# (execution 1788877994807): a single browser-use per-step get_next_action()
# call took ~7m45s before returning a malformed response after ENG-1820
# removed require_parameters. browser-use's per-step call is
# `with_structured_output(..., method="function_calling")`, a single
# tool_choice-forced call with a small bounded JSON output (not a long
# streaming generation), so a short bound is correct for it; the other two
# call sites through this same gateway (task_utils.check_new_information's
# short comparison, and task_monitor's end-of-task knowledge-base-summary
# regeneration) are both non-interactive, backgrounded, and already wrapped
# in broad try/except that degrades gracefully on failure -- so one shared,
# generous-but-bounded timeout is safe for all current callers without
# needing per-call-site plumbing.
#
# Real worst-case latency before a step's failure surfaces is higher than
# this constant alone suggests: openai's own SDK retries once on a timeout
# (max_retries=1 below), so one stalled provider costs up to ~2x this value
# before browser-use even sees the failure, and browser-use's own
# max_failures=5 breaker (agent_kwargs in web_agent.py) means a
# persistently-bad provider could still burn up to ~5x that (~1200s at the
# current 120s) before browser-use gives up on the step -- which can exceed
# the 900s regular-task kill switch above for a persistently-hanging
# provider, in which case that outer timeout fires first rather than a
# cleaner browser-use-level failure. Still strictly bounded either way,
# unlike the pre-fix indefinite hang, but worth knowing the effective ceiling
# is a multiple of REQUEST_TIMEOUT_SECONDS, not the value itself.
#
# ENG-1822 FOLLOW-UP -- this constant alone does NOT bound real wall-clock
# call duration, despite everything above and despite being verified live on
# a real constructed client (`llm.client._client.timeout == 120.0`). Root
# cause, verified directly against the exact pinned versions running in
# production (httpx==0.28.1, httpcore==1.0.9): httpx's `timeout=<float>`
# expands to Timeout(connect=T, read=T, write=T, pool=T) (httpx/_config.py),
# and httpcore's `read` timeout is NOT a deadline on total response time --
# it's a budget on each individual low-level socket read, reset every time
# ANY bytes arrive. Confirmed at the actual enforcement point: both
# httpcore/_backends/sync.py (`self._sock.settimeout(timeout)` called fresh
# before every single `sock.recv()`) and .../_backends/anyio.py (`with
# anyio.fail_after(timeout): return await self._stream.receive(...)`, same
# per-call reset) rearm the same `timeout` value before *every* chunk read
# in HTTP11Connection._receive_event's loop (httpcore/_sync|_async/http11.py).
# So a provider that trickles the response slowly enough -- periodic
# anti-idle bytes, partial headers, whatever -- never lets any single read()
# call exceed `timeout`, and the overall call can run arbitrarily long even
# though `timeout` is genuinely, correctly wired. Re-verified this is real
# and not just a theoretical httpx quirk: after this fix's predecessor
# (REQUEST_TIMEOUT_SECONDS itself) shipped and was deployed, a live
# production re-test (2026-09-08, execution 1788881552500) still ran
# ~15:32:33 to ~15:40:40 wall clock (~7m -- confirmed via journalctl on the
# VM: the log-sync heartbeat that ticks every 30s regardless shows the
# browser_use log file's content hash genuinely did not change from
# 15:33:03 to 15:40:03, i.e. the subprocess was alive but made zero progress
# for ~7 continuous minutes), with the identical failure signature as the
# original pre-fix incident (empty response body, `Expecting value: line 1
# column 1 (char 0)`, browser-use's own retry then getting a fast but
# structurally-garbled response). Same class of evidence as the original
# incident's py-spy dump (blocked in asyncio's select(), live ESTAB
# connection, zero CPU) -- this is a real in-process network stall, not a
# task-scheduling artifact (checked and ruled out: task_monitor.py's own
# "Running command:" log line shows the subprocess was launched within ~1s
# of task creation, not picked up late).
#
# Ruled out as alternative explanations: (1) a write-timeout gap -- the
# outbound payload is a small JSON POST, and a write timeout would raise
# before any response is seen, which contradicts the observed "got an empty
# but complete response after minutes" symptom; (2) openai SDK retry
# swallowing/miscounting the timeout -- read openai/_base_client.py directly:
# `except httpx.TimeoutException` is the correct catch (covers httpx's
# ReadTimeout/WriteTimeout/ConnectTimeout/PoolTimeout), and since httpcore
# never actually raises that exception here (reads keep "succeeding" on
# trickled bytes), the SDK's retry path is never even entered -- there's
# only one physical HTTP attempt per call, which is consistent with the
# hang being one continuous read wait rather than stacked retries; (3) a
# hidden langchain-level retry wrapper -- grepped langchain_openai and
# langchain_core's BaseChatModel for automatic retry decorators around
# invoke/ainvoke; `with_retry()` exists but is opt-in and unused here; (4)
# stale pooled connection -- not applicable to the incidents analyzed, both
# were a task's first LLM call on a freshly-constructed client/connection.
#
# The fix: HARD_DEADLINE_SECONDS + the invoke/ainvoke wrapping below enforce
# a genuine wall-clock ceiling that doesn't care what the socket is doing,
# instead of trusting httpx/httpcore's per-read timeout to ever fire.
REQUEST_TIMEOUT_SECONDS = 120

# Intentionally 2x REQUEST_TIMEOUT_SECONDS (+ a small buffer): this module's
# own comment above already documents "~2x this value" as the *intended*
# worst case for one call, covering the openai SDK's own max_retries=1
# retry-on-timeout (verified against openai/_constants.py's
# INITIAL_RETRY_DELAY=0.5s/MAX_RETRY_DELAY=8.0s: with max_retries=1 the
# inter-retry sleep is ~0.4-0.5s, negligible next to REQUEST_TIMEOUT_SECONDS).
# This deadline just makes that documented envelope a real, enforced ceiling
# instead of an aspiration httpx's own timeout semantics don't actually
# deliver -- it doesn't change the SDK's retry behavior or timing budget,
# it only backstops it. The +15s covers JSON parsing/langchain overhead
# around the two attempts, not another retry.
HARD_DEADLINE_SECONDS = REQUEST_TIMEOUT_SECONDS * 2 + 15

_HARD_DEADLINE_MESSAGE = (
    "OpenRouter call exceeded the {deadline}s hard wall-clock deadline "
    "(httpx/httpcore's own `timeout` does not bound total call duration when "
    "a provider trickles response bytes -- see the ENG-1822 follow-up "
    "comment on REQUEST_TIMEOUT_SECONDS in this module for why)"
)


def _enforce_hard_deadline(base_cls):
    """Return a subclass of base_cls whose invoke/ainvoke enforce a real
    wall-clock ceiling (HARD_DEADLINE_SECONDS), instead of relying on
    httpx/httpcore's own per-read `timeout` -- proven insufficient in
    production; see REQUEST_TIMEOUT_SECONDS's comment above.

    Built dynamically off whatever `base_cls` is passed in (rather than a
    plain module-level `class _X(ChatOpenAI):`) so it keeps working if
    ChatOpenAI is substituted, e.g. by this module's own test suite
    monkeypatching a fake constructor -- and calls `base_cls.ainvoke(self,
    ...)`/`base_cls.invoke(self, ...)` directly rather than bare `super()`,
    since the zero-argument `super()` shorthand only works for methods
    defined lexically inside a `class` statement, not ones assigned into a
    dynamically-built class's namespace via `type(...)`.
    """

    async def _hard_deadline_ainvoke(self, *args, **kwargs):
        try:
            return await asyncio.wait_for(
                base_cls.ainvoke(self, *args, **kwargs), timeout=HARD_DEADLINE_SECONDS
            )
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                _HARD_DEADLINE_MESSAGE.format(deadline=HARD_DEADLINE_SECONDS)
            ) from exc

    def _hard_deadline_invoke(self, *args, **kwargs):
        # Plain sync code can't be preempted mid-blocking-read the way an
        # `await` can be cancelled, so this runs the real call on a *daemon*
        # thread and bounds how long the *caller* waits for it via
        # Queue.get(timeout=...) -- daemon specifically so an abandoned
        # thread (still stuck in the real call after we've already given up
        # on it) can't block the interpreter's normal shutdown sequence the
        # way a plain concurrent.futures.ThreadPoolExecutor worker would
        # (those are non-daemon by default and get joined at exit). The
        # thread itself is still bounded by the client's own `timeout`, so
        # it can't leak forever -- this is the standard pattern for
        # imposing a hard deadline on non-cooperative sync code.
        result: queue.Queue = queue.Queue(maxsize=1)

        def _run():
            try:
                result.put(("ok", base_cls.invoke(self, *args, **kwargs)))
            except BaseException as exc:  # noqa: BLE001 -- forward to the caller's thread
                result.put(("error", exc))

        threading.Thread(target=_run, daemon=True, name="openrouter-sync-invoke").start()
        try:
            status, payload = result.get(timeout=HARD_DEADLINE_SECONDS)
        except queue.Empty:
            raise TimeoutError(
                _HARD_DEADLINE_MESSAGE.format(deadline=HARD_DEADLINE_SECONDS)
            ) from None
        if status == "error":
            raise payload
        return payload

    return type(
        f"HardDeadline{base_cls.__name__}",
        (base_cls,),
        {"ainvoke": _hard_deadline_ainvoke, "invoke": _hard_deadline_invoke},
    )


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

    # ENG-1822 follow-up: wrap in a hard wall-clock deadline (see
    # HARD_DEADLINE_SECONDS above) rather than trusting httpx/httpcore's own
    # `timeout` to bound total call duration -- it doesn't, for a slow-
    # trickling response. Guarded on ChatOpenAI actually being a class so
    # this module's tests can still monkeypatch it with a bare fake
    # constructor/lambda and get the unwrapped return value back untouched.
    llm_cls = ChatOpenAI
    if isinstance(llm_cls, type):
        llm_cls = _enforce_hard_deadline(llm_cls)
    return llm_cls(**kwargs)


def browser_tool_calling_method(model: str) -> str:
    """Match browser-use's no-tool list after OpenRouter adds a namespace."""
    model_slug = (model or "").rsplit("/", 1)[-1].lower()
    return "raw" if model_slug in _BROWSER_RAW_TOOL_MODELS else "auto"


def get_openrouter_llm(full_llm_name: str):
    return create_openrouter_llm(resolve_openrouter_model(full_llm_name))
