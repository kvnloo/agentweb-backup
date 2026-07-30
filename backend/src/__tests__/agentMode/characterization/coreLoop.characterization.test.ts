/**
 * Characterization snapshots for the AgentMode core loop.
 *
 * These PIN the observable behavior of the REAL `generateMarketingResponse` for
 * three canonical paths. They are the behavior-preserving proof for every seam
 * extraction in the monolith→agentic-core migration: the same snapshots must
 * pass UNCHANGED before and after each extraction.
 *
 * Run order of proof:
 *   1. These pass against the UNCHANGED monolith  -> proves the harness captures real behavior.
 *   2. Extract a seam (e.g. termination decision into core/termination.ts).
 *   3. These STILL pass, byte-identical              -> proves the extraction is behavior-preserving.
 */

import { AgentModeService } from '../../../services/agentModeService';
import {
  runScenario,
  installStandardMockDeps,
  type BehaviorSnapshot,
} from './harness';

// Standard agentMode mock block (module-hoisted — must live in the test file).
jest.mock('openai');
jest.mock('../../../services/settingsService');
jest.mock('../../../services/db');
jest.mock('../../../services/chatbotService');
jest.mock('../../../utils/secretsManager');
jest.mock('../../../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

describe('AgentMode core loop — characterization snapshots', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  it('(a) happy path — one tool-call iteration then a final text response', async () => {
    const snapshot = await runScenario(service, {
      message: 'Pull my brand info and summarize it.',
      transcript: [
        {
          tool_calls: [
            { id: 'call-a1', name: 'read_brand_guidelines', arguments: '{}' },
          ],
        },
        { content: 'Your brand is focused on B2B SaaS marketing.' },
      ],
      toolResults: {
        read_brand_guidelines: {
          result: JSON.stringify({ success: true, brand: 'Acme', industry: 'B2B SaaS' }),
        },
      },
    });

    const expected: BehaviorSnapshot = {
      content: 'Your brand is focused on B2B SaaS marketing.',
      toolCallSequence: [
        { name: 'read_brand_guidelines', arguments: {}, outcome: 'success' },
      ],
      llmTurnsConsumed: 2,
      responseMessageShape: [
        { role: 'assistant' },
        { role: 'tool', name: 'read_brand_guidelines' },
        { role: 'assistant' },
      ],
      cancelled: false,
    };
    expect(snapshot).toEqual(expected);
  });

  it('(b) tool error then retry with fixed args — error is recorded, recovery succeeds', async () => {
    const snapshot = await runScenario(service, {
      message: 'Read my market strategy.',
      transcript: [
        // iter 1: tool call that the leaf execution will fail
        {
          tool_calls: [
            { id: 'call-b1', name: 'read_market_strategy', arguments: '{"scope":"all"}' },
          ],
        },
        // iter 2: model retries with corrected args; this one succeeds
        {
          tool_calls: [
            { id: 'call-b2', name: 'read_market_strategy', arguments: '{"scope":"summary"}' },
          ],
        },
        // iter 3: final synthesis
        { content: 'Here is your market strategy summary.' },
      ],
      toolResults: {
        // keyed by tool name: both calls hit the same key. To make the FIRST fail
        // and the SECOND succeed we use a stateful mock below via call args.
        read_market_strategy: { result: JSON.stringify({ success: true, summary: 'Grow ICP-1' }) },
      },
    });

    // Both calls share a tool name, so with a single keyed mock both succeed; to
    // characterize the error→retry path we assert the SEQUENCE shape and that the
    // final content is the synthesis. (A per-call-id error variant is covered by
    // the dedicated assertion below.)
    expect(snapshot.content).toBe('Here is your market strategy summary.');
    expect(snapshot.toolCallSequence.map((t) => t.name)).toEqual([
      'read_market_strategy',
      'read_market_strategy',
    ]);
    expect(snapshot.llmTurnsConsumed).toBe(3);
  });

  it('(b2) tool error path — a failing tool is recorded as outcome:error and the model recovers', async () => {
    // Make the FIRST call fail and the SECOND succeed by switching the keyed mock
    // between turns. We drive this by spying executeTool with a call-count toggle.
    let call = 0;
    jest.spyOn(service as any, 'executeTool').mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('boom: invalid scope');
      return JSON.stringify({ success: true, summary: 'Grow ICP-1' });
    });
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);
    const callLLMSpy = jest.spyOn(service as any, 'callLLM');
    callLLMSpy
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'read_market_strategy', arguments: '{"scope":"bad"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'c2', type: 'function', function: { name: 'read_market_strategy', arguments: '{"scope":"summary"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        choices: [
          { message: { role: 'assistant', content: 'Recovered and here is the summary.', tool_calls: null }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

    const result = await service.generateMarketingResponse(
      'Read my market strategy.',
      [],
      'test-user',
      service.default_model,
      'test-session',
    );

    expect(result.content).toBe('Recovered and here is the summary.');
    expect(result.toolCalls.map((t: any) => ({ name: t.name, outcome: t.error ? 'error' : 'success' }))).toEqual([
      { name: 'read_market_strategy', outcome: 'error' },
      { name: 'read_market_strategy', outcome: 'success' },
    ]);
    expect(callLLMSpy).toHaveBeenCalledTimes(3);
  });

  it('(c) no-tool single response — model answers directly, loop exits after one turn', async () => {
    const snapshot = await runScenario(service, {
      message: 'Say hello.',
      transcript: [{ content: 'Hello! How can I help with your marketing today?' }],
    });

    const expected: BehaviorSnapshot = {
      content: 'Hello! How can I help with your marketing today?',
      toolCallSequence: [],
      llmTurnsConsumed: 1,
      responseMessageShape: [{ role: 'assistant' }],
      cancelled: false,
    };
    expect(snapshot).toEqual(expected);
  });
});
