import {
  normalizeSender,
  normalizeSenderConfig,
  serializeSender,
  validateSender,
  assertSenderUsableForBulkSend,
  loadSenderConfig,
  bulkSendGuardMessage,
  MailboxSenderNotSupportedError,
} from '../services/crmSenderService';
import { isMailboxSender, MAILBOX_PROVIDERS, CrmSender } from '../services/crmSenderTypes';
import { settingsService } from '../services/settingsService';

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

const mockGetSetting = settingsService.getSetting as jest.Mock;

const connectedAccounts = [
  { platform: 'gmail', account_id: 'gmail-acct-1', config: { email: 'habeb@gmail.com' } },
  { platform: 'outlook', account_id: 'outlook-acct-1', config: { email: 'habeb@baldwin.com' } },
];

describe('crmSenderTypes', () => {
  it('treats gmail and outlook as mailbox providers, resend as not', () => {
    expect(MAILBOX_PROVIDERS).toEqual(expect.arrayContaining(['gmail', 'outlook']));
    expect(isMailboxSender({ senderProvider: 'gmail' } as CrmSender)).toBe(true);
    expect(isMailboxSender({ senderProvider: 'outlook' } as CrmSender)).toBe(true);
    expect(isMailboxSender({ senderProvider: 'resend' } as CrmSender)).toBe(false);
  });
});

describe('normalizeSender — legacy records must keep working', () => {
  it('defaults a record with NO senderType to resend (the legacy custom-domain sender)', () => {
    const s = normalizeSender({ id: '0', email: 'hi@acme.com', fromName: 'Acme' });
    expect(s.senderProvider).toBe('resend');
    expect(s.connectedAccountId).toBeUndefined();
  });

  it('maps a legacy gmailAccountId onto connectedAccountId', () => {
    const s = normalizeSender({
      id: '1',
      email: 'habeb@gmail.com',
      fromName: 'Habeb',
      senderType: 'gmail',
      gmailAccountId: 'gmail-acct-1',
    });
    expect(s.senderProvider).toBe('gmail');
    expect(s.connectedAccountId).toBe('gmail-acct-1');
  });

  it('reads a new-shape outlook record', () => {
    const s = normalizeSender({
      id: '2',
      email: 'habeb@baldwin.com',
      fromName: 'Habeb',
      senderType: 'outlook',
      connectedAccountId: 'outlook-acct-1',
    });
    expect(s.senderProvider).toBe('outlook');
    expect(s.connectedAccountId).toBe('outlook-acct-1');
  });

  it('prefers connectedAccountId over the legacy gmailAccountId when both exist', () => {
    const s = normalizeSender({
      id: '3',
      email: 'a@b.com',
      fromName: 'X',
      senderType: 'gmail',
      gmailAccountId: 'legacy',
      connectedAccountId: 'current',
    });
    expect(s.connectedAccountId).toBe('current');
  });
});

describe('serializeSender — round-trips and dual-writes for rollback safety', () => {
  it('writes the legacy senderType key AND gmailAccountId for a gmail sender', () => {
    const raw = serializeSender({
      id: '1',
      email: 'habeb@gmail.com',
      fromName: 'Habeb',
      senderProvider: 'gmail',
      connectedAccountId: 'gmail-acct-1',
    });
    expect(raw.senderType).toBe('gmail');
    expect(raw.connectedAccountId).toBe('gmail-acct-1');
    // dual-write so a rollback to the old code still resolves the account
    expect(raw.gmailAccountId).toBe('gmail-acct-1');
  });

  it('does NOT write gmailAccountId for an outlook sender', () => {
    const raw = serializeSender({
      id: '2',
      email: 'habeb@baldwin.com',
      fromName: 'Habeb',
      senderProvider: 'outlook',
      connectedAccountId: 'outlook-acct-1',
    });
    expect(raw.senderType).toBe('outlook');
    expect(raw.connectedAccountId).toBe('outlook-acct-1');
    expect(raw.gmailAccountId).toBeUndefined();
  });

  it('omits senderType entirely for a resend sender (preserves the legacy discriminant)', () => {
    const raw = serializeSender({
      id: '0',
      email: 'hi@acme.com',
      fromName: 'Acme',
      senderProvider: 'resend',
    });
    expect(raw.senderType).toBeUndefined();
    expect(raw.connectedAccountId).toBeUndefined();
  });

  it('survives a normalize -> serialize -> normalize round trip', () => {
    const original = { id: '1', email: 'habeb@gmail.com', fromName: 'H', senderType: 'gmail', gmailAccountId: 'g1' };
    const again = normalizeSender(serializeSender(normalizeSender(original)));
    expect(again.senderProvider).toBe('gmail');
    expect(again.connectedAccountId).toBe('g1');
  });
});

