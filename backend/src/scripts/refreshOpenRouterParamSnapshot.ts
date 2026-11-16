/**
 * ENG-1831: refresh the OpenRouter per-endpoint `supported_parameters` snapshot
 * that openRouterRequestParams.registryGuard.test.ts checks the model registry
 * against. Run after adding/changing a registry model, or when the guard test
 * says a model is missing from the snapshot:
 *
 *   npm run refresh:openrouter-params
 *
 * Uses the public, unauthenticated `GET /api/v1/models/{id}/endpoints`, which
 * (unlike the `/models` list) follows aliases such as `qwen/qwen3.8-max` to the
 * dated snapshot OpenRouter actually routes to. openRouterRequestParams.registryGuard
 * fails if a registry id resolves to a different id here (an alias = a stale registry id).
 */
import * as fs from 'fs';
import { fetchJson, parseEndpointProviders } from '../services/agentMode/frontierMonitor';
import * as path from 'path';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { resolveOpenRouterUpstreamModelId } from '../utils/openRouterGatewayContract';

export const SNAPSHOT_PATH = path.join(
  __dirname, '..', 'services', 'agentMode', '__tests__', 'fixtures', 'openRouterSupportedParameters.json',
);

/** Fetch one model's endpoints, following OpenRouter aliases, with sorted provider/parameter lists. */
async function fetchEndpoints(upstreamModel: string) {
  const { resolvedId, endpoints } = parseEndpointProviders(
    await fetchJson(`https://openrouter.ai/api/v1/models/${upstreamModel}/endpoints`),
  );
  return { resolvedId, endpoints };
}

/** Snapshot every non-live registry model's OpenRouter endpoints to SNAPSHOT_PATH. */
async function main() {
  const upstreamIds = [...new Set(
    Object.entries(LLM_MODEL_REGISTRY)
      .filter(([, config]) => !config.isLive)
      .map(([modelId]) => resolveOpenRouterUpstreamModelId(modelId)),
  )].sort();

  const models: Record<string, Awaited<ReturnType<typeof fetchEndpoints>>> = {};
  for (const upstreamModel of upstreamIds) {
    models[upstreamModel] = await fetchEndpoints(upstreamModel);
    console.log(`${upstreamModel} -> ${models[upstreamModel].resolvedId} (${models[upstreamModel].endpoints.length} endpoints)`);
  }

  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  // One line per endpoint keeps refresh diffs reviewable.
  const modelBlocks = Object.entries(models).map(([upstreamModel, { resolvedId, endpoints }]) => [
    `    ${JSON.stringify(upstreamModel)}: {`,
    `      "resolvedId": ${JSON.stringify(resolvedId)},`,
    '      "endpoints": [',
    endpoints.map(endpoint => `        ${JSON.stringify(endpoint)}`).join(',\n'),
    '      ]',
    '    }',
  ].join('\n'));
  fs.writeFileSync(SNAPSHOT_PATH, [
    '{',
    `  "fetchedAt": ${JSON.stringify(new Date().toISOString())},`,
    `  "source": "https://openrouter.ai/api/v1/models/{id}/endpoints",`,
    '  "models": {',
    modelBlocks.join(',\n'),
    '  }',
    '}',
    '',
  ].join('\n'));
  console.log(`Wrote ${upstreamIds.length} models to ${SNAPSHOT_PATH}`);
}

if (require.main === module) {
  main().then(() => process.exit(0), (error) => {
    console.error(error);
    process.exit(1);
  });
}
