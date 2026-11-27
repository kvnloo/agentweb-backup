/**
 * ENG-3170 (and ENG-2816 step 3): what a scheduled run of a visitor-marked schedule is held to calling.
 * The checker must not demand a tool the run is forbidden to call (the owner would pay for up to twenty refused attempts), so a tool
 * refused outright is dropped from the required calls. A tool refused only for SOME of its actions (a Google Ads report is allowed, a
 * campaign change is not) stays: the run can still satisfy it with an allowed action.
 */
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../services/db', () => ({ userDb: {} }));

import { requiredCallsForRun } from '../controllers/agentModeController';

const MARKED = { provenance: ['keywords'] };

describe('requiredCallsForRun', () => {
  const required = ['slack_send_message', 'delete_leads', 'save_memory', 'call_google_ads_api', 'email', 'manage_scheduled_chat', 'read_brand_guidelines'];
  const minCalls = { slack_send_message: 2, call_google_ads_api: 3, read_brand_guidelines: 1 };

  it('an unmarked schedule (every schedule that predates this) is held to exactly what it stores', () => {
    const out = requiredCallsForRun({ requiredFunctionCalls: required, functionCallMinCalls: minCalls });
    expect(out).toEqual({ functionCalls: required, minCalls, skipped: [] });
  });

  it('a marked schedule drops what it is refused outright: the block list and the whole-tool sensitive entries', () => {
    const out = requiredCallsForRun({ ...MARKED, requiredFunctionCalls: required, functionCallMinCalls: minCalls });
    expect(out.functionCalls).not.toContain('slack_send_message');
    expect(out.functionCalls).not.toContain('delete_leads');
    expect(out.functionCalls).not.toContain('save_memory');
    expect(out.functionCalls).not.toContain('email'); // refused whatever its action since the third final review (search and get read login codes)
    expect(out.skipped).toEqual(['slack_send_message', 'delete_leads', 'save_memory', 'email']);
    expect(out.minCalls).toEqual({ call_google_ads_api: 3, read_brand_guidelines: 1 });
  });

  it('a marked schedule keeps a tool that is refused only for some actions, and every ordinary tool', () => {
    const out = requiredCallsForRun({ ...MARKED, requiredFunctionCalls: required, functionCallMinCalls: minCalls });
    expect(out.functionCalls).toEqual(['call_google_ads_api', 'manage_scheduled_chat', 'read_brand_guidelines']);
  });
});
