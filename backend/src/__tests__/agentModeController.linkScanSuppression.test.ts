import { isCleanLinkScanSession } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';

jest.mock('../services/chatbotService', () => ({
  ...jest.requireActual('../services/chatbotService'),
  chatbotDb: { getChatSession: jest.fn() },
}));

const getChatSession = chatbotDb.getChatSession as jest.Mock;
const scan = (overrides: Record<string, unknown> = {}) => ({
  role: 'tool',
  name: 'scan_website_links',
  content: JSON.stringify({
    success: true, brokenLinkCount: 0, unverifiableLinkCount: 0, robotsSkipped: [],
    truncated: false, deadlineExceeded: false, ...overrides,
  }),
});

const ok = { status: 'success', passed: true };

describe('isCleanLinkScanSession — scheduled email/digest gate (ENG-1098)', () => {
  beforeEach(() => getChatSession.mockReset());

  it('suppresses (true) only for a session whose executed ledger holds one clean scan', async () => {
    getChatSession.mockResolvedValue({ messages: [scan()] });
    await expect(isCleanLinkScanSession('s-clean', ok)).resolves.toBe(true);
    expect(getChatSession).toHaveBeenCalledWith('s-clean');
  });

  it('sends (false) when the scan found broken links', async () => {
    getChatSession.mockResolvedValue({ messages: [scan({ brokenLinkCount: 2 })] });
    await expect(isCleanLinkScanSession('s-broken', ok)).resolves.toBe(false);
  });

  it('fails open (false) when the session cannot be loaded or is missing', async () => {
    getChatSession.mockRejectedValue(new Error('DynamoDB timeout'));
    await expect(isCleanLinkScanSession('s-err', ok)).resolves.toBe(false);
    getChatSession.mockResolvedValue(null);
    await expect(isCleanLinkScanSession('s-missing', ok)).resolves.toBe(false);
    await expect(isCleanLinkScanSession('', ok)).resolves.toBe(false);
  });

  it('sends (false) for a clean scan when the run itself failed or did not pass', async () => {
    getChatSession.mockResolvedValue({ messages: [scan()] });
    await expect(isCleanLinkScanSession('s-fail', { status: 'failure', passed: false })).resolves.toBe(false);
    await expect(isCleanLinkScanSession('s-miss', { status: 'success', passed: false })).resolves.toBe(false);
    await expect(isCleanLinkScanSession('s-none', undefined)).resolves.toBe(false);
  });
});
