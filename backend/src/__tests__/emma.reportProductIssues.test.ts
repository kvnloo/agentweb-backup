/**
 * report_product_issues enrichment (2026-06-12):
 *  - external MCP calls are tagged "MCP Reported" (in-portal keeps "Customer Reported"
 *    so Rui's benchmark filters stay clean)
 *  - per-issue attachment_urls land in the Featurebase post context
 *  - per-issue run_id pulls the AgentRun dossier (verdict, failed tools,
 *    failedArgsJson) server-side and appends it to the description
 *  - enrichment failure never blocks the report
 */

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn(async () => ({ pageId: 'pg-1', notionUrl: 'https://notion.so/pg-1' })),
}));
const mockCreateFeaturebasePost = jest.fn(async () => ({
  postId: 'fb-1',
  postUrl: 'https://feedback.agentweb.pro/p/fb-1',
  linearIssueUrls: ['https://linear.app/agentweb/issue/ENG-123'],
}));
jest.mock('../services/featurebaseService', () => ({
  createFeaturebasePost: mockCreateFeaturebasePost,
}), { virtual: true });
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn(async () => ({ id: 'em-1' })) },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getJsonArraySetting: jest.fn(async () => ['founders@agentweb.pro']) },
}));
jest.mock('../services/db', () => {
  const actual = jest.requireActual('../services/db');
  return {
    ...actual,
    userDb: { getUserById: jest.fn(async () => ({ userId: 'u-1', email: 'harsha@agentweb.pro', displayName: 'Harsha' })) },
  };
});
jest.mock('../services/agentRunInspectorService', () => {
  const actual = jest.requireActual('../services/agentRunInspectorService');
  return { ...actual, fetchAgentRunSummaries: jest.fn() };
});

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { createOncallItem } from '../services/notionService';
import { fetchAgentRunSummaries } from '../services/agentRunInspectorService';

const tool = () => emmaToolRegistry.getTool('report_product_issues')!;
const lastFeaturebaseCall = (): any => {
  const calls = mockCreateFeaturebasePost.mock.calls as any[][];
  const call = calls[calls.length - 1];
  if (!call) throw new Error('Expected createFeaturebasePost to have been called');
  return call[0];
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateFeaturebasePost.mockResolvedValue({
    postId: 'fb-1',
    postUrl: 'https://feedback.agentweb.pro/p/fb-1',
    linearIssueUrls: ['https://linear.app/agentweb/issue/ENG-123'],
  });
  (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({ runs: [], scannedEvents: 0, truncated: false });
});

describe('report_product_issues source tagging', () => {
  const issue = { title: 'Broken thing', description: 'It broke' };

  it('tags external MCP calls as MCP Reported', async () => {
    await tool().execute({ issues: [issue] }, { userId: 'u-1', externalMcp: true });

    expect(lastFeaturebaseCall().tags).toContain('MCP Reported');
    expect(lastFeaturebaseCall().tags).not.toContain('Customer Reported');
    expect(createOncallItem).not.toHaveBeenCalled();
  });

  it('keeps Customer Reported for in-portal calls (no externalMcp flag)', async () => {
    await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1' });

    expect(lastFeaturebaseCall().tags).toContain('Customer Reported');
    expect(lastFeaturebaseCall().tags).not.toContain('MCP Reported');
    expect(createOncallItem).not.toHaveBeenCalled();
  });
});

describe('report_product_issues attachments', () => {
  it('passes attachment URLs into the Featurebase post context', async () => {
    await tool().execute({
      issues: [{
        title: 'Visual bug',
        description: 'See screenshots',
        attachment_urls: ['https://s3.example.com/a.png', 'https://s3.example.com/b.png'],
      }],
    }, { userId: 'u-1', externalMcp: true });

    const ctx = lastFeaturebaseCall().context;
    expect(ctx['Attachments']).toContain('https://s3.example.com/a.png');
    expect(ctx['Attachments']).toContain('https://s3.example.com/b.png');
    expect(lastFeaturebaseCall().attachmentUrls).toEqual(['https://s3.example.com/a.png', 'https://s3.example.com/b.png']);
  });
});

describe('report_product_issues run-dossier enrichment', () => {
  it('appends the AgentRun dossier to the description when run_id is given', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{
        runId: 'u-1:run:abc',
        sessionId: 'sess-9',
        verdict: 'degraded',
        toolCalls: 8,
        failedToolCalls: 3,
        outcomes: [
          { eventType: 'agent_tool_failed', ts: 't1', toolName: 'linkedin_outreach', errorClass: 'invalid_args', errorMessage: 'Invalid parameters', failedArgsJson: '{"action":"send-invite"}' },
        ],
      }],
      scannedEvents: 100,
      truncated: false,
    });

    await tool().execute({
      issues: [{ title: 'Outreach failing', description: 'Invites die', run_id: 'u-1:run:abc' }],
    }, { userId: 'u-1', externalMcp: true });

    expect(fetchAgentRunSummaries).toHaveBeenCalledWith(expect.objectContaining({ runId: 'u-1:run:abc' }));
    const description: string = lastFeaturebaseCall().description;
    expect(description).toContain('Invites die');
    expect(description).toContain('linkedin_outreach');
    expect(description).toContain('invalid_args');
    expect(description).toContain('{"action":"send-invite"}');
    expect(description.toLowerCase()).toContain('degraded');
  });

  it('still files the report when run enrichment fails', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockRejectedValue(new Error('dynamo down'));

    const result = await tool().execute({
      issues: [{ title: 'Bug', description: 'desc', run_id: 'u-1:run:gone' }],
    }, { userId: 'u-1', externalMcp: true });

    expect(createOncallItem).not.toHaveBeenCalled();
    expect(mockCreateFeaturebasePost).toHaveBeenCalledTimes(1);
    expect(lastFeaturebaseCall().description).toContain('desc');
    expect(JSON.stringify(result)).toContain('fb-1');
  });

  it('omits the dossier when the run is not found', async () => {
    await tool().execute({
      issues: [{ title: 'Bug', description: 'plain', run_id: 'u-1:run:missing' }],
    }, { userId: 'u-1', externalMcp: true });

    expect(lastFeaturebaseCall().description).toBe('plain');
  });
});
