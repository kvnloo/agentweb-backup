/**
 * ENG-289: the internal Linear canonical link is eng-facing. The invariant has two halves:
 *   1. Leak guard — it must NEVER reach an external customer or ANY external-MCP caller via the
 *      results[] array (that array is JSON.stringified verbatim to external MCP clients and preserved
 *      into Agent Mode LLM context + persisted sidebar state).
 *   2. Desired behavior #1 — an INTERNAL submitter (admin, delegated-admin session, or an @agentweb.pro
 *      reporter) DOES get the canonical link back in the tool result, so the person who filed the bug
 *      gets an immediate, clickable Linear confirmation.
 * The internal notification email always carries the link regardless of who reported.
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
import { userDb } from '../services/db';

const tool = () => emmaToolRegistry.getTool('report_product_issues')!;
const CANON = 'https://linear.app/emmabyaw/issue/ENG-289';
const asExternalCustomer = () => (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'u-1', email: 'matthew@rankai.com', displayName: 'Matthew' });
const asAdmin = () => (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'u-1', email: 'ops@rankai.com', displayName: 'Ops', isAdmin: true });
const asAgentwebReporter = () => (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'u-1', email: 'harsha@agentweb.pro', displayName: 'Harsha' });

beforeEach(() => jest.clearAllMocks());

describe('report_product_issues canonical link exposure', () => {
  const issue = { title: 'Landing page builder keeps failing', description: 'v0 side failure' };

  it('external customer: canonical link is NOT in the tool result', async () => {
    asExternalCustomer();
    const result = await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1' });
    expect(JSON.stringify(result)).not.toContain('linear.app');
    expect(JSON.stringify(result)).not.toContain('ENG-289');
  });

  it('external-MCP caller: canonical link is NOT in the tool result (leak guard)', async () => {
    asExternalCustomer();
    const result = await tool().execute({ issues: [issue] }, { userId: 'u-1', externalMcp: true });
    expect(JSON.stringify(result)).not.toContain('linear.app');
  });

  it('external-MCP caller who is ALSO an admin: still NOT in the tool result (leak guard wins)', async () => {
    asAdmin();
    const result = await tool().execute({ issues: [issue] }, { userId: 'u-1', externalMcp: true });
    expect(JSON.stringify(result)).not.toContain('linear.app');
  });

  it('internal admin reporter: canonical link IS returned in the tool result (Desired behavior #1)', async () => {
    asAdmin();
    const result = await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1' });
    expect(JSON.stringify(result)).toContain(CANON);
  });

  it('internal @agentweb.pro reporter: canonical link IS returned in the tool result', async () => {
    asAgentwebReporter();
    const result = await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1' });
    expect(JSON.stringify(result)).toContain(CANON);
  });

  it('delegated-admin session: canonical link IS returned in the tool result', async () => {
    asExternalCustomer(); // req.user is the target customer, but a teammate is driving the session
    const result = await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1', isDelegatedAdmin: true, adminEmail: 'harsha@agentweb.pro' });
    expect(JSON.stringify(result)).toContain(CANON);
  });

  it('always includes the canonical link in the internal notification email, even for an external customer', async () => {
    asExternalCustomer();
    await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1' });
    const emailHtml = (resendService.sendEmail as jest.Mock).mock.calls.at(-1)![0].html as string;
    expect(emailHtml).toContain(CANON);
  });
});
