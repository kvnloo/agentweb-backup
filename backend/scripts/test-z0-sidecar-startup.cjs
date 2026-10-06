/**
 * Model-free acceptance checks for #95. Run from backend/:
 *   node --test scripts/test-z0-sidecar-startup.cjs
 * Uses the existing ts-node dependency and Node's real HTTP/fetch implementation.
 * Profile fixtures preserve Kevin/kvnloo's sidecar groundwork at a1bc653d.
 */
'use strict';
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', target: 'es2018' },
});
const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const { createServer } = require('node:http');
const { once } = require('node:events');
const {
  readZ0AgentWebConfig, runZ0Route, runZ0ChoiceExperiment, runZ0NoulExperiment,
} = require('../src/emma/z0Adapter.ts');
const {
  ensureZ0SidecarReady, clearZ0SidecarStartupCacheForTests,
  getZ0SidecarStartupCacheSizeForTests, normalizeZ0SidecarBaseUrl,
} = require('../src/emma/z0SidecarDeployment.ts');
const { clearZ0BridgeBackpressureStateForTests } = require('../src/emma/z0BridgeBackpressure.ts');

const profile = {
  schema: 'agentweb.z0.sidecar_profile.v1', deployment_mode: 'local_sidecar',
  transport: 'http', default_bind: '127.0.0.1', default_port: 11501,
  loopback_hosts: ['127.0.0.1', 'localhost', '::1'], public_wildcard_supported: false,
  tls_mode: 'none_loopback', mtls_gateway_supported: false, graceful_drain_supported: true,
  paths: { health: '/healthz', ready: '/readyz', capabilities: '/v1/bridge/capabilities',
    deployment_profile: '/v1/bridge/deployment-profile' },
  process: { entrypoint: 'python -m z0int.intelligence_service',
    default_args: ['--bind', '127.0.0.1', '--port', '11501'] },
  limits: { max_active: 4, socket_backlog: 8, overload_status: 503,
    overload_execution: 'not_started', overload_execution_header: 'X-Z0-Execution' },
  credentials_required: false,
};
const capabilities = {
  schema: 'agentweb.z0.bridge.capabilities.v1', bridge_protocol_versions: ['agentweb.z0.bridge.v1'],
  transport: { max_request_bytes: 40000, max_active: 4, socket_backlog: 8,
    overload_status: 503, retry_after_seconds: 1, queue_policy: 'reject_excess',
    overload_execution: 'not_started', overload_execution_header: 'X-Z0-Execution' },
  active_dispatch_supported: true, receipt_schemas: ['z0int.decision_receipt.v1'],
  endpoints: [
    { path: '/v1/plan', kind: 'plan', modes: ['shadow'], capability_source: 'payload.function',
      physical_execution: false, free_only: 'caller_explicit' },
    { path: '/v1/intelligence', kind: 'dispatch', modes: ['active'], capability_source: 'payload.function',
      physical_execution: true, free_only: 'caller_explicit' },
    { path: '/v1/experimental/choice', kind: 'decide', modes: ['shadow'],
      capabilities: ['experiment.fixture-choice', 'experiment.fixture-noul'],
      physical_execution: true, free_only: false },
  ],
};
const ready = { ok: true, authority_protocol_version: 2, scope: 'synthetic fixture only',
  max_active: 4, socket_backlog: 8, queue_policy: 'reject_excess',
  overload_execution: 'not_started', overload_execution_header: 'X-Z0-Execution' };
const metadata = { '/healthz': { ok: true }, '/readyz': ready,
  '/v1/bridge/deployment-profile': profile, '/v1/bridge/capabilities': capabilities };
const routeArgs = { operation_id: 'fixture-operation', task: 'Synthetic bounded task', function: 'fixture' };
const choiceArgs = { operation_id: 'fixture-choice-op', decision_id: 'fixture-choice', state: 'synthetic',
  instructions: 'Choose a fixture label', options: { a: 'First', b: 'Second' }, allow_remote: true };
const noulArgs = { operation_id: 'fixture-noul-op', decision_id: 'fixture-noul', state: 'synthetic',
  proposition: 'This is a fixture', allow_remote: true };
