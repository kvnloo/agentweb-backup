/**
 * ENG-1552 / ENG-1825 regression: a scheduled report withheld for lack of an authorized
 * recipient must land on ONE canonical Linear defect, not a fresh issue per schedule per day.
 *
 * Runs the real chain end to end — sendScheduledChatResultEmail → sendAgentModeOncallAlert →
 * sendOncallAlert → intakeService.fileAutoIssue — against a stateful fake of Linear, so the
 * assertion is about what Linear would actually hold, not about which helper was called.
 */
import { emailService, WITHHELD_REPORT_ALERT_CLASS } from '../services/emailService';
import { chatbotDb } from '../services/chatbotService';
import { userDb } from '../services/db';
import { __resetAgentModeAlertDedupeForTests } from '../utils/agentModeAlerts';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionInteractiveShareMetadata: jest.fn().mockResolvedValue(undefined),
    getChatSession: jest.fn(),
    getChatSessionRecord: jest.fn(),
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://app/share/SECRET'),
  },
}));

jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn(), getUserById: jest.fn() },
}));

// Stateful fake Linear: created issues become "open" and are visible to the next dedup lookup.
const linearState: { issues: Array<{ issueId: string; identifier: string; title: string; description: string }> } = { issues: [] };
const createInternalLinearIssue = jest.fn(async ({ title, description }: { title: string; description: string }) => {
  const n = linearState.issues.length + 1;
  const issue = { issueId: `id-${n}`, identifier: `ENG-${9000 + n}`, title, description };
  linearState.issues.push(issue);
  return { identifier: issue.identifier, url: `https://linear.app/x/issue/${issue.identifier}` };
});
const addIssueComment = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/linearService', () => ({
  listOpenIssuesByLabel: jest.fn(async () => linearState.issues),
  addIssueComment: (...a: unknown[]) => addIssueComment(...a),
  createInternalLinearIssue: (a: any) => createInternalLinearIssue(a),
  escalateIssue: jest.fn(),
  findMostRecentArchivedIssueByLabel: jest.fn().mockResolvedValue(null),
}));

const RESULT = {
  passed: true,
  actualResponse: 'Cross-account report body',
  keywordMatches: [] as string[],
  keywordMisses: [] as string[],
  functionCallMatches: [] as string[],
  functionCallMisses: [] as string[],
  executionTime: 1,
  attempt: 1,
  createdAt: new Date().toISOString(),
};

describe('withheld scheduled report → one canonical Linear defect (ENG-1825)', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevOncall = process.env.ONCALL_EMAIL_LIST;

  beforeEach(() => {
    jest.clearAllMocks();
    linearState.issues = [];
    __resetAgentModeAlertDedupeForTests();
    process.env.NODE_ENV = 'production'; // sendOncallAlert is a no-op outside production
    process.env.ONCALL_EMAIL_LIST = 'oncall@example.com';
    // Sensitive run (cross-account tool), nobody authorized: owner and recipient are not admins.
    (chatbotDb.getChatSession as jest.Mock).mockImplementation(async (sessionId: string) => ({
      sessionId, userId: 'owner-id', calledFunctions: { list_all_clients: 1 },
    }));
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-id', email: 'owner@example.com', isAdmin: false });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ isAdmin: false });
    jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
  });

  afterAll(() => {
    process.env.NODE_ENV = prevEnv;
    if (prevOncall === undefined) delete process.env.ONCALL_EMAIL_LIST;
    else process.env.ONCALL_EMAIL_LIST = prevOncall;
  });

  it('files one issue for the first withheld run, then comments on it for a DIFFERENT schedule instead of re-filing', async () => {
    await emailService.sendScheduledChatResultEmail(['a@haven.example'], 'Haven weekly', { ...RESULT, sessionId: 's-1' }, 'sched-haven');
    await emailService.sendScheduledChatResultEmail(['b@every.example'], 'Every lead gen', { ...RESULT, sessionId: 's-2' }, 'sched-every');

    expect(createInternalLinearIssue).toHaveBeenCalledTimes(1);
    expect(linearState.issues[0].description).toContain(`Alert Class: ${WITHHELD_REPORT_ALERT_CLASS}`);
    expect(linearState.issues[0].description).toContain('Schedule ID: sched-haven');
    expect(addIssueComment).toHaveBeenCalledTimes(1);
    expect(addIssueComment.mock.calls[0][1]).toContain('Schedule ID: sched-every');
  });

  it('suppresses a repeat alert for the SAME schedule inside 24h (the daily re-fire)', async () => {
    await emailService.sendScheduledChatResultEmail(['a@haven.example'], 'Haven weekly', { ...RESULT, sessionId: 's-1' }, 'sched-haven');
    await emailService.sendScheduledChatResultEmail(['a@haven.example'], 'Haven weekly', { ...RESULT, sessionId: 's-3' }, 'sched-haven');

    expect(createInternalLinearIssue).toHaveBeenCalledTimes(1);
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it('never puts a no-login share link to the withheld cross-account report into Linear', async () => {
    await emailService.sendScheduledChatResultEmail(['a@haven.example'], 'Haven weekly', { ...RESULT, sessionId: 's-1' }, 'sched-haven');

    expect(linearState.issues[0].description).not.toContain('SECRET');
    expect(linearState.issues[0].description).toContain('iShare Link: N/A');
    // The owner still gets the delivery-blocked status notice.
    const sends = (emailService.sendEmail as jest.Mock).mock.calls;
    expect(sends.some(c => Array.isArray(c[0]) && c[0].includes('owner@example.com'))).toBe(true);
  });
});
