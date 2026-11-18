/**
 * ENG-3149: the email an account owner gets when a share-link visitor first marks one of their scheduled chats.
 * The copy is approved wording and is pinned verbatim; the schedule name is the only visitor-derived text and is neutralised.
 */
import { emailService, shareScheduleAlertName, SHARE_SCHEDULE_ALERT_NAME_MAX } from '../services/emailService';

jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn(), getUserById: jest.fn() },
  scheduleDb: { getScheduleById: jest.fn() },
}));

const SUBJECT = 'Someone using your share link set up a scheduled chat';
const HEADER = 'A scheduled chat was set up through your share link';
const PARAGRAPH_2 = "Until you review it, it runs with limited access: it can't use account-level tools such as saving memory or changing organization settings, and anything it would publish or post to Slack is kept as a draft.";
const PARAGRAPH_3 = "If it's yours or you trust it, open Scheduled chats, read what it does and press Adopt. If you don't recognise it, delete it, and consider turning off the share link.";

describe('emailService.sendVisitorScheduleAlertEmail (ENG-3149)', () => {
  let sendSpy: jest.SpyInstance;
  const originalUrl = process.env.CUSTOMER_FRONTEND_URL;

  beforeEach(() => {
    sendSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined as any);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.example.test';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.CUSTOMER_FRONTEND_URL; else process.env.CUSTOMER_FRONTEND_URL = originalUrl;
  });

  const send = async (name: string, scheduleId = 'sched-1', to: string | string[] = 'owner@example.com') => {
    await emailService.sendVisitorScheduleAlertEmail(to, name, scheduleId);
    const [recipients, subject, text, html] = sendSpy.mock.calls[0] as [string[], string, string, string];
    return { recipients, subject, text, html };
  };

  it('sends ONE email to the given owner address with the fixed subject, which never contains the schedule name', async () => {
    const { recipients, subject } = await send('Quarterly pipeline report');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(recipients).toEqual(['owner@example.com']);
    expect(subject).toBe(SUBJECT);
    expect(subject).not.toContain('Quarterly');
  });

  it('carries the approved copy verbatim in BOTH the HTML and the plain-text part', async () => {
    const { text, html } = await send('Quarterly pipeline report', 'sched-42');
    for (const part of [text, html]) {
      expect(part).toContain(HEADER);
      expect(part).toContain('Someone using one of your Emma share links created or changed the scheduled chat "Quarterly pipeline report".');
      expect(part).toContain(PARAGRAPH_2);
      expect(part).toContain(PARAGRAPH_3);
      expect(part).toContain('Review the schedule');
      expect(part).toContain('Schedule ID: sched-42');
    }
  });

  it('links the button to ${CUSTOMER_FRONTEND_URL}/agent-mode?tab=scheduled (and falls back like the other schedule emails)', async () => {
    const { text, html } = await send('x');
    expect(html).toContain('<a class="button" href="https://app.example.test/agent-mode?tab=scheduled">Review the schedule</a>');
    expect(text).toContain('https://app.example.test/agent-mode?tab=scheduled');

    sendSpy.mockClear();
    delete process.env.CUSTOMER_FRONTEND_URL;
    const fallback = await send('x');
    expect(fallback.html).toContain('href="http://localhost:5174/agent-mode?tab=scheduled"');
  });

  it('neutralises HTML in the name in the HTML part (escaped, so it cannot add markup), and keeps it readable as text in the plain part', async () => {
    const hostile = '<img src=x onerror=alert(1)> & "quoted" <a href="https://evil.example">click</a>';
    const { html, text } = await send(hostile);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="https://evil.example"');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot; &lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt;');
    expect(text).toContain(hostile);
    // The only links in the HTML are the button's.
    expect((html.match(/<a /g) || []).length).toBe(1);
  });

  it('collapses whitespace and newlines in the name to single spaces (a name cannot add lines to the plain-text part)', async () => {
    const { text, html } = await send('  Line one\n\nLine\ttwo\r\n   Line three  ');
    expect(text).toContain('the scheduled chat "Line one Line two Line three".');
    expect(html).toContain('the scheduled chat "Line one Line two Line three".');
  });

  it('truncates a long name to 100 characters with an ellipsis (still 100 in all, whole characters)', async () => {
    const long = 'A'.repeat(500);
    const { text, html } = await send(long);
    const expected = `${'A'.repeat(99)}…`;
    expect(Array.from(expected)).toHaveLength(SHARE_SCHEDULE_ALERT_NAME_MAX);
    expect(text).toContain(`the scheduled chat "${expected}".`);
    expect(html).toContain(`the scheduled chat "${expected}".`);
    expect(text).not.toContain('A'.repeat(100));

    // exactly at the limit: untouched
    sendSpy.mockClear();
    const atLimit = await send('B'.repeat(100));
    expect(atLimit.text).toContain(`"${'B'.repeat(100)}".`);
    expect(atLimit.text).not.toContain('…');
  });

  it('never cuts a character in half (emoji are one character each)', async () => {
    const { text } = await send('\u{1F600}'.repeat(150));
    expect(text).toContain(`"${'\u{1F600}'.repeat(99)}…".`);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('puts nothing else of the visitor in the mail: no prompt text, token or recipient comes from the arguments, only the name and the id', async () => {
    const { text, html } = await send('Weekly digest', 'sched-9');
    for (const part of [text, html]) {
      expect(part).not.toMatch(/token|conversable|ishare|prompt|@visitor/i);
    }
    // And the method has exactly three inputs.
    expect(emailService.sendVisitorScheduleAlertEmail.length).toBe(3);
  });

  it('shows no customer-facing ENG number', async () => {
    const { text, html, subject } = await send('Weekly digest');
    for (const part of [text, html, subject]) expect(part).not.toMatch(/ENG-\d+/);
  });

  it('an empty or non-string name is shown as "Untitled" rather than an empty pair of quotes', async () => {
    const { text } = await send('   \n\t ');
    expect(text).toContain('the scheduled chat "Untitled".');
  });

  it('never throws, even when sending fails (like its sibling schedule emails)', async () => {
    sendSpy.mockRejectedValue(new Error('smtp down'));
    await expect(emailService.sendVisitorScheduleAlertEmail('owner@example.com', 'x', 's')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ENG-3149]'), expect.any(Error));
  });
});

describe('shareScheduleAlertName (ENG-3149)', () => {
  it.each([
    ['plain', 'My schedule', 'My schedule'],
    ['control characters', 'a\u0000b\u0007c\u007fd', 'a b c d'],
    ['unicode line separators', 'a b c', 'a b c'],
    ['non-string', undefined, 'Untitled'],
    ['number', 42, 'Untitled'],
    ['blank', '   ', 'Untitled'],
  ])('%s', (_label, input, expected) => {
    expect(shareScheduleAlertName(input)).toBe(expected);
  });
});
