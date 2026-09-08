"""ENG-1450 contract for the agent-engine OpenRouter cutover."""

import asyncio
import importlib.util
import os
import socket
import threading
import time
from pathlib import Path

import httpx
import pytest

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


# --- ENG-1822 follow-up: REQUEST_TIMEOUT_SECONDS alone does not bound real
# wall-clock call duration (httpx/httpcore's `read` timeout resets on every
# individual low-level socket read, so a provider that trickles response
# bytes slowly enough never lets any single read() exceed the configured
# timeout, and the overall call can run arbitrarily long). See the long
# comment on REQUEST_TIMEOUT_SECONDS in openrouter_gateway.py for the full
# root-cause writeup. The tests below cover, in order:
#   1. the wrapper's basic mechanics (fast pass-through, bounded on a hang)
#      against synthetic fakes, for fast/deterministic unit coverage;
#   2. the real underlying httpx/httpcore behavior this module's diagnosis
#      depends on, proven against a real local socket (not a mocked
#      transport) that trickles bytes -- independent confirmation that the
#      claimed root cause is real, not just a theory about the source code;
#   3. that the actual fix (_enforce_hard_deadline) bounds total duration
#      against that exact same trickling reproduction, which is the scenario
#      REQUEST_TIMEOUT_SECONDS alone was proven (live, in production) not to
#      bound.


def test_hard_deadline_invoke_passes_through_fast_sync_calls(monkeypatch):
    gateway = load_gateway()
    monkeypatch.setattr(gateway, "HARD_DEADLINE_SECONDS", 5)

    class _FastBase:
        def invoke(self, message, extra=None):
            return f"got:{message}:{extra}"

    wrapped = gateway._enforce_hard_deadline(_FastBase)()
    assert wrapped.invoke("hello", extra="world") == "got:hello:world"


@pytest.mark.asyncio
async def test_hard_deadline_ainvoke_passes_through_fast_async_calls(monkeypatch):
    gateway = load_gateway()
    monkeypatch.setattr(gateway, "HARD_DEADLINE_SECONDS", 5)

    class _FastBase:
        async def ainvoke(self, message, extra=None):
            return f"got:{message}:{extra}"

    wrapped = gateway._enforce_hard_deadline(_FastBase)()
    assert await wrapped.ainvoke("hello", extra="world") == "got:hello:world"


def test_hard_deadline_invoke_bounds_a_sync_call_that_never_returns(monkeypatch):
    gateway = load_gateway()
    monkeypatch.setattr(gateway, "HARD_DEADLINE_SECONDS", 0.2)

    class _HangingBase:
        def invoke(self, *args, **kwargs):
            time.sleep(5)
            return "should never get here"

    wrapped = gateway._enforce_hard_deadline(_HangingBase)()

    start = time.monotonic()
    with pytest.raises(TimeoutError):
        wrapped.invoke("hi")
    elapsed = time.monotonic() - start

    # Bounded near HARD_DEADLINE_SECONDS, nowhere near the full 5s hang --
    # this is the exact failure mode ENG-1822's REQUEST_TIMEOUT_SECONDS=120
    # alone did not actually protect against in production.
    assert elapsed < 1.0


@pytest.mark.asyncio
async def test_hard_deadline_ainvoke_bounds_an_async_call_that_never_returns(monkeypatch):
    gateway = load_gateway()
    monkeypatch.setattr(gateway, "HARD_DEADLINE_SECONDS", 0.2)

    class _HangingBase:
        async def ainvoke(self, *args, **kwargs):
            await asyncio.sleep(5)
            return "should never get here"

    wrapped = gateway._enforce_hard_deadline(_HangingBase)()

    start = time.monotonic()
    with pytest.raises(TimeoutError):
        await wrapped.ainvoke("hi")
    elapsed = time.monotonic() - start

    assert elapsed < 1.0


def test_hard_deadline_invoke_propagates_real_errors_not_just_timeouts(monkeypatch):
    # A non-timeout failure (e.g. a real 4xx/5xx from the provider) must
    # still surface as itself, not get swallowed or misreported as a
    # deadline exceeded.
    gateway = load_gateway()
    monkeypatch.setattr(gateway, "HARD_DEADLINE_SECONDS", 5)

    class _FailingBase:
        def invoke(self, *args, **kwargs):
            raise ValueError("real provider error, not a timeout")

    wrapped = gateway._enforce_hard_deadline(_FailingBase)()
    with pytest.raises(ValueError, match="real provider error"):
        wrapped.invoke("hi")


