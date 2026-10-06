#!/usr/bin/env ts-node
import * as fs from 'fs';
import {
  clearZ0BridgeBackpressureStateForTests,
  getZ0BridgeBackpressureStateForTests,
} from '../emma/z0BridgeBackpressure';
import {
  runZ0Route,
  type Z0AgentWebConfig,
  type Z0FetchLike,
  type Z0RouteArgs,
} from '../emma/z0Adapter';

const baseUrl = process.env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501';

const baseRequest: Z0RouteArgs = {
  operation_id: 'backpressure-op-0',
  task: 'bounded backpressure fixture',
  function: 'summarization',
};

const config: Z0AgentWebConfig = {
  mode: 'active',
  baseUrl,
  timeoutMs: 5000,
  backpressureMode: 'enforce',
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bridgeSuccess(body: any) {
  return {
    schema: 'agentweb.z0.bridge.v1',
    operation_id: body.operation_id,
    trace_id: body.trace_id,
    mode: body.mode,
    kind: body.kind,
    status: 'completed',
    applied: false,
    replayed: false,
    reconcile_required: false,
    retry: 'none',
    output: {
      ok: true,
      executed: true,
      applied: false,
      route: { kind: 'PARENT_ONLY' },
    },
  };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for study condition');
    }
    await sleep(10);
  }
}

async function localAdmissionStudy() {
  clearZ0BridgeBackpressureStateForTests();

  let postCount = 0;
  let capabilityGets = 0;
  let releasePosts!: () => void;
  const releaseGate = new Promise<void>(resolve => {
    releasePosts = resolve;
  });

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      capabilityGets += 1;
      return fetch(url, init);
    }

    postCount += 1;
    const body = JSON.parse(String(init?.body ?? '{}'));
    await releaseGate;
    return jsonResponse(bridgeSuccess(body));
  }) as Z0FetchLike;

  const firstFour = Array.from({ length: 4 }, (_, index) =>
    runZ0Route(
      { ...baseRequest, operation_id: `backpressure-op-${index + 1}` },
      {
        sessionId: `backpressure-session-${index + 1}`,
        config,
        fetchImpl,
      },
    ),
  );

  await waitFor(() => postCount === 4);

  const fifth: any = await runZ0Route(
    { ...baseRequest, operation_id: 'backpressure-op-5' },
    {
      sessionId: 'backpressure-session-5',
      config,
      fetchImpl,
    },
  );

  if (postCount !== 4) {
    throw new Error(`local admission allowed excess POSTs: ${postCount}`);
  }
  if (
    fifth.reason !== 'local_backpressure' ||
    fifth.execution_status !== 'not_executed' ||
    fifth.reconcile_required !== false ||
    fifth.bridge_retry !== 'caller_may_fallback'
  ) {
    throw new Error(`fifth call was not rejected locally: ${JSON.stringify(fifth)}`);
  }

  releasePosts();
  const completed: any[] = await Promise.all(firstFour);
  if (completed.some(row => row.ok !== true)) {
    throw new Error(`admitted calls did not complete: ${JSON.stringify(completed)}`);
  }

  const state = getZ0BridgeBackpressureStateForTests(baseUrl);
  if (state.inFlight !== 0) {
    throw new Error(`in-flight permits leaked: ${state.inFlight}`);
  }

  return {
    capability_gets: capabilityGets,
    post_count: postCount,
    fifth,
    completed_count: completed.length,
  };
}

async function provenOverloadStudy() {
  clearZ0BridgeBackpressureStateForTests();

  let postCount = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return fetch(url, init);
    }

    postCount += 1;
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (postCount === 1) {
      return new Response('', {
        status: 503,
        headers: {
          'Retry-After': '1',
          'X-Z0-Execution': 'not_started',
        },
      });
    }

    return jsonResponse(bridgeSuccess(body));
  }) as Z0FetchLike;

  const first: any = await runZ0Route(
    { ...baseRequest, operation_id: 'overload-op-1' },
    { sessionId: 'overload-session-1', config, fetchImpl },
  );
  if (
    first.reason !== 'overloaded_pre_execution' ||
    first.execution_status !== 'not_executed' ||
    first.reconcile_required !== false ||
    first.bridge_retry !== 'caller_may_fallback' ||
    first.retry_after_ms !== 1000
  ) {
    throw new Error(`proven overload semantics failed: ${JSON.stringify(first)}`);
  }

  const second: any = await runZ0Route(
    { ...baseRequest, operation_id: 'overload-op-2' },
    { sessionId: 'overload-session-2', config, fetchImpl },
  );
  if (second.reason !== 'circuit_open' || postCount !== 1) {
    throw new Error(`open circuit did not suppress transport: ${JSON.stringify(second)}`);
  }

  await sleep(1100);

  const recovered: any = await runZ0Route(
    { ...baseRequest, operation_id: 'overload-op-3' },
    { sessionId: 'overload-session-3', config, fetchImpl },
  );
  if (recovered.ok !== true || Number(postCount) !== 2) {
    throw new Error(`circuit did not recover after cooldown: ${JSON.stringify(recovered)}`);
  }

  return { post_count: postCount, first, second, recovered };
}

async function unproven503Study() {
  clearZ0BridgeBackpressureStateForTests();

  let postCount = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return fetch(url, init);
    }

    postCount += 1;
    return new Response('', {
      status: 503,
      headers: { 'Retry-After': '1' },
    });
  }) as Z0FetchLike;

  const result: any = await runZ0Route(
    { ...baseRequest, operation_id: 'unproven-503-op' },
    { sessionId: 'unproven-503-session', config, fetchImpl },
  );

  if (
    result.reason !== 'http_error' ||
    result.execution_status !== 'unknown' ||
    result.reconcile_required !== true ||
    result.bridge_retry !== 'same_identity_only'
  ) {
    throw new Error(`unproven 503 lost ambiguity: ${JSON.stringify(result)}`);
  }
  if (postCount !== 1) {
    throw new Error(`adapter retried unproven 503 automatically: ${postCount}`);
  }

  return { post_count: postCount, result };
}

async function main() {
  const output = process.argv[2] ?? '/tmp/z0-backpressure-study.json';

  const capabilitiesResponse = await fetch(`${baseUrl}/v1/bridge/capabilities`);
  if (!capabilitiesResponse.ok) {
    throw new Error(`capability fetch failed: HTTP ${capabilitiesResponse.status}`);
  }
  const capabilities = await capabilitiesResponse.json() as any;

  if (capabilities.transport.max_active !== 4) {
    throw new Error(`unexpected max_active: ${capabilities.transport.max_active}`);
  }
  if (
    capabilities.transport.queue_policy !== 'reject_excess' ||
    capabilities.transport.overload_execution !== 'not_started' ||
    capabilities.transport.overload_execution_header !== 'X-Z0-Execution'
  ) {
    throw new Error('z0 overload proof capability is incomplete');
  }

  const local = await localAdmissionStudy();
  const overload = await provenOverloadStudy();
  const unproven = await unproven503Study();

  const result = {
    schema: 'z0eval.agentweb_backpressure_circuit_e2e.v1',
    capabilities: {
      max_active: capabilities.transport.max_active,
      socket_backlog: capabilities.transport.socket_backlog,
      overload_status: capabilities.transport.overload_status,
      retry_after_seconds: capabilities.transport.retry_after_seconds,
      queue_policy: capabilities.transport.queue_policy,
      overload_execution: capabilities.transport.overload_execution,
      overload_execution_header: capabilities.transport.overload_execution_header,
    },
    local,
    overload,
    unproven,
  };

  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  process.stderr.write('z0 backpressure/circuit study passed\n');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
