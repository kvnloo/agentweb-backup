/**
 * ENG-1131 — dispatch-boundary proof.
 *
 * A unit test on `extractMinimalToolResult`'s return value cannot see what the
 * dispatcher does to it. `linkedin_outreach` raises the ENG-975 people-search
 * outage with `success: false`, which the dispatcher downgrades to a tool ERROR —
 * a path that rewrites the ledger entry and strips structured fields. So the claim
 * that survives review is not "the minimizer keeps the flag", it is "the flag is
 * still on `result.toolCalls` after a REAL dispatch, where the scheduled-run
 * recorder reads it".
 *
 * This drives the real `generateMarketingResponse` loop (scripted LLM turns, mocked
 * leaf tool execution — the gateway, policy eval, downgrade and ledger append all
 * run for real) and then feeds the resulting ledger to the real
 * `detectRunBlockedReason` the scheduled runner uses.
 */

import { AgentModeService } from '../../services/agentModeService';
import { runScenarioWithResult, installStandardMockDeps } from './characterization/harness';

// Standard agentMode mock block (module-hoisted — must live in the test file).
jest.mock('openai');
jest.mock('../../services/settingsService');
jest.mock('../../services/db');
jest.mock('../../services/chatbotService');
jest.mock('../../utils/secretsManager');
jest.mock('../../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
  getAllowedFunctionCalls: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
  uploadFileToS3WithPath: jest.fn().mockResolvedValue({ success: true, key: 'k' }),
  uploadScreenshotToS3: jest.fn().mockResolvedValue({ url: 'https://s3.example/shot.png' }),
  getS3ObjectAsString: jest.fn(),
}));
jest.mock('../../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn() },
}));

import {
  detectRunBlockedReason,
  LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON,
} from '../../controllers/agentModeController';

// The exact shape linkedInSearchUnavailableResponse() returns once the ENG-975
// broad control query has PROVEN the account cannot search.
const OUTAGE_RESULT = {
  success: false,
  message: 'LinkedIn people search is unavailable',
  error:
    'LinkedIn returned zero results for a maximally broad control query on this account, ' +
    'so the people-search endpoint is NOT working for it right now.',
  searchUnavailable: true,
};

describe('LinkedIn search-outage marker survives dispatch into the run ledger (ENG-1131)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  it('keeps searchUnavailable on the ledger even though the call is downgraded to an error', async () => {
    const { result } = await runScenarioWithResult(service, {
      message: 'Find DTC apparel founders in California and send connection requests.',
      transcript: [
        {
          tool_calls: [
            {
              id: 'c1',
              name: 'linkedin_outreach',
              arguments: JSON.stringify({ action: 'search_people', keywords: 'DTC apparel founder' }),
            },
          ],
        },
        { content: 'LinkedIn search is currently unavailable for your account, so no prospects were sourced.' },
      ],
      toolResults: { linkedin_outreach: { result: OUTAGE_RESULT } },
    });

    const entry = (result.toolCalls || []).find((c: any) => c.name === 'linkedin_outreach');
    expect(entry).toBeDefined();
    // Downgraded to an error by the dispatcher (success:false) …
    expect(entry.error).toBeTruthy();
    // … but the outage marker still reaches the recorder.
    expect(entry.result).toMatchObject({ searchUnavailable: true });
    expect(detectRunBlockedReason(result.toolCalls)).toBe(LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON);
  });

  it('does not flag a run whose linkedin_outreach calls all worked', async () => {
    const { result } = await runScenarioWithResult(service, {
      message: 'Find DTC apparel founders in California.',
      transcript: [
        {
          tool_calls: [
            {
              id: 'c1',
              name: 'linkedin_outreach',
              arguments: JSON.stringify({ action: 'search_people', keywords: 'DTC apparel founder' }),
            },
          ],
        },
        { content: 'Found 12 matching founders.' },
      ],
      toolResults: {
        linkedin_outreach: { result: { success: true, data: { items: [{ provider_id: 'p1' }] } } },
      },
    });

    expect(detectRunBlockedReason(result.toolCalls)).toBeNull();
  });

  it('does not flag a run whose search legitimately matched nobody', async () => {
    // The ENG-975 control probe answered `ok`, so no marker is stamped: this is a
    // true empty and must keep reading as one.
    const { result } = await runScenarioWithResult(service, {
      message: 'Find left-handed underwater basket weavers in Antarctica.',
      transcript: [
        {
          tool_calls: [
            {
              id: 'c1',
              name: 'linkedin_outreach',
              arguments: JSON.stringify({ action: 'search_people', keywords: 'nobody' }),
            },
          ],
        },
        { content: 'No one matched those filters.' },
      ],
      toolResults: {
        linkedin_outreach: { result: { success: true, data: { items: [], total_count: 0 } } },
      },
    });

    expect(detectRunBlockedReason(result.toolCalls)).toBeNull();
  });
});
