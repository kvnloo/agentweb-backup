/**
 * ENG-187 — Emma's report_product_issues tool threads the reporter's funnelStatus into the shared
 * intake service (which owns the Linear-side triage enrichment). intakeService is mocked; the
 * enrichment behavior itself is covered in intakeService.funnelTriage.test.ts.
 */
jest.mock('../services/intakeService', () => ({
  fileUserIssue: jest.fn(async () => ({
    pageId: '7', trackerUrl: 'https://fb/t/7', userUrl: 'https://fb/t/7', deduped: false, tracker: 'Featurebase',
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
    userDb: { getUserById: jest.fn() },
  };
});

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { fileUserIssue } from '../services/intakeService';
import { userDb } from '../services/db';

const tool = () => emmaToolRegistry.getTool('report_product_issues')!;
const OLD_FLAG = process.env.FEATUREBASE_INTAKE;

beforeAll(() => { process.env.FEATUREBASE_INTAKE = 'true'; });
afterAll(() => { process.env.FEATUREBASE_INTAKE = OLD_FLAG; });
beforeEach(() => jest.clearAllMocks());

describe('report_product_issues — funnelStatus threading (ENG-187)', () => {
  it('passes the reporter user record funnelStatus through to fileUserIssue', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'u-1', email: 'c@example.com', displayName: 'C',
      funnelStatus: 'account_setup',
    });
    const result = await tool().execute(
      { issues: [{ title: 'Broken thing', description: 'It broke', type: 'bug' }] },
      { userId: 'u-1', sessionId: 'sess-1' },
    );
    expect(result.success).toBe(true);
    expect(fileUserIssue).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bug',
      funnelStatus: 'account_setup',
    }));
  });

  it('passes funnelStatus as undefined when the user record has none', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u-1', email: 'c@example.com', displayName: 'C' });
    await tool().execute(
      { issues: [{ title: 'Another thing', description: 'd', type: 'feature_request' }] },
      { userId: 'u-1' },
    );
    expect(fileUserIssue).toHaveBeenCalledWith(expect.objectContaining({
      type: 'feature_request',
      funnelStatus: undefined,
    }));
  });
});
