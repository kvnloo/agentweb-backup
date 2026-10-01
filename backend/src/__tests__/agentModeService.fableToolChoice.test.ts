/**
 * ENG-199: Claude Fable 5.1 was added to the registry and listed in the model
 * picker, but EVERY agent-mode turn on it failed in production with a 500. The
 * upstream cause, from the production log:
 *
 *   AgentMode: OpenRouter call failed for model "openrouter/anthropic/claude-fable-5.1":
 *   404 No endpoints found that can handle the requested parameters
 *
 * OpenRouter's entry for `anthropic/claude-fable-5.1` omits `tool_choice` from
 * `supported_parameters` — unlike `anthropic/claude-fable-5` and both `:batch`
 * variants, which list it. Sending an unsupported parameter does not get it
 * ignored; the provider router finds NO endpoint able to serve the request and
 * 404s. Agent mode always supplies caller tools, so the parameter was always
 * sent and the model was unusable for its entire time in the picker (0 sessions
 * across 18,611 scanned).
 *
 * This is the same defect class CodeRabbit caught pre-merge for `temperature`,
 * one parameter over, and it fails louder.
 */

jest.mock('../services/db', () => ({
  agentModeDb: {},
  userDb: { getUserById: jest.fn() },
  scheduleDb: {},
  scheduleTemplateDb: {},
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
  },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));

import { AgentModeService } from '../services/agentModeService';

const FABLE = 'openrouter/anthropic/claude-fable-5.1';
const TOOLS = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }];

function serviceWithSpy() {
  const service = new AgentModeService();
  const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
  jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
    chat: { completions: { create } },
  } as any);
  return { service, create };
}

describe('Claude Fable 5.1 — tool_choice must never reach OpenRouter (ENG-199)', () => {
  it('is flagged in the registry as not supporting tool_choice', () => {
    const service = new AgentModeService();
    expect((service as any).llmModels[FABLE].supportsToolChoice).toBe(false);
  });

  it('THE BUG: omits tool_choice from the request even though caller tools are present', async () => {
    const { service, create } = serviceWithSpy();

    await service.callLLM(FABLE, [{ role: 'user', content: 'Hi' }], { tools: TOOLS } as any);

    const request = create.mock.calls[0][0];
    // The tools themselves ARE supported and must still be sent — this is not
    // "disable tools for Fable", it is "do not send the one field that breaks routing".
    expect(request.tools).toHaveLength(1);
    expect(request).not.toHaveProperty('tool_choice');
  });

  it('drops an EXPLICIT tool_choice too, not just the auto default', async () => {
    const { service, create } = serviceWithSpy();

    await service.callLLM(
      FABLE,
      [{ role: 'user', content: 'Hi' }],
      { tools: TOOLS, tool_choice: 'required' } as any,
    );

    expect(create.mock.calls[0][0]).not.toHaveProperty('tool_choice');
  });

  it('temperature stays omitted as well (the defect CodeRabbit caught pre-merge)', async () => {
    const { service, create } = serviceWithSpy();

    await service.callLLM(
      FABLE,
      [{ role: 'user', content: 'Hi' }],
      { tools: TOOLS, temperature: 0.7 } as any,
    );

    expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  // The gate defaults to true, so this must not become a silent registry-wide
  // regression that disables tool_choice for every model.
  it('still sends tool_choice for a model that supports it', async () => {
    const { service, create } = serviceWithSpy();

    await service.callLLM(
      'openrouter/x-ai/grok-4.6',
      [{ role: 'user', content: 'Hi' }],
      { tools: TOOLS } as any,
    );

    expect(create.mock.calls[0][0].tool_choice).toBe('auto');
  });

  it('every other registry model is left on the default (only the exceptions carry the flag)', () => {
    const service = new AgentModeService();
    const models = (service as any).llmModels as Record<string, any>;
    const flagged = Object.keys(models).filter((id) => models[id].supportsToolChoice === false);
    expect(flagged).toEqual([FABLE]);
  });
});