describe('validateSender — FAIL cases', () => {
  it('rejects an unknown provider', () => {
    const r = validateSender({ email: 'a@b.com', fromName: 'X', senderType: 'smtp' }, connectedAccounts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/senderType/i);
  });

  it('rejects a gmail sender with no connected account id', () => {
    const r = validateSender({ email: 'habeb@gmail.com', fromName: 'H', senderType: 'gmail' }, connectedAccounts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/connectedAccountId/i);
  });

  it('rejects an outlook sender with no connected account id', () => {
    const r = validateSender({ email: 'habeb@baldwin.com', fromName: 'H', senderType: 'outlook' }, connectedAccounts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/connectedAccountId/i);
  });

  it('rejects a mailbox sender pointing at an account that is not connected', () => {
    const r = validateSender(
      { email: 'habeb@baldwin.com', fromName: 'H', senderType: 'outlook', connectedAccountId: 'nope' },
      connectedAccounts,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not connected|not found/i);
  });

  // From-identity: the provider stamps the authenticated mailbox on the wire, so a
  // mismatched From is silently ignored at send time. Reject it at save time instead.
  it('rejects a mailbox sender whose email does not match the connected mailbox', () => {
    const r = validateSender(
      { email: 'sales@baldwin.com', fromName: 'Baldwin Sales', senderType: 'outlook', connectedAccountId: 'outlook-acct-1' },
      connectedAccounts,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must match/i);
  });
});

