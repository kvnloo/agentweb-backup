#!/usr/bin/env ts-node
import * as fs from 'fs';
import {
  getZ0BridgeCapabilities,
  z0BridgeCapabilitySupported,
} from '../emma/z0BridgeCapabilities';

async function main() {
  const baseUrl = process.env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501';
  const output = process.argv[2] ?? '/tmp/z0-bridge-capabilities.json';

  const capabilities = await getZ0BridgeCapabilities({
    baseUrl,
    cacheTtlMs: 0,
    timeoutMs: 1000,
  });

  const required = [
    {
      kind: 'plan' as const,
      mode: 'shadow' as const,
      capability: 'summarization',
      freeOnly: true,
    },
    {
      kind: 'dispatch' as const,
      mode: 'active' as const,
      capability: 'research',
      freeOnly: true,
    },
    {
      kind: 'decide' as const,
      mode: 'shadow' as const,
      capability: 'experiment.report_type_v1',
      freeOnly: false,
    },
    {
      kind: 'decide' as const,
      mode: 'shadow' as const,
      capability: 'experiment.stop_request_v1',
      freeOnly: false,
    },
  ];

  for (const request of required) {
    if (!z0BridgeCapabilitySupported(capabilities, request)) {
      throw new Error(`required bridge capability not advertised: ${JSON.stringify(request)}`);
    }
  }

  if (z0BridgeCapabilitySupported(capabilities, {
    kind: 'decide',
    mode: 'shadow',
    capability: 'experiment.report_type_v1',
    freeOnly: true,
  })) {
    throw new Error('paid decision lane incorrectly advertised as free-only compatible');
  }

  fs.writeFileSync(output, JSON.stringify(capabilities, null, 2) + '\n');
  process.stderr.write('z0 bridge capability negotiation passed\n');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