const lanes = {
  route: (config, fetchImpl) => runZ0Route(routeArgs, { sessionId: 'synthetic-session', config, fetchImpl }),
  choice: (config, fetchImpl) => runZ0ChoiceExperiment(choiceArgs, { scopeId: 'synthetic-scope', config, fetchImpl }),
  noul: (config, fetchImpl) => runZ0NoulExperiment(noulArgs, { scopeId: 'synthetic-scope', config, fetchImpl }),
};
function config(baseUrl, extra = {}) {
  return { mode: 'shadow', baseUrl, timeoutMs: 500, deploymentMode: 'sidecar', ...extra };
}
function envelope(body) {
  return { schema: body.schema, operation_id: body.operation_id, trace_id: body.trace_id,
    mode: body.mode, kind: body.kind, status: 'completed', applied: false,
    replayed: false, reconcile_required: false, retry: 'none', output: { ok: true, applied: false } };
}
async function fixture(t, overrides = {}, intercept) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      if (intercept && await intercept(req, res)) return;
      if (req.method === 'GET' && Object.hasOwn(metadata, req.url)) {
        const response = overrides[req.url];
        res.writeHead(response?.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response?.value ?? metadata[req.url]));
      } else if (req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(envelope(JSON.parse(body))));
      } else {
        res.writeHead(404); res.end();
      }
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const posts = f => f.requests.filter(r => r.method === 'POST');
const gets = f => f.requests.filter(r => r.method === 'GET');
function denied(result) {
  assert.equal(result.skipped, true);
  assert.equal(result.executed, false);
  assert.equal(result.execution_status, 'not_executed');
  assert.equal(result.reconcile_required, false);
  assert.equal(result.bridge_retry, 'caller_may_fallback');
}
beforeEach(() => {
  clearZ0SidecarStartupCacheForTests();
  clearZ0BridgeBackpressureStateForTests();
});

