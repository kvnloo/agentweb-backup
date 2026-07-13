/**
 * Regression guard (ENG-289): the internal Linear canonical link is eng-facing only
 * ("Never shown to the customer"). report_product_issues must keep it OUT of the
 * results[] array — that array is JSON.stringified verbatim to external MCP clients
 * and preserved into Agent Mode LLM context + persisted sidebar state — while STILL
 * surfacing it in the internal notification email.
 */

jest.mock('../services/intakeService', () => ({
  fileUserIssue: jest.fn(async () => ({
    pageId: '1234',
    trackerUrl: 'https://featurebase.example/post/1234',
    userUrl: 'https://featurebase.example/post/1234',
    canonicalUrl: 'https://linear.app/emmabyaw/issue/ENG-289',
    deduped: false,
    tracker: 'Featurebase',
  })),
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
    userDb: { getUserById: jest.fn(async () => ({ userId: 'u-1', email: 'matthew@rankai.com', displayName: 'Matthew' })) },
  };
});

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { resendService } from '../services/resendService';

const tool = () => emmaToolRegistry.getTool('report_product_issues')!;

beforeEach(() => jest.clearAllMocks());

describe('report_product_issues canonical link exposure', () => {
  const issue = { title: 'Landing page builder keeps failing', description: 'v0 side failure' };

  it('never returns the internal Linear canonical link in the tool result', async () => {
    const result = await tool().execute({ issues: [issue] }, { userId: 'u-1', externalMcp: true });
    expect(JSON.stringify(result)).not.toContain('linear.app');
    expect(JSON.stringify(result)).not.toContain('ENG-289');
  });

  it('still includes the canonical link in the internal notification email', async () => {
    await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1' });
    const emailHtml = (resendService.sendEmail as jest.Mock).mock.calls.at(-1)![0].html as string;
    expect(emailHtml).toContain('https://linear.app/emmabyaw/issue/ENG-289');
  });
});