describe('validateSender — SUCCESS cases', () => {
  it('accepts a legacy resend sender with no senderType', () => {
    expect(validateSender({ email: 'hi@acme.com', fromName: 'Acme' }, connectedAccounts).ok).toBe(true);
  });

  it('accepts a gmail sender whose email matches the connected mailbox', () => {
    const r = validateSender(
      { email: 'habeb@gmail.com', fromName: 'H', senderType: 'gmail', connectedAccountId: 'gmail-acct-1' },
      connectedAccounts,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts an outlook sender whose email matches the connected mailbox', () => {
    const r = validateSender(
      { email: 'habeb@baldwin.com', fromName: 'H', senderType: 'outlook', connectedAccountId: 'outlook-acct-1' },
      connectedAccounts,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a legacy gmail sender sent with the old gmailAccountId key', () => {
    const r = validateSender(
      { email: 'habeb@gmail.com', fromName: 'H', senderType: 'gmail', gmailAccountId: 'gmail-acct-1' },
      connectedAccounts,
    );
    expect(r.ok).toBe(true);
  });

  it('matches the mailbox address case-insensitively', () => {
    const r = validateSender(
      { email: 'Habeb@Baldwin.com', fromName: 'H', senderType: 'outlook', connectedAccountId: 'outlook-acct-1' },
      connectedAccounts,
    );
    expect(r.ok).toBe(true);
  });
});

// GUARD: until the send paths honour senderProvider (ENG-266 Part 3), a mailbox sender
// must NOT be silently routed through Resend by the campaign / sequence / drip paths.
describe('assertSenderUsableForBulkSend — the guard', () => {
  it('throws for a gmail sender', () => {
    expect(() =>
      assertSenderUsableForBulkSend({
        id: '1', email: 'a@gmail.com', fromName: 'X', senderProvider: 'gmail', connectedAccountId: 'g1',
      }),
    ).toThrow(MailboxSenderNotSupportedError);
  });

  it('throws for an outlook sender', () => {
    expect(() =>
      assertSenderUsableForBulkSend({
        id: '2', email: 'a@baldwin.com', fromName: 'X', senderProvider: 'outlook', connectedAccountId: 'o1',
      }),
    ).toThrow(MailboxSenderNotSupportedError);
  });

  it('does NOT throw for a resend sender', () => {
    expect(() =>
      assertSenderUsableForBulkSend({ id: '0', email: 'a@acme.com', fromName: 'X', senderProvider: 'resend' }),
    ).not.toThrow();
  });

  it('names the provider in the error so the UI can explain it', () => {
    try {
      assertSenderUsableForBulkSend({
        id: '2', email: 'a@baldwin.com', fromName: 'X', senderProvider: 'outlook', connectedAccountId: 'o1',
      });
      fail('expected throw');
    } catch (e: any) {
      expect(e.provider).toBe('outlook');
      expect(e.message).toMatch(/outlook/i);
    }
  });
});

// The bulk-send routes only receive a bare `senderEmail` — the composer discards the
// provider — so the guard has to resolve it back by address. If a user has BOTH a mailbox
// sender and a custom-domain sender on the same address, blocking the send would break a
// configuration that works today. Only refuse when EVERY sender on that address is
// mailbox-backed.
describe('bulkSendGuardMessage — must not block a legitimate custom-domain sender', () => {
  const senders = (list: any[]) =>
    mockGetSetting.mockResolvedValue({ settingValue: JSON.stringify({ senders: list }) });

  beforeEach(() => jest.clearAllMocks());

  it('blocks when the address only resolves to a mailbox sender', async () => {
    senders([
      { id: '1', email: 'habeb@baldwin.com', fromName: 'Habeb', senderType: 'outlook', connectedAccountId: 'o1' },
    ]);
    const msg = await bulkSendGuardMessage('u1', 'habeb@baldwin.com');
    expect(msg).toMatch(/outlook/i);
  });

  it('ALLOWS when the same address also has a custom-domain (resend) sender', async () => {
    senders([
      { id: '1', email: 'habeb@baldwin.com', fromName: 'Habeb', senderType: 'outlook', connectedAccountId: 'o1' },
      { id: '2', email: 'habeb@baldwin.com', fromName: 'Habeb (domain)' }, // legacy resend sender
    ]);
    expect(await bulkSendGuardMessage('u1', 'habeb@baldwin.com')).toBeNull();
  });

  it('ALLOWS regardless of which order the senders are configured in', async () => {
    senders([
      { id: '2', email: 'habeb@baldwin.com', fromName: 'Habeb (domain)' },
      { id: '1', email: 'habeb@baldwin.com', fromName: 'Habeb', senderType: 'gmail', gmailAccountId: 'g1' },
    ]);
    expect(await bulkSendGuardMessage('u1', 'habeb@baldwin.com')).toBeNull();
  });

  it('allows an address that is not a configured sender at all', async () => {
    senders([{ id: '1', email: 'other@acme.com', fromName: 'Other' }]);
    expect(await bulkSendGuardMessage('u1', 'adhoc@acme.com')).toBeNull();
  });

  it('matches the address case-insensitively', async () => {
    senders([
      { id: '1', email: 'habeb@baldwin.com', fromName: 'H', senderType: 'gmail', gmailAccountId: 'g1' },
    ]);
    expect(await bulkSendGuardMessage('u1', 'Habeb@Baldwin.COM')).toMatch(/gmail/i);
  });

  // The real fix for the ambiguity: the composer now posts senderId, so the guard resolves
  // the exact sender the user picked instead of guessing from the address.
  describe('when senderId is supplied, resolve it EXACTLY — no guessing', () => {
    const ambiguous = () =>
      senders([
        { id: 'mailbox', email: 'habeb@baldwin.com', fromName: 'H', senderType: 'outlook', connectedAccountId: 'o1' },
        { id: 'domain', email: 'habeb@baldwin.com', fromName: 'H (domain)' },
      ]);

    it('BLOCKS the mailbox sender even though the address also has a resend sender', async () => {
      ambiguous();
      const msg = await bulkSendGuardMessage('u1', 'habeb@baldwin.com', 'mailbox');
      expect(msg).toMatch(/outlook/i);
    });

    it('ALLOWS the resend sender even though the address also has a mailbox sender', async () => {
      ambiguous();
      expect(await bulkSendGuardMessage('u1', 'habeb@baldwin.com', 'domain')).toBeNull();
    });

    it('falls back to the address when the id is unknown', async () => {
      ambiguous();
      expect(await bulkSendGuardMessage('u1', 'habeb@baldwin.com', 'no-such-id')).toBeNull();
    });
  });
});

describe('loadSenderConfig — the single loader every reader must use', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns an empty config when the setting does not exist', async () => {
    mockGetSetting.mockResolvedValue(null);
    const cfg = await loadSenderConfig('user-1');
    expect(cfg.senders).toEqual([]);
    expect(cfg.defaultSenderId).toBeNull();
  });

  it('normalizes every sender in the blob, including legacy ones', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify({
        senders: [
          { id: '0', email: 'hi@acme.com', fromName: 'Acme' }, // legacy resend
          { id: '1', email: 'habeb@gmail.com', fromName: 'H', senderType: 'gmail', gmailAccountId: 'g1' },
        ],
        defaultSenderId: '0',
      }),
    });
    const cfg = await loadSenderConfig('user-1');
    expect(cfg.senders[0].senderProvider).toBe('resend');
    expect(cfg.senders[1].senderProvider).toBe('gmail');
    expect(cfg.senders[1].connectedAccountId).toBe('g1');
    expect(cfg.defaultSenderId).toBe('0');
  });

  it('returns an empty config on malformed JSON rather than throwing', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: '{not json' });
    const cfg = await loadSenderConfig('user-1');
    expect(cfg.senders).toEqual([]);
  });

  it('tolerates a blob whose senders key is not an array', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: JSON.stringify({ senders: 'nope' }) });
    const cfg = await loadSenderConfig('user-1');
    expect(cfg.senders).toEqual([]);
  });
});

describe('normalizeSenderConfig', () => {
  it('defaults defaultSenderId to null when absent', () => {
    const cfg = normalizeSenderConfig({ senders: [] });
    expect(cfg.defaultSenderId).toBeNull();
    expect(cfg.defaultLinkedInAccountId).toBeNull();
  });
});
