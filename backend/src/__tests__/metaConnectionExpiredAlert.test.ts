const setSettingIfAbsent = jest.fn();
const getJsonArraySetting = jest.fn();
const sendEmail = jest.fn();
jest.mock('../services/settingsService', () => ({ settingsService: { setSettingIfAbsent: (...a: any[]) => setSettingIfAbsent(...a), getJsonArraySetting: (...a: any[]) => getJsonArraySetting(...a) } }));
jest.mock('../services/emailService', () => ({ emailService: { sendEmail: (...a: any[]) => sendEmail(...a), escapeHtml: (s: string) => s } }));

import { sendMetaConnectionExpiredAlert, DEFAULT_META_CONNECTION_ALERT_EMAILS } from '../services/metaConnectionExpiredAlert';

const OLD_ENV = process.env.NODE_ENV;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NODE_ENV = 'production';
  getJsonArraySetting.mockImplementation(async (_k: string, fb: string[]) => fb);
  sendEmail.mockResolvedValue('sent');
});
afterAll(() => { process.env.NODE_ENV = OLD_ENV; });

describe('sendMetaConnectionExpiredAlert', () => {
  it('emails the Meta connection list (not founders), facts only', async () => {
    setSettingIfAbsent.mockResolvedValue(true);
    const ok = await sendMetaConnectionExpiredAlert({ accountId: '123', accountName: 'Reign', customerEmail: 'c@x.com', error: 'Error 190', now: 0 });
    expect(ok).toBe(true);
    const [to, subject, text] = sendEmail.mock.calls[0];
    expect(to).toEqual(DEFAULT_META_CONNECTION_ALERT_EMAILS);
    expect(to.join(',')).not.toMatch(/harsha|ftan|founders|support/);
    expect(subject).toBe('Meta connection expired: c@x.com — Reign (123)');
    expect(text).not.toMatch(/Next actor|should|must/i);
  });

  it('sends nothing when another instance already alerted this account this week', async () => {
    setSettingIfAbsent.mockResolvedValue(false);
    expect(await sendMetaConnectionExpiredAlert({ accountId: '123' })).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing outside production', async () => {
    process.env.NODE_ENV = 'development';
    expect(await sendMetaConnectionExpiredAlert({ accountId: '123' })).toBe(false);
    expect(setSettingIfAbsent).not.toHaveBeenCalled();
  });
});
