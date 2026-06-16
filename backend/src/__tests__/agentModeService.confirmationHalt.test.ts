/**
 * End-to-end loop-halt test for the Meta Ads human-in-the-loop confirmation gate.
 *
 * Proves the FULL chain works inside the real agent loop (generateMarketingResponse):
 *   tool returns awaitingUserConfirmation
 *     -> Phase-3 result handling exposes it on toolResult.result
 *     -> collectConfirmationPrompt detects it
 *     -> the loop BREAKS, surfaces confirmationPrompt as the turn output,
 *        and does NOT call the LLM again (no self-approval, no auto-continue).
 *
 * executeTool is spied to emit the flag — the gateway/registry pass result through
 * unchanged (verified in code: toolRegistry.execute -> executeTool -> gateway all
 * return the handler's object raw), so this isolates the loop-break behavior.
 */

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { settingsService } from '../services/settingsService';

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../services/db', () => ({
  ...jest.requireActual('../services/db'),
  taskTemplateDb: {
    getAllTemplates: jest.fn().mockResolvedValue([]),
    getPublishedTemplates: jest.fn().mockResolvedValue([])
  }
}));
jest.mock('../utils/secretsManager');

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) })
    }))
  },
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) })
  })),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) })
  })),
  config: { update: jest.fn() }
}));

describe('AgentModeService - confirmation gate halts the agent loop', () => {
  let service: AgentModeService;
  let llmCallSpy: jest.SpyInstance;
  let executeToolSpy: jest.SpyInstance;

  const metaToolCall = {
    id: 'tc1',
    type: 'function',
    function: {
      name: 'call_meta_marketing_api',
      arguments: JSON.stringify({
        entity_type: 'AD',
        action: 'CREATE',
        account_id: '123456789',
        ad_set_id: 'adset_1',
        params: { name: 'New Maintenance Ad', creative_id: 'creative_1' }
      })
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();

    (chatbotDb.getChatSession as jest.Mock) = jest.fn().mockResolvedValue({
      sessionId: 'test-session',
      userId: 'test-user',
      messages: [],
      workPlan: null
    });
    (chatbotDb.addMessageToSession as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.incrementCalledFunctions as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.incrementFailedFunctions as jest.Mock) = jest.fn().mockResolvedValue({});
    (settingsService.getSetting as jest.Mock) = jest.fn().mockResolvedValue(null);

    service = new AgentModeService();

    // First LLM turn: emit the Meta write tool call. A SECOND turn (if the loop
    // wrongly continued) would return this text — the test asserts it never surfaces.
    let call = 0;
    llmCallSpy = jest.spyOn(service as any, 'callLLM').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [metaToolCall] }, finish_reason: 'tool_calls' }] };
      }
      return { choices: [{ message: { role: 'assistant', content: 'LOOP_CONTINUED_WRONGLY', tool_calls: null }, finish_reason: 'stop' }] };
    });

    // The Meta tool returns the human-gate flag (gateway passes it through unchanged).
    executeToolSpy = jest.spyOn(service as any, 'executeTool').mockResolvedValue({
      success: true,
      requiresConfirmation: true,
      awaitingUserConfirmation: true,
      confirmationPrompt: 'CONFIRM_TARGET: publish New Maintenance Ad into Maintenance Campaign — yes?',
      summary: 'Publish a NEW ad "New Maintenance Ad" into ad set "Maintenance Ad Set".',
      target: { campaign: 'Maintenance Campaign' }
    });
  });

  it('halts the turn, surfaces the confirmation prompt, and does not call the LLM again', async () => {
    const result: any = await service.generateMarketingResponse(
      'add this image to the campaign',
      [],
      'test-user',
      service.default_model,
      'test-session'
    );

    // The Meta tool ran exactly once...
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
    expect(executeToolSpy.mock.calls[0][1]).toBe('call_meta_marketing_api');

    // ...the user-facing confirmation prompt is the turn output...
    expect(result.content).toContain('CONFIRM_TARGET');

    // ...the loop did NOT continue: the LLM was called once and never auto-approved.
    expect(llmCallSpy).toHaveBeenCalledTimes(1);
    expect(result.content).not.toContain('LOOP_CONTINUED_WRONGLY');
  });

  it('does NOT halt when the tool result carries no confirmation flag', async () => {
    // A normal (non-gated) tool result must let the loop proceed to a 2nd LLM turn.
    executeToolSpy.mockResolvedValue({ success: true, data: 'done' });

    const result: any = await service.generateMarketingResponse(
      'list my campaigns',
      [],
      'test-user',
      service.default_model,
      'test-session'
    );

    // Loop continued to synthesis: LLM called twice, final text surfaced.
    expect(llmCallSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.content).toContain('LOOP_CONTINUED_WRONGLY');
  });
});