def test_hard_deadline_invoke_runs_on_a_daemon_thread(monkeypatch):
    # Must be a daemon thread: a call that's still stuck in the real
    # (slow/hung) sync invoke after we've already given up on it and raised
    # TimeoutError to the caller must not block the interpreter's normal
    # shutdown sequence waiting for that abandoned thread to finish.
    gateway = load_gateway()
    monkeypatch.setattr(gateway, "HARD_DEADLINE_SECONDS", 0.1)

    seen_daemon = {}
    release = threading.Event()

    class _SlowBase:
        def invoke(self, *args, **kwargs):
            seen_daemon["value"] = threading.current_thread().daemon
            release.wait(timeout=2)
            return "done"

    wrapped = gateway._enforce_hard_deadline(_SlowBase)()
    with pytest.raises(TimeoutError):
        wrapped.invoke("hi")

    # Give the background thread a moment to actually start and record itself.
    for _ in range(50):
        if "value" in seen_daemon:
            break
        time.sleep(0.02)
    release.set()  # let it finish so it doesn't linger past the test

    assert seen_daemon.get("value") is True


def test_create_openrouter_llm_preserves_isinstance_of_real_chatopenai(monkeypatch):
    # The wrapper must be a genuine ChatOpenAI subclass, not a look-alike
    # composition wrapper -- langchain/browser-use rely on isinstance/Runnable
    # protocol checks (e.g. with_structured_output's bind_tools -> pipe
    # composition) that only a real subclass satisfies transparently.
    gateway = load_gateway()
    monkeypatch.setattr(gateway.secrets_manager, "get_openrouter_api_key", lambda: "or-test-key")

    llm = gateway.create_openrouter_llm("openai/gpt-4.1")

    assert isinstance(llm, gateway.ChatOpenAI)
    assert type(llm).__bases__ == (gateway.ChatOpenAI,)
    assert callable(llm.invoke) and callable(llm.ainvoke)


