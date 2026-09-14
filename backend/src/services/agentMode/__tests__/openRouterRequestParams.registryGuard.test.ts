/**
 * ENG-1831: guard the model registry against OpenRouter's published
 * per-endpoint `supported_parameters`.
 *
 * callLLM sends `provider.require_parameters: true`, so a request is routable
 * only if at least one (non-ignored) endpoint supports EVERY parameter in it.
 * ENG-199 shipped Claude Fable 5.1 with `tool_choice` unsupported and every
 * agent-mode turn 404'd for its whole time in the picker. This test fails
 * before merge instead.
 *
 * It checks only the dangerous direction — a parameter we would SEND that no
 * endpoint accepts. Being more conservative than OpenRouter is allowed.
 *
 * When a model is missing from the snapshot, or OpenRouter changes a model:
 *   npm run refresh:openrouter-params
 */

jest.mock('../../db', () => ({
  agentModeDb: {},
  userDb: { getUserById: jest.fn() },
  scheduleDb: {},
  scheduleTemplateDb: {},
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));

import snapshot from './fixtures/openRouterSupportedParameters.json';
import { AgentModeService } from '../../agentModeService';
import {
  GATEWAY_REASONING_EFFORT_OVERRIDES,
  GatewayTaskClass,
  resolveGatewayReasoningEffort,
  resolveOpenRouterUpstreamModelId,
} from '../../../utils/openRouterGatewayContract';
import {
  OpenRouterParamCapabilities,
  openRouterIgnoredProviders,
  selectOpenRouterSamplingParams,
} from '../openRouterRequestParams';

type SnapshotModel = { resolvedId: string; endpoints: { provider: string; supported_parameters: string[] }[] };
const SNAPSHOT_MODELS = snapshot.models as Record<string, SnapshotModel>;

type RegistryEntry = OpenRouterParamCapabilities & {
  isLive?: boolean;
  internalOnly?: boolean;
  reasoningEffort?: any;
  supportedReasoningEfforts?: readonly any[];
};

/** The widest optional parameter set callLLM can send to this model on its own. */
function widestParamSet(upstreamModel: string, config: RegistryEntry): string[] {
  const acceptsTools = config.supportsTools !== false;
  const sent = ['max_tokens'];
  if (acceptsTools) sent.push('tools');
  sent.push(...Object.keys(selectOpenRouterSamplingParams({
    upstreamModel,
    capabilities: config,
    hasCallerTools: acceptsTools,
    temperature: 0.7,
  })));
  const taskClasses = [undefined, ...Object.keys(GATEWAY_REASONING_EFFORT_OVERRIDES)] as (GatewayTaskClass | undefined)[];
  if (taskClasses.some(taskClass => resolveGatewayReasoningEffort(config, taskClass) !== undefined)) {
    sent.push('reasoning');
  }
  return sent;
}

/** Violation message for one registry entry, or null when it is routable. */
function routingViolation(modelId: string, config: RegistryEntry): string | null {
  const upstreamModel = resolveOpenRouterUpstreamModelId(modelId);
  const published = SNAPSHOT_MODELS[upstreamModel];
  if (!published) {
    return `${modelId} -> ${upstreamModel} is not in the OpenRouter snapshot; run npm run refresh:openrouter-params`;
  }
  const ignored = openRouterIgnoredProviders(upstreamModel);
  const endpoints = published.endpoints.filter(endpoint => !ignored.includes(endpoint.provider));
  const sent = widestParamSet(upstreamModel, config);
  if (endpoints.some(endpoint => sent.every(param => endpoint.supported_parameters.includes(param)))) return null;

  const missing = sent.filter(param => !endpoints.some(endpoint => endpoint.supported_parameters.includes(param)));
  return `${modelId} -> ${upstreamModel}: no endpoint accepts all of [${sent.join(', ')}]` +
    (missing.length ? `; unsupported everywhere: [${missing.join(', ')}] — set the matching supports* flag` : '');
}

const registry = Object.entries(
  (new AgentModeService() as any).llmModels as Record<string, RegistryEntry>,
).filter(([, config]) => !config.isLive);

describe('model registry vs OpenRouter supported_parameters (ENG-1831)', () => {
  it('covers the whole registry', () => {
    expect(registry.length).toBeGreaterThan(20);
  });

  it.each(registry)('%s is routable with every parameter callLLM can send it', (modelId, config) => {
    expect(routingViolation(modelId, config)).toBeNull();
  });

  it('only internal models may be tool-less (agent mode always sends tools)', () => {
    const toollessPickable = registry
      .filter(([, config]) => config.supportsTools === false && !config.internalOnly)
      .map(([modelId]) => modelId);
    expect(toollessPickable).toEqual([]);
  });

  describe('catches the regressions it exists for', () => {
    const fable = registry.find(([modelId]) => modelId === 'openrouter/anthropic/claude-fable-5.1');
    const sonar = registry.find(([modelId]) => modelId === 'openrouter/perplexity/sonar-deep-research');

    it('ENG-199: Claude Fable 5.1 without supportsToolChoice: false', () => {
      expect(fable).toBeDefined();
      expect(routingViolation(fable![0], { ...fable![1], supportsToolChoice: undefined }))
        .toMatch(/unsupported everywhere: \[tool_choice\]/);
    });

    it('Sonar Deep Research without supportsTools: false', () => {
      expect(sonar).toBeDefined();
      expect(routingViolation(sonar![0], { ...sonar![1], supportsTools: undefined, supportsToolChoice: undefined }))
        .toMatch(/unsupported everywhere: \[tools, tool_choice\]/);
    });

    it('a model missing from the snapshot', () => {
      expect(routingViolation('openrouter/example/not-a-model', { supportsTemperature: true }))
        .toMatch(/not in the OpenRouter snapshot/);
    });
  });
});