test('deployment configuration is explicit and routing remains default-off', () => {
  assert.equal(readZ0AgentWebConfig({}).mode, 'off');
  assert.equal(readZ0AgentWebConfig({}).deploymentMode, 'off');
  assert.equal(readZ0AgentWebConfig({ Z0INT_AGENTWEB_DEPLOYMENT: ' SIDECAR ' }).deploymentMode, 'sidecar');
});
for (const [name, run] of Object.entries(lanes)) {
  test(`${name}: a non-loopback sidecar makes zero transport calls`, async () => {
    let calls = 0;
    const result = await run(config('http://192.0.2.10:11501'), async (_url, init) => {
      calls++;
      return new Response(JSON.stringify(envelope(JSON.parse(init.body))));
    });
    assert.equal(calls, 0);
    denied(result);
    assert.equal(result.reason, 'sidecar_unavailable');
  });
  test(`${name}: mode off does not start the sidecar handshake`, async () => {
    let calls = 0;
    const result = await run(config('http://192.0.2.10:11501', { mode: 'off' }), async () => { calls++; });
    assert.equal(result.reason, 'disabled');
    assert.equal(calls, 0);
  });
}
test('one real loopback handshake is reused by route, Choice, and Noul', async t => {
  const f = await fixture(t);
  for (const run of Object.values(lanes)) {
    const result = await run(config(f.url));
    assert.equal(result.skipped, false);
  }
  assert.equal(gets(f).length, 4);
  assert.equal(posts(f).length, 3);
  for (const req of gets(f)) {
    assert.equal(req.body, '');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
  }
});
test('concurrent first calls share the handshake and cannot POST before readiness', async t => {
  let release;
  let sawReadiness;
  const readinessObserved = new Promise(resolve => { sawReadiness = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {}, async (req, res) => {
    if (req.url !== '/readyz') return false;
    sawReadiness();
    await held;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ready));
    return true;
  });
  const pending = Object.values(lanes).map(run => run(config(f.url)));
  try {
    await Promise.race([readinessObserved, Promise.all(pending)]);
    assert.equal(posts(f).length, 0);
  } finally {
    release();
    await Promise.all(pending);
  }
  assert.equal(gets(f).length, 4);
  assert.equal(posts(f).length, 3);
});
for (const [name, overrides] of [
  ['failed health', { '/healthz': { value: { ok: false } } }],
  ['draining 503', { '/readyz': { status: 503, value: { ok: false, draining: true } } }],
  ['contradictory draining 200', { '/readyz': { value: { ...ready, draining: true } } }],
  ['capacity mismatch', { '/readyz': { value: { ...ready, max_active: 3 } } }],
  ['bridge version mismatch', { '/v1/bridge/capabilities': { value: { ...capabilities, bridge_protocol_versions: ['unknown'] } } }],
]) {
  test(`${name} rejects before the first POST`, async t => {
    const f = await fixture(t, overrides);
    const result = await lanes.route(config(f.url, { mode: 'active' }));
    denied(result);
    assert.equal(posts(f).length, 0);
    assert.equal(getZ0SidecarStartupCacheSizeForTests(), 0);
  });
}
test('unsupported active dispatch is rejected even when backpressure is off', async t => {
  const f = await fixture(t, { '/v1/bridge/capabilities': {
    value: { ...capabilities, active_dispatch_supported: false },
  } });
  const result = await lanes.route(config(f.url, { mode: 'active' }));
  denied(result);
  assert.equal(result.reason, 'capability_unsupported');
  assert.equal(posts(f).length, 0);
});
test('startup failure is not cached and a later explicit call can recover', async t => {
  let healthy = false;
  const f = await fixture(t, {}, (req, res) => {
    if (req.url !== '/healthz') return false;
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: healthy }));
    return true;
  });
  denied(await lanes.route(config(f.url)));
  assert.equal(posts(f).length, 0);
  healthy = true;
  assert.equal((await lanes.route(config(f.url))).skipped, false);
  assert.equal(posts(f).length, 1);
});
test('sidecar-off preserves the incumbent adapter path without startup probes', async t => {
  const f = await fixture(t);
  assert.equal((await lanes.route(config(f.url, { deploymentMode: 'off' }))).skipped, false);
  assert.equal(gets(f).length, 0);
  assert.equal(posts(f).length, 1);
});
test('accepted trailing slash uses the canonical origin for POST as well as startup', async t => {
  const f = await fixture(t);
  assert.equal((await lanes.route(config(`${f.url}/`))).skipped, false);
  assert.deepEqual(posts(f).map(r => r.path), ['/v1/plan']);
});
test('startup fetch rejects redirects, including the capability discovery leg', async t => {
  const destination = await fixture(t);
  const f = await fixture(t, {}, (req, res) => {
    if (req.url !== '/v1/bridge/capabilities') return false;
    res.writeHead(307, { Location: `${destination.url}/v1/bridge/capabilities` }); res.end();
    return true;
  });
  await assert.rejects(ensureZ0SidecarReady({ baseUrl: f.url }));
  assert.equal(destination.requests.length, 0);
});
test('active POST redirect cannot leave the checked origin and stays ambiguous', async t => {
  const destination = await fixture(t);
  const f = await fixture(t, {}, (req, res) => {
    if (req.method !== 'POST') return false;
    res.writeHead(307, { Location: `${destination.url}/v1/intelligence` }); res.end();
    return true;
  });
  const result = await lanes.route(config(f.url, { mode: 'active' }));
  assert.equal(result.execution_status, 'unknown');
  assert.equal(result.reconcile_required, true);
  assert.equal(result.bridge_retry, 'same_identity_only');
  assert.equal(posts(f).length, 1);
  assert.equal(destination.requests.length, 0);
});
test('unproven active 503 after startup stays unknown with no automatic retry', async t => {
  const f = await fixture(t, {}, (req, res) => {
    if (req.method !== 'POST') return false;
    res.writeHead(503); res.end(); return true;
  });
  const result = await lanes.route(config(f.url, { mode: 'active', backpressureMode: 'enforce' }));
  assert.equal(result.execution_status, 'unknown');
  assert.equal(result.bridge_retry, 'same_identity_only');
  assert.equal(result.reconcile_required, true);
  assert.equal(posts(f).length, 1);
});
test('proven pre-execution overload still opens the existing circuit', async t => {
  const f = await fixture(t, {}, (req, res) => {
    if (req.method !== 'POST') return false;
    res.writeHead(503, { 'X-Z0-Execution': 'not_started', 'Retry-After': '1' }); res.end(); return true;
  });
  const c = config(f.url, { mode: 'active', backpressureMode: 'enforce' });
  const first = await lanes.route(c);
  assert.equal(first.execution_status, 'not_executed');
  assert.equal(first.reason, 'overloaded_pre_execution');
  const second = await lanes.route(c);
  denied(second);
  assert.equal(second.reason, 'circuit_open');
  assert.equal(posts(f).length, 1);
  assert.equal(gets(f).length, 4);
});
test('normalizer accepts IPv4, localhost, IPv6 and rejects credentials/path/query', () => {
  for (const value of ['http://127.0.0.1:11501/', 'http://localhost:11501', 'http://[::1]:11501']) {
    assert.match(normalizeZ0SidecarBaseUrl(value), /^http:/);
  }
  for (const value of ['http://user:secret@127.0.0.1', 'http://127.0.0.1/path',
    'http://127.0.0.1/?token=synthetic', 'http://0.0.0.0', 'https://127.0.0.1']) {
    assert.throws(() => normalizeZ0SidecarBaseUrl(value));
  }
});
