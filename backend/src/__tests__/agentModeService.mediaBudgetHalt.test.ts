/**
 * ENG-922 — a media-budget deferral is terminal for this turn.
 *
 * Drives the real AgentMode loop while mocking only image-gen + Meta Graph.
 * Three variants finish in the first bounded batch, the fourth defers, and the
 * loop must stop before a scripted next turn can upload a partial set to Meta.
 */

import { AgentModeService } from '../services/agentModeService';
import {
  buildLLMResponse,
  installStandardMockDeps,
} from './agentMode/characterization/harness';

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../services/chatbotService');
jest.mock('../utils/secretsManager');
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

const imageCall = (id: string, prompt: string) => ({
  id,
  name: 'generate_image',
  arguments: JSON.stringify({ prompt }),
});

describe('AgentModeService - media budget halts before Meta writes', () => {
  const oldBudget = process.env.AGENT_MODE_MEDIA_BUDGET_MS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENT_MODE_MEDIA_BUDGET_MS = '1';
    installStandardMockDeps();
  });

  afterAll(() => {
    if (oldBudget === undefined) delete process.env.AGENT_MODE_MEDIA_BUDGET_MS;
    else process.env.AGENT_MODE_MEDIA_BUDGET_MS = oldBudget;
  });

  it('delivers finished images and never reaches Graph after the fourth image defers', async () => {
    const service = new AgentModeService();
    const callLLM = jest.spyOn(service as any, 'callLLM')
      .mockResolvedValueOnce(buildLLMResponse({
        tool_calls: [
          imageCall('img-1', 'variant 1'),
          imageCall('img-2', 'variant 2'),
          imageCall('img-3', 'variant 3'),
          imageCall('img-4', 'variant 4'),
          // A model may optimistically emit the dependent Graph write in the
          // SAME tool batch. It must not race the incomplete image set.
          {
            id: 'graph-write-same-iteration',
            name: 'call_meta_marketing_api',
            arguments: JSON.stringify({
              entity_type: 'AD_CREATIVE',
              action: 'UPLOAD_IMAGE',
              account_id: 'act_123',
              params: { image_url: 'https://s3/variant-1.png' },
            }),
          },
        ],
      }));

    const graphCalls: string[] = [];
    jest.spyOn(service as any, 'executeTool').mockImplementation(async (...toolArgs: unknown[]) => {
      const name = toolArgs[1] as string;
      const args = toolArgs[2] as any;
      if (name === 'generate_image') {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { success: true, imageUrl: `https://s3/${String(args.prompt).replace(' ', '-')}.png` };
      }
      if (name === 'call_meta_marketing_api') graphCalls.push(name);
      return { success: true };
    });
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const result: any = await service.generateMarketingResponse(
      'Generate four variants and publish them as Meta ad creatives.',
      [],
      'test-user',
      service.default_model,
      'test-session',
    );

    expect(result.toolCalls.filter((tc: any) => tc.name === 'generate_image' && tc.result?.imageUrl)).toHaveLength(3);
    expect(result.content).toContain('3 images');
    expect(result.content).toContain('1 image still remains');
    expect(graphCalls).toEqual([]);
    expect(callLLM).toHaveBeenCalledTimes(1);
  });
});
