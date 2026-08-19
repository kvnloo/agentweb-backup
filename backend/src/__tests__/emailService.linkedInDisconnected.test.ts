/**
 * ENG-1197 — the copy of the disconnect email itself.
 *
 * This email goes to paying customers and cannot be unsent, but nothing rendered it:
 * the controller test asserts the ARGUMENTS, never the body. Rendering it for review
 * is what surfaced three problems at once — it named the wrong connection, stated a
 * detection time as though it were the moment LinkedIn ended the session, and printed
 * that time in the server's zone.
 */

const captured: Array<{ subject: string; text: string; html: string }> = [];

import { emailService } from '../services/emailService';

beforeAll(() => {
  (emailService as any).sendEmail = async (_to: any, subject: string, text: string, html: string) => {
    captured.push({ subject, text, html });
  };
});

beforeEach(() => {
  captured.length = 0;
  process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
});

const send = (opts: any) =>
  emailService.sendLinkedInAccountDisconnectedEmail(['jennifer.sun@tfaconnect.com'], opts);

const first = () => captured[0];

describe('it names the connection the customer actually has to reconnect', () => {
  // A customer can hold BOTH a `linkedin` connection (posting) and a `unipile` one
  // (outreach). "Your LinkedIn account" points at the wrong one, and the portal calls
  // this connection "LinkedIn Outreach".
  it('says LinkedIn Outreach, in the subject and the body', async () => {
    await send({ accountName: 'Jennifer Sun', disconnectedAt: '2026-08-18T12:30:00.000Z', isReminder: false, daysDisconnected: 0 });

    expect(first().subject).toContain('LinkedIn Outreach');
    expect(first().text).toContain('Your LinkedIn Outreach account disconnected');
    expect(first().text).toContain('Reconnect LinkedIn Outreach:');
  });
});

describe('it states only what we actually know about timing', () => {
  it('presents the timestamp as a DETECTION, not as when LinkedIn ended the session', async () => {
    // On a first-ever detection `disconnected_at` is stamped "now", because there is
    // no record of the real death. Jennifer's session died five days before we
    // noticed; Sue's roughly 38. Reporting that stamp as the moment it ended is a
    // false statement to a customer.
    await send({ accountName: 'Jennifer Sun', disconnectedAt: '2026-08-18T12:30:00.000Z', isReminder: false, daysDisconnected: 0 });

    expect(first().text).toContain('we detected this on');
    expect(first().text).not.toMatch(/ended the session for "Jennifer Sun" on /);
  });

  it('renders that time in UTC, labelled', async () => {
    // Customers are worldwide; the server's zone means nothing to them, and labelling
    // it without fixing it is worse — it names our zone as though it were theirs.
    await send({ accountName: 'Jennifer Sun', disconnectedAt: '2026-08-18T12:30:00.000Z', isReminder: false, daysDisconnected: 0 });

    expect(first().text).toContain('Aug 18, 2026, 12:30 PM UTC');
  });

  it('omits the sentence entirely rather than printing a null when the time is unknown', async () => {
    await send({ accountName: 'Jennifer Sun', isReminder: true, daysDisconnected: 0, skippedRunCount: 5, pausedScheduleName: 'Daily Dream 100' });

    expect(first().text).not.toContain('null');
    expect(first().text).not.toContain('undefined');
    expect(first().text).not.toContain('we detected this on');
  });

  it('counts reminder days from detection, and says so', async () => {
    await send({ accountName: 'Jennifer Sun', disconnectedAt: '2026-08-11T12:30:00.000Z', isReminder: true, daysDisconnected: 7 });

    expect(first().text).toContain('Still disconnected 7 days after we detected it');
  });
});

describe('the pause variant', () => {
  it('counts skipped RUNS as runs, not days', async () => {
    await send({ accountName: 'Jennifer Sun', isReminder: true, daysDisconnected: 15, skippedRunCount: 5, pausedScheduleName: 'Daily Dream 100' });

    expect(first().text).toContain('has been paused after 5 skipped runs');
    expect(first().text).not.toContain('5 days of skipped runs');
  });

  it('links a real settings route', async () => {
    await send({ accountName: 'Jennifer Sun', isReminder: false, daysDisconnected: 0 });

    // `/settings/connected-accounts` is not a route; the tab slug is `accounts`.
    expect(first().text).toContain('https://app.agentweb.pro/settings/accounts');
    expect(first().text).not.toContain('/settings/connected-accounts');
  });
});
