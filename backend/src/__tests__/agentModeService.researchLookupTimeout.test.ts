import axios from 'axios';
import { getSecret } from '../utils/secretsManager';

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn() },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

import { AgentModeService } from '../services/agentModeService';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
  getS3ObjectAsString: jest.fn(),
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(),
}));

void axios;
void getSecret;

/**
 * ENG-43: Research / external-lookup tool calls time out and abandon the goal
 * instead of degrading gracefully. When a research/external-lookup tool
 * (you_search_web, you_search_news, google_search_web, perform_deep_research)
 * times out, formatToolError must return graceful-degradation guidance —
 * keep partial results, decompose multi-entity queries per entity, and fall
 * back to an alternate provider — NOT a blanket "ask the user to retry".
 */
describe('formatToolError — research/external-lookup timeout graceful degradation (ENG-43)', () => {
  let svc: AgentModeService;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new AgentModeService();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const RESEARCH_TOOLS = [
    'you_search_web',
    'you_search_news',
    'google_search_web',
    'perform_deep_research',
  ];

  const TIMEOUT_MESSAGES = [
    'timeout of 120000ms exceeded',
    'The request timed out',
    'ETIMEDOUT',
    'socket hang up',
    'Request failed with status code 504',
    'service temporarily unavailable',
  ];

  it.each(RESEARCH_TOOLS)(
    'returns degradation guidance (not a blanket retry) when %s times out',
    (toolName) => {
      const result = (svc as any).formatToolError(toolName, 'timeout of 120000ms exceeded');
      // Must instruct the model to keep partial results and decompose per entity.
      expect(result).toMatch(/partial/i);
      expect(result).toMatch(/per[- ]entity|each entity|decompose|one .*sub-?quer/i);
      // Must NOT be the opaque "adjust the plan / ask the user for missing info" fallback,
      // and must not merely tell the user to try again.
      expect(result).not.toContain('Adjust the plan or ask the user for missing info');
    }
  );

  it.each(TIMEOUT_MESSAGES)(
    'detects timeout/transient signal "%s" for you_search_web',
    (message) => {
      const result = (svc as any).formatToolError('you_search_web', message);
      expect(result).toMatch(/partial/i);
      expect(result).toMatch(/fall ?back|alternate/i);
    }
  );

  it('mentions falling back to an alternate search provider', () => {
    const result = (svc as any).formatToolError('you_search_web', 'ETIMEDOUT');
    expect(result).toMatch(/google_search_web|alternate search/i);
  });

  it('does NOT hijack non-timeout failures of research tools (e.g. quota with a clear reason)', () => {
    const result = (svc as any).formatToolError('you_search_web', 'Invalid API key');
    expect(result).not.toMatch(/partial results/i);
  });

  it('does NOT apply research-degradation guidance to unrelated tools on timeout', () => {
    // perform_data_analysis has its own timeout branch — keep it intact.
    const result = (svc as any).formatToolError('perform_data_analysis', 'timeout of 1200000ms exceeded');
    expect(result).toContain('smaller pieces');
    expect(result).not.toMatch(/alternate search|google_search_web/i);
  });
});
