/**
 * ENG-289: the internal Linear canonical link is eng-facing. Two halves of the invariant:
 *   1. Leak guard — it must NEVER reach an external customer or ANY external-MCP caller via the
 *      results[] array (serialized verbatim to external MCP clients + preserved into Agent Mode LLM
 *      context / persisted sidebar state).
 *   2. Admin visibility — an admin or delegated-admin session gets the canonical link back IN THE CHAT
 *      MESSAGE (deterministically, not just parked in results[]) so they can track the eng issue.
 * The internal notification email always carries the link regardless of who reported.
 * NOTE: a plain @agentweb.pro reporter who is NOT an admin does NOT get the link — the gate is
 * strictly isAdmin || delegated-admin.
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
const asAgentwebNonAdmin = () => (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'u-1', email: 'harsha@agentweb.pro', displayName: 'Harsha' });

beforeEach(() => jest.clearAllMocks());

describe('report_product_issues canonical link exposure', () => {
  const issue = { title: 'Landing page builder keeps failing', description: 'v0 side failure' };

  it('external customer: canonical link is NOT in the tool result or chat message', async () => {
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

  it('external-MCP caller who is ALSO an admin: still NOT exposed (leak guard wins)', async () => {
    asAdmin();
    const result = await tool().execute({ issues: [issue] }, { userId: 'u-1', externalMcp: true });
    expect(JSON.stringify(result)).not.toContain('linear.app');
  });

  it('plain @agentweb.pro reporter (non-admin): canonical link is NOT exposed', async () => {
    asAgentwebNonAdmin();
    const result: any = await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1' });
    expect(result.message).not.toContain('linear.app');
    expect(JSON.stringify(result.results)).not.toContain('linear.app');
  });

  it('admin reporter: canonical link IS in the chat message (and results)', async () => {
    asAdmin();
    const result: any = await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1' });
    expect(result.message).toContain(CANON);
    expect(JSON.stringify(result.results)).toContain(CANON);
  });

  it('delegated-admin session: canonical link IS in the chat message', async () => {
    asExternalCustomer(); // req.user is the target customer, but a teammate is driving the session
    const result: any = await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1', isDelegatedAdmin: true, adminEmail: 'harsha@agentweb.pro' });
    expect(result.message).toContain(CANON);
  });

  it('always includes the canonical link in the internal notification email, even for an external customer', async () => {
    asExternalCustomer();
    await tool().execute({ issues: [issue] }, { userId: 'u-1', sessionId: 'sess-1' });
    const emailHtml = (resendService.sendEmail as jest.Mock).mock.calls.at(-1)![0].html as string;
    expect(emailHtml).toContain(CANON);
  });
});
