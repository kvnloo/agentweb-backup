import { emailService } from '../services/emailService';
import { chatbotDb } from '../services/chatbotService';
import { userDb } from '../services/db';
import { LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON } from '../utils/scheduleRunBlockedReason';

// ENG-1131 follow-up: the schedule-card badge told the owner sourcing was
// blocked by the LinkedIn search outage, but the two email surfaces
// (per-run result email + daily digest) still rendered a plain green
// "success" for the exact same run, because both read only `result.passed`
// (left `true` on purpose — see agentModeController.ts). These tests cover
// the email templates picking up `result.blockedBy` the same way the card did.

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionInteractiveShareMetadata: jest.fn().mockResolvedValue(undefined),
    getChatSession: jest.fn().mockResolvedValue({ sessionId: 'session-abc', userId: 'owner-id', calledFunctions: {} }),
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://app/share'),
  },
}));

jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn(), getUserById: jest.fn() },
}));

describe('emailService.sendScheduledChatResultEmail — ENG-1131 blocked-sourcing state', () => {
  const baseResult = {
    passed: true,
    actualResponse: 'Validated two Tier 1 candidates and updated their CRM status.',
    keywordMatches: [],
    keywordMisses: [],
    functionCallMatches: [],
    functionCallMisses: [],
    executionTime: 341179,
    sessionId: 'session-abc',
    attempt: 1,
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a warning state, not a plain success, when the run was blocked by the LinkedIn search outage', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      'owner@example.com',
      'DTC Founder Prospecting',
      { ...baseResult, blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON },
      'schedule-123',
      'Leads Not Sourced',
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [, subject, textContent, htmlContent] = spy.mock.calls[0];

    // Must not read as a plain success — the whole point of ENG-1131.
    expect(htmlContent).not.toContain('successfully executed');
    expect(subject).not.toContain('✅');

    // Must explain what actually happened, in the same terms as the schedule-card badge:
    // explicitly NOT a real empty, and reconnecting explicitly does NOT help.
    expect(htmlContent).toContain('LinkedIn');
    expect(htmlContent.toLowerCase()).toContain('unavailable');
    expect(htmlContent.toLowerCase()).toContain('nobody matched your filters');
    expect(htmlContent).toContain('<strong>not</strong>');
    expect(htmlContent.toLowerCase()).toContain('reconnecting will not help');
    expect(textContent.toLowerCase()).toContain('unavailable');
  });

  it('leaves a normal passed run unchanged (no blockedBy)', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      'owner@example.com',
      'DTC Founder Prospecting',
      baseResult,
      'schedule-123',
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [, subject, , htmlContent] = spy.mock.calls[0];
    expect(subject).toContain('✅');
    expect(htmlContent).toContain('successfully executed');
  });

  it('leaves a normal failed run unchanged (no blockedBy)', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      'owner@example.com',
      'DTC Founder Prospecting',
      { ...baseResult, passed: false },
      'schedule-123',
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [, subject, , htmlContent] = spy.mock.calls[0];
    expect(subject).toContain('❌');
    expect(htmlContent).toContain('did not meet all criteria');
  });
});

describe('emailService.sendDailyDigestEmail — ENG-1131 blocked-sourcing state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks only the blocked run in a mixed digest, leaving the other run\'s PASSED badge alone', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    const results = [
      {
        passed: true,
        actualResponse: 'Sourced 12 new leads.',
        keywordMatches: [], keywordMisses: [], functionCallMatches: [], functionCallMisses: [],
        executionTime: 100000, sessionId: 'session-ok', attempt: 1,
        createdAt: new Date().toISOString(),
      },
      {
        passed: true,
        blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON,
        actualResponse: 'LinkedIn people search was unavailable for this account.',
        keywordMatches: [], keywordMisses: [], functionCallMatches: [], functionCallMisses: [],
        executionTime: 341179, sessionId: 'session-blocked', attempt: 1,
        createdAt: new Date().toISOString(),
      },
    ];

    await emailService.sendDailyDigestEmail('owner@example.com', 'DTC Founder Prospecting', results, 'schedule-123');

    expect(spy).toHaveBeenCalledTimes(1);
    const [, , textContent, htmlContent] = spy.mock.calls[0];

    // The healthy run still reads as a plain success.
    expect(htmlContent).toContain('✅ PASSED');
    // The blocked run does NOT read as a plain success, and explains why.
    expect(htmlContent).not.toContain('✅ ✅');
    expect(htmlContent.toLowerCase()).toContain('unavailable for the connected account');
    expect(textContent.toLowerCase()).toContain('unavailable');
  });

  it('a run with no blockedBy still renders the pre-existing PASSED/FAILED shape', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    const results = [
      {
        passed: false,
        actualResponse: 'Ran out of attempts.',
        keywordMatches: [], keywordMisses: [], functionCallMatches: [], functionCallMisses: [],
        executionTime: 50000, sessionId: 'session-fail', attempt: 3,
        createdAt: new Date().toISOString(),
      },
    ];

    await emailService.sendDailyDigestEmail('owner@example.com', 'Some Schedule', results, 'schedule-456');

    const [, , , htmlContent] = spy.mock.calls[0];
    expect(htmlContent).toContain('❌ FAILED');
    expect(htmlContent.toLowerCase()).not.toContain('unavailable for the connected account');
  });
});

describe('emailService.sendScheduleSourcingBlockTransitionEmail (ENG-1131 follow-up: proactive alert)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends a "just became blocked" alert explaining the outage, not a plain failure', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduleSourcingBlockTransitionEmail(
      'owner@example.com',
      'DTC Founder Prospecting',
      'schedule-123',
      true,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [recipients, subject, textContent, htmlContent] = spy.mock.calls[0];
    expect(recipients).toEqual(['owner@example.com']);
    expect(subject.toLowerCase()).toContain('linkedin search');
    expect(htmlContent).toContain('DTC Founder Prospecting');
    expect(htmlContent.toLowerCase()).toContain('unavailable');
    expect(htmlContent.toLowerCase()).toContain('nobody matched your filters');
    expect(htmlContent.toLowerCase()).toContain('reconnecting will not help');
    expect(htmlContent).not.toContain('failed');
    expect(textContent.toLowerCase()).toContain('unavailable');
  });

  it('sends a "resolved" alert when sourcing recovers', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduleSourcingBlockTransitionEmail(
      'owner@example.com',
      'DTC Founder Prospecting',
      'schedule-123',
      false,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [, subject, textContent, htmlContent] = spy.mock.calls[0];
    expect(subject.toLowerCase()).toContain('back');
    expect(htmlContent.toLowerCase()).toContain('working again');
    expect(textContent.toLowerCase()).toContain('working again');
  });

  it('normalizes a single recipient string to a one-element list', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    await emailService.sendScheduleSourcingBlockTransitionEmail('solo@example.com', 'S', 'sched-2', true);
    expect(spy.mock.calls[0][0]).toEqual(['solo@example.com']);
  });

  it('HTML-escapes the schedule name', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    await emailService.sendScheduleSourcingBlockTransitionEmail(
      ['x@example.com'],
      'Evil <img src=x onerror=alert(1)> Schedule',
      'sched-4',
      true,
    );
    const html = spy.mock.calls[0][3];
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;img src=x onerror');
  });

  it('never throws when the transport fails (best-effort)', async () => {
    jest.spyOn(emailService, 'sendEmail').mockRejectedValue(new Error('SMTP down'));
    await expect(
      emailService.sendScheduleSourcingBlockTransitionEmail(['x@example.com'], 'S', 'sched-5', true),
    ).resolves.toBeUndefined();
  });
});
