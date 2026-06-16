/**
 * Dispatch-specific characterization snapshots for the AgentMode core loop.
 *
 * These exercise the tool-DISPATCH boundary specifically (Seam: tool dispatch),
 * the paths the generic happy/error/no-tool snapshots do not cover:
 *   (a) parallel multi-tool batch in one turn
 *   (b) sequential path (wait_seconds forces in-order execution)
 *   (c) a tool error mid-batch (one fails, one succeeds, same turn)
 *   (d) a large tool result that triggers the S3-offload branch (S3 uploader stubbed)
 *
 * They are the behavior-preserving proof for the dispatch extraction into
 * core/toolDispatch.ts: the same snapshots pass UNCHANGED before and after the
 * monolith delegates to executePreparedTools.
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
// S3 utils — stub the uploaders so the large-response offload branch is observable
// and deterministic (no network). uploadFileToS3WithPath returns a fixed key.
jest.mock('../../../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
  uploadFileToS3WithPath: jest.fn().mockResolvedValue({ success: true, key: 'tool-responses/test-session/offloaded.txt' }),
  uploadScreenshotToS3: jest.fn().mockResolvedValue({ url: 'https://s3.example/shot.png' }),
  getS3ObjectAsString: jest.fn(),
}));

describe('AgentMode core loop — tool-dispatch characterization snapshots', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  it('(a) parallel multi-tool batch — two tools in one turn, both succeed, original order preserved', async () => {
    const snapshot = await runScenario(service, {
      message: 'Pull brand and market data together.',
      transcript: [
        {
          tool_calls: [
            { id: 'p1', name: 'read_brand_guidelines', arguments: '{}' },
            { id: 'p2', name: 'read_market_strategy', arguments: '{"scope":"summary"}' },
          ],
        },
        { content: 'Here is the combined summary.' },
      ],
      toolResults: {
        read_brand_guidelines: { result: JSON.stringify({ success: true, brand: 'Acme' }) },
        read_market_strategy: { result: JSON.stringify({ success: true, strategy: 'ICP-1' }) },
      },
    });

    const expected: BehaviorSnapshot = {
      content: 'Here is the combined summary.',
      toolCallSequence: [
        { name: 'read_brand_guidelines', arguments: {}, outcome: 'success' },
        { name: 'read_market_strategy', arguments: { scope: 'summary' }, outcome: 'success' },
      ],
      llmTurnsConsumed: 2,
      responseMessageShape: [
        { role: 'assistant' },
        { role: 'tool', name: 'read_brand_guidelines' },
        { role: 'tool', name: 'read_market_strategy' },
        { role: 'assistant' },
      ],
      cancelled: false,
    };
    expect(snapshot).toEqual(expected);
  });

  it('(b) sequential path — wait_seconds in the batch forces ordered execution', async () => {
    const snapshot = await runScenario(service, {
      message: 'Read brand, wait, then read market.',
      transcript: [
        {
          tool_calls: [
            { id: 's1', name: 'read_brand_guidelines', arguments: '{}' },
            { id: 's2', name: 'wait_seconds', arguments: '{"seconds":0}' },
            { id: 's3', name: 'read_market_strategy', arguments: '{}' },
          ],
        },
        { content: 'Done waiting and reading.' },
      ],
      toolResults: {
        read_brand_guidelines: { result: JSON.stringify({ success: true }) },
        wait_seconds: { result: JSON.stringify({ success: true, waited: 0 }) },
        read_market_strategy: { result: JSON.stringify({ success: true }) },
      },
    });

    const expected: BehaviorSnapshot = {
      content: 'Done waiting and reading.',
      toolCallSequence: [
        { name: 'read_brand_guidelines', arguments: {}, outcome: 'success' },
        { name: 'wait_seconds', arguments: { seconds: 0 }, outcome: 'success' },
        { name: 'read_market_strategy', arguments: {}, outcome: 'success' },
      ],
      llmTurnsConsumed: 2,
      responseMessageShape: [
        { role: 'assistant' },
        { role: 'tool', name: 'read_brand_guidelines' },
        { role: 'tool', name: 'wait_seconds' },
        { role: 'tool', name: 'read_market_strategy' },
        { role: 'assistant' },
      ],
      cancelled: false,
    };
    expect(snapshot).toEqual(expected);
  });

  it('(c) tool error mid-batch — one tool fails, one succeeds, in the same turn', async () => {
    // executeTool is keyed by tool name in the harness; make read_market_strategy
    // throw while read_brand_guidelines succeeds.
    const snapshot = await runScenario(service, {
      message: 'Pull both; one will fail.',
      transcript: [
        {
          tool_calls: [
            { id: 'e1', name: 'read_brand_guidelines', arguments: '{}' },
            { id: 'e2', name: 'read_market_strategy', arguments: '{}' },
          ],
        },
        { content: 'Brand read; market failed.' },
      ],
      toolResults: {
        read_brand_guidelines: { result: JSON.stringify({ success: true, brand: 'Acme' }) },
        read_market_strategy: { error: 'boom: market read failed' },
      },
    });

    const expected: BehaviorSnapshot = {
      content: 'Brand read; market failed.',
      toolCallSequence: [
        { name: 'read_brand_guidelines', arguments: {}, outcome: 'success' },
        { name: 'read_market_strategy', arguments: {}, outcome: 'error' },
      ],
      llmTurnsConsumed: 2,
      responseMessageShape: [
        { role: 'assistant' },
        { role: 'tool', name: 'read_brand_guidelines' },
        { role: 'tool', name: 'read_market_strategy' },
        { role: 'assistant' },
      ],
      cancelled: false,
    };
    expect(snapshot).toEqual(expected);
  });

  it('(d) large tool result — triggers the S3-offload branch (uploader stubbed)', async () => {
    const s3Utils = require('../../../utils/s3Utils');
    // A result string well over the 10KB S3 threshold.
    const bigPayload = 'X'.repeat(15_000);

    const snapshot = await runScenario(service, {
      message: 'Read a very large page.',
      transcript: [
        {
          tool_calls: [
            { id: 'd1', name: 'read_market_strategy', arguments: '{}' },
          ],
        },
        { content: 'Summarized the large page.' },
      ],
      toolResults: {
        // Return a plain string result so extractToolContent yields the raw string,
        // which exceeds the threshold and triggers the offload upload.
        read_market_strategy: { result: bigPayload },
      },
    });

    // The offload uploader must have been called once for the large response.
    expect(s3Utils.uploadFileToS3WithPath).toHaveBeenCalledTimes(1);

    // Observable contract is unchanged: same sequence + final content.
    expect(snapshot.content).toBe('Summarized the large page.');
    expect(snapshot.toolCallSequence).toEqual([
      { name: 'read_market_strategy', arguments: {}, outcome: 'success' },
    ]);
    expect(snapshot.llmTurnsConsumed).toBe(2);
    expect(snapshot.responseMessageShape).toEqual([
      { role: 'assistant' },
      { role: 'tool', name: 'read_market_strategy' },
      { role: 'assistant' },
    ]);
  });
});
