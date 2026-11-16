/**
 * report_product_issues enrichment (2026-06-12):
 *  - external MCP calls are tagged "MCP Reported" (in-portal keeps "Customer Reported"
 *    so Rui's benchmark filters stay clean)
 *  - per-issue attachment_urls land in the Notion item context
 *  - per-issue run_id pulls the AgentRun dossier (verdict, failed tools,
 *    failedArgsJson) server-side and appends it to the description
 *  - enrichment failure never blocks the report
 */

// ENG-2817: the Notion fallback is gone; fileUserIssue is stubbed so these suites keep asserting
// the payload the caller hands to the intake service (title/description/tags/context).
const mockFileToTracker = jest.fn(async (_item: any): Promise<any> => ({ pageId: 'pg-1', notionUrl: 'https://notion.so/pg-1' }));
jest.mock('../services/intakeService', () => ({
  ...jest.requireActual('../services/intakeService'),
  fileUserIssue: jest.fn(async (p: any) => {
    const o = await mockFileToTracker({
      title: p.title,
      description: p.description,
      additionalTags: p.notionTags || ['Customer Reported'],
      context: p.notionContext,
    });
    return { pageId: o.pageId, trackerUrl: o.notionUrl, deduped: false, tracker: 'Featurebase' };
  }),
}));

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
import { fetchAgentRunSummaries } from '../services/agentRunInspectorService';

const tool = () => emmaToolRegistry.getTool('report_product_issues')!;
const lastOncallCall = () => mockFileToTracker.mock.calls.at(-1)![0];

beforeEach(() => {
  jest.clearAllMocks();
  (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({ runs: [], scannedEvents: 0, truncated: false });
});

describe('report_product_issues source tagging', () => {
  const issue = { title: 'Broken thing', description: 'It broke' };

  it('tags external MCP calls as MCP Reported', async () => {
    await tool().execute({ issues: [issue] }, { userId: 'u-1', externalMcp: true });

    expect(lastOncallCall().additionalTags).toContain('MCP Reported');
    expect(lastOncallCall().additionalTags).not.toContain('Customer Reported');
  });

  it('keeps Customer Reported for in-portal calls (no externalMcp flag)', async () => {
    await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1' });

    expect(lastOncallCall().additionalTags).toContain('Customer Reported');
    expect(lastOncallCall().additionalTags).not.toContain('MCP Reported');
  });
});

describe('report_product_issues attachments', () => {
  it('passes attachment URLs into the Notion item context', async () => {
    await tool().execute({
      issues: [{
        title: 'Visual bug',
        description: 'See screenshots',
        attachment_urls: ['https://s3.example.com/a.png', 'https://s3.example.com/b.png'],
      }],
    }, { userId: 'u-1', externalMcp: true });

    const ctx = lastOncallCall().context;
    expect(ctx['Attachments']).toContain('https://s3.example.com/a.png');
    expect(ctx['Attachments']).toContain('https://s3.example.com/b.png');
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
    const description: string = lastOncallCall().description;
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

    expect(mockFileToTracker).toHaveBeenCalledTimes(1);
    expect(lastOncallCall().description).toContain('desc');
    expect(JSON.stringify(result)).toContain('pg-1');
  });

  it('omits the dossier when the run is not found', async () => {
    await tool().execute({
      issues: [{ title: 'Bug', description: 'plain', run_id: 'u-1:run:missing' }],
    }, { userId: 'u-1', externalMcp: true });

    expect(lastOncallCall().description).toBe('plain');
  });
});
