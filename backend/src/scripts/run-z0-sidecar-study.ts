#!/usr/bin/env ts-node
import * as fs from 'fs';
import {
  clearZ0SidecarStartupCacheForTests,
  ensureZ0SidecarReady,
} from '../emma/z0SidecarDeployment';

async function main() {
  const output = process.argv[2] ?? '/tmp/z0-sidecar-study.json';
  const baseUrl = process.env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501';

  clearZ0SidecarStartupCacheForTests();
  const first = await ensureZ0SidecarReady({ baseUrl, timeoutMs: 1500 });
  const second = await ensureZ0SidecarReady({ baseUrl, timeoutMs: 1500 });

  if (first !== second) {
    throw new Error('sidecar startup handshake was not reused from cache');
  }
  if (first.profile.public_wildcard_supported !== false) {
    throw new Error('sidecar profile permits wildcard bind');
  }
  if (first.profile.graceful_drain_supported !== true) {
    throw new Error('sidecar profile does not advertise graceful drain');
  }
  if (
    first.profile.limits.max_active !== first.capabilities.transport.max_active ||
    first.profile.limits.max_active !== first.ready.max_active
  ) {
    throw new Error('sidecar max_active mismatch');
  }
  if (
    first.profile.limits.socket_backlog !== first.capabilities.transport.socket_backlog ||
    first.profile.limits.socket_backlog !== first.ready.socket_backlog
  ) {
    throw new Error('sidecar socket_backlog mismatch');
  }

  const result = {
    schema: 'z0eval.agentweb_sidecar_startup_e2e.v1',
    base_url: first.baseUrl,
    cached_same_object: true,
    profile_schema: first.profile.schema,
    bridge_protocol_versions: first.capabilities.bridge_protocol_versions,
    active_dispatch_supported: first.capabilities.active_dispatch_supported,
    max_active: first.ready.max_active,
    socket_backlog: first.ready.socket_backlog,
    queue_policy: first.ready.queue_policy,
    overload_execution: first.ready.overload_execution,
    overload_execution_header: first.ready.overload_execution_header,
    public_wildcard_supported: first.profile.public_wildcard_supported,
    graceful_drain_supported: first.profile.graceful_drain_supported,
    credentials_required: first.profile.credentials_required,
  };

  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  process.stderr.write('z0 sidecar startup study passed\n');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