def _start_trickle_server(*, num_chunks: int, chunk_interval: float):
    """Real local TCP server that sends a valid HTTP/1.1 response very
    slowly -- one tiny chunked-transfer-encoding chunk at a time -- and then
    closes the connection without ever sending the terminating 0-length
    chunk. This reproduces, at the real socket level, the "provider trickles
    bytes and never completes" scenario the ENG-1822 follow-up diagnosis
    describes (Cloudflare/OpenRouter anti-idle padding, or any slow
    generation that flushes partial bytes). Deliberately a real socket
    rather than httpx.MockTransport: MockTransport bypasses httpcore
    entirely, so it can't exercise the actual read()-resets-per-chunk code
    path this investigation read directly out of httpcore's source.

    Returns (url, server_socket); caller must close server_socket.
    """
    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_sock.bind(("127.0.0.1", 0))
    server_sock.listen(1)
    port = server_sock.getsockname()[1]

    def _serve():
        try:
            conn, _ = server_sock.accept()
        except OSError:
            return
        with conn:
            try:
                conn.settimeout(10)
                conn.recv(65536)
                conn.sendall(
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: application/json\r\n"
                    b"Transfer-Encoding: chunked\r\n"
                    b"Connection: close\r\n"
                    b"\r\n"
                )
                for _ in range(num_chunks):
                    time.sleep(chunk_interval)
                    conn.sendall(b"1\r\n \r\n")  # one-byte chunk -- keeps the
                    # connection "alive" (resets httpcore's per-read timeout)
                    # without ever finishing the response.
            except OSError:
                pass
            # Falling out of `with conn:` closes the socket without ever
            # sending the terminating "0\r\n\r\n" -- the response never
            # completes, exactly like the production incidents where the
            # first call returned a genuinely empty body after minutes.

    thread = threading.Thread(target=_serve, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{port}", server_sock


def test_httpx_read_timeout_does_not_bound_a_trickling_response():
    """Independent proof of this module's root-cause diagnosis: httpx's
    `timeout=<per-read window>` is NOT a deadline on total response
    duration. Each chunk here arrives comfortably inside the configured read
    window, so no single read() ever exceeds it -- yet the overall call
    still runs far longer than that window, because the window resets on
    every chunk. This is the real mechanism (proven against a real socket)
    behind ENG-1822's REQUEST_TIMEOUT_SECONDS=120 not actually bounding the
    ~8 minute production hang.
    """
    read_timeout = 0.3
    num_chunks, chunk_interval = 12, 0.1  # ~1.2s of genuine trickle
    url, server_sock = _start_trickle_server(num_chunks=num_chunks, chunk_interval=chunk_interval)
    try:
        client = httpx.Client(timeout=httpx.Timeout(5.0, read=read_timeout))
        start = time.monotonic()
        with pytest.raises(httpx.HTTPError):
            client.get(url)
        elapsed = time.monotonic() - start
    finally:
        server_sock.close()

    # If `read=0.3` bounded total duration, this would fail at ~0.3s. It
    # doesn't: the call runs for essentially the whole trickle duration,
    # proving the per-read window resets on every chunk instead of acting as
    # a deadline on the whole response.
    assert elapsed > num_chunks * chunk_interval * 0.75


@pytest.mark.asyncio
async def test_hard_deadline_bounds_a_real_trickling_socket_response(monkeypatch):
    """The actual fix, proven against the exact reproduction above: even
    though the trickling server defeats httpx's own read timeout (previous
    test), wrapping the call in _enforce_hard_deadline still cuts it off at
    the real wall-clock deadline -- because asyncio.wait_for's cancellation
    doesn't care what the socket is doing.
    """
    gateway = load_gateway()
    hard_deadline = 0.35
    monkeypatch.setattr(gateway, "HARD_DEADLINE_SECONDS", hard_deadline)

    # Trickle for much longer than hard_deadline, with each chunk still well
    # inside httpx's own (generous, production-like) read timeout -- so
    # httpx's own timeout would NOT save us here either; only the wrapper can.
    num_chunks, chunk_interval = 20, 0.1  # ~2s of trickle
    url, server_sock = _start_trickle_server(num_chunks=num_chunks, chunk_interval=chunk_interval)

    class _RealHttpBase:
        async def ainvoke(self, *args, **kwargs):
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, read=2.0)) as client:
                return await client.get(url)

    wrapped = gateway._enforce_hard_deadline(_RealHttpBase)()

    try:
        start = time.monotonic()
        with pytest.raises(TimeoutError):
            await wrapped.ainvoke()
        elapsed = time.monotonic() - start
    finally:
        server_sock.close()

    # Cut off near the hard deadline, not anywhere near the ~2s the
    # trickling server (or its own generous 2.0s read timeout) would
    # otherwise have allowed.
    assert elapsed < hard_deadline + 1.0
    assert elapsed < num_chunks * chunk_interval * 0.75


@pytest.mark.asyncio
async def test_create_openrouter_llm_end_to_end_bounds_a_trickling_response(monkeypatch):
    """Maximum-rigor version of the two tests above: goes through the real
    create_openrouter_llm() -> real ChatOpenAI -> real openai SDK -> real
    httpx client, all pointed at the real trickling socket, rather than a
    synthetic fake. This is the actual production call path (minus
    browser-use's own with_structured_output/message-formatting layer on
    top, which only adds more Runnable composition in front of the same
    ainvoke this test already exercises directly -- see
    test_create_openrouter_llm_preserves_isinstance_of_real_chatopenai and
    the with_structured_output/RunnableBinding trace in this investigation's
    writeup for why that composition still lands on this exact method).
    """
    from langchain_core.messages import HumanMessage

    gateway = load_gateway()
    hard_deadline = 0.4
    monkeypatch.setattr(gateway, "HARD_DEADLINE_SECONDS", hard_deadline)
    monkeypatch.setattr(gateway.secrets_manager, "get_openrouter_api_key", lambda: "or-test-key")

    num_chunks, chunk_interval = 20, 0.1  # ~2s of trickle -- comfortably
    # inside openai's own default per-read timeout too, so nothing but the
    # wrapper can save this call.
    url, server_sock = _start_trickle_server(num_chunks=num_chunks, chunk_interval=chunk_interval)
    monkeypatch.setattr(gateway, "OPENROUTER_BASE_URL", url)

    llm = gateway.create_openrouter_llm("openai/gpt-4.1")

    try:
        start = time.monotonic()
        with pytest.raises(TimeoutError):
            await llm.ainvoke([HumanMessage(content="hi")])
        elapsed = time.monotonic() - start
    finally:
        server_sock.close()

    assert elapsed < hard_deadline + 1.0
    assert elapsed < num_chunks * chunk_interval * 0.75
