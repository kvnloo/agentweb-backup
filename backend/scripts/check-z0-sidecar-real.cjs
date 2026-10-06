/**
 * Exact-head, model-free real z0 sidecar check for #95.
 *
 * Starts with an externally managed real z0 process at Z0INT_SERVICE_URL,
 * proves the cached startup contract, then sends two SHADOW /v1/plan requests.
 * Shadow planning never dispatches a provider/model.
 */
'use strict';

require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', target: 'es2018' },
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  runZ0Route,
} = require('../src/emma/z0Adapter.ts');
const {
  clearZ0SidecarStartupCacheForTests,
} = require('../src/emma/z0SidecarDeployment.ts');
const {
  clearZ0BridgeBackpressureStateForTests,
} = require('../src/emma/z0BridgeBackpressure.ts');

async function main() {
  const baseUrl = (process.env.Z0INT_SERVICE_URL || 'http://127.0.0.1:11501').replace(/\/+$/, '');
  const output = process.argv[2] || '/tmp/z0-sidecar-real.json';
  const calls = [];
  const rawSession = 'agentweb-real-sidecar-e2e-raw-session';

  clearZ0SidecarStartupCacheForTests();
  clearZ0BridgeBackpressureStateForTests();

  const fetchImpl = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    calls.push({
      method,
      path: new URL(url).pathname,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return fetch(input, init);
  };

  const config = {
    mode: 'shadow',
    baseUrl,
    timeoutMs: 1500,
    deploymentMode: 'sidecar',
    backpressureMode: 'enforce',
  };

  const first = await runZ0Route(
    {
      operation_id: 'sidecar-real-shadow-1',
      task: 'Model-free exact-head sidecar startup proof',
      function: 'summarization',
    },
    { sessionId: rawSession, config, fetchImpl },
  );
  const second = await runZ0Route(
    {
      operation_id: 'sidecar-real-shadow-2',
      task: 'Second call must reuse cached startup state',
      function: 'summarization',
    },
    { sessionId: rawSession, config, fetchImpl },
  );

  for (const result of [first, second]) {
    assert.equal(result.skipped, false);
    assert.equal(result.mode, 'shadow');
    assert.equal(result.executed, false);
    assert.equal(result.reconcile_required, false);
    assert.equal(result.bridge_schema, 'agentweb.z0.bridge.v1');
    assert.equal(JSON.stringify(result).includes(rawSession), false);
  }

  const gets = calls.filter(call => call.method === 'GET');
  const posts = calls.filter(call => call.method === 'POST');

  assert.deepEqual(
    gets.map(call => call.path).sort(),
    [
      '/healthz',
      '/readyz',
      '/v1/bridge/capabilities',
      '/v1/bridge/deployment-profile',
    ].sort(),
  );
  assert.deepEqual(posts.map(call => call.path), ['/v1/plan', '/v1/plan']);
  assert.equal(posts.every(call => !call.body.includes(rawSession)), true);

  const receipt = {
    schema: 'z0eval.agentweb_sidecar_real_e2e.v1',
    base_url: baseUrl,
    startup_get_count: gets.length,
    shadow_post_count: posts.length,
    startup_paths: gets.map(call => call.path).sort(),
    shadow_paths: posts.map(call => call.path),
    first: {
      executed: first.executed,
      bridge_status: first.bridge_status,
      reconcile_required: first.reconcile_required,
    },
    second: {
      executed: second.executed,
      bridge_status: second.bridge_status,
      reconcile_required: second.reconcile_required,
    },
    raw_identity_exported: false,
    model_dispatch_expected: false,
  };

  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
