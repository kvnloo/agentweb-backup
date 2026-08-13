/**
 * ENG-943: an org-shared mailbox must resolve in the mail tools.
 *
 * list_connected_accounts reports own + org-shared accounts, but account
 * resolution for the email tools only ever searched the caller's OWN record —
 * so the exact account_id the list handed back came straight back as
 * 'Connected account "..." not found', and a scheduled run that needed a login
 * code out of a teammate's shared mailbox could not proceed.
 *
 * Resolution also has to report WHO owns the mailbox: the OAuth tokens live in
 * the owner's record, so a provider call made with the caller's id would fail
 * the lookup again one level down (and a token refresh would be written to the
 * wrong record).
 */

const mockGetAccountsWithOwnerIncludingOrgShared = jest.fn();

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountById: jest.fn(),
  getAccountsWithOwnerIncludingOrgShared: (...args: any[]) =>
    mockGetAccountsWithOwnerIncludingOrgShared(...args),
}));

// Prevent gmailService from importing googleapis at module load
jest.mock('../services/gmailService', () => ({
  gmailService: {
    searchEmails: jest.fn(),
    listEmails: jest.fn(),
    getEmails: jest.fn(),
    sendEmail: jest.fn(),
  },
}));

import {
  registerEmailProvider,
  resolveEmailAccount,
  resolveDefaultEmailAccount,
  EmailProviderError,
  type IEmailService,
} from '../services/emailProviderService';

const CALLER = 'caller-user-id';
const TEAMMATE = 'teammate-user-id';

const makeMockProvider = (): IEmailService => ({
  searchEmails: jest.fn(),
  listEmails: jest.fn(),
  getEmails: jest.fn(),
  sendEmail: jest.fn(),
});

const account = (platform: string, accountId: string, ownerUserId: string) => ({
  platform,
  account_id: accountId,
  account_name: accountId,
  userId: ownerUserId,
  config: {
    account_type: platform,
    access_token: 'token',
    token_expires_at: Date.now() + 3_600_000,
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

beforeEach(() => {
  jest.clearAllMocks();
  registerEmailProvider('gmail', makeMockProvider());
  registerEmailProvider('outlook', makeMockProvider());
  mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([]);
});

describe('resolveEmailAccount — org-shared mailboxes (ENG-943)', () => {
  it('resolves a mailbox shared by an org teammate', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('gmail', 'teammate@example.com', TEAMMATE),
    ]);

    const resolved = await resolveEmailAccount(CALLER, 'teammate@example.com');

    expect(resolved.platform).toBe('gmail');
    expect(resolved.accountId).toBe('teammate@example.com');
    // Provider calls must run as the OWNER — that is where the tokens live.
    expect(resolved.ownerUserId).toBe(TEAMMATE);
  });

  it('reports the caller as owner for the caller\'s own mailbox', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('gmail', 'me@example.com', CALLER),
    ]);

    const resolved = await resolveEmailAccount(CALLER, 'me@example.com');

    expect(resolved.ownerUserId).toBe(CALLER);
  });

  it('still rejects an account nobody has made accessible to the caller', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('gmail', 'me@example.com', CALLER),
    ]);

    await expect(resolveEmailAccount(CALLER, 'private@example.com')).rejects.toThrow(
      /not found/
    );
  });

  it('prefers the email account when a non-email account shares the same id', async () => {
    // A Google account connected for both Drive and Gmail carries the same
    // address as account_id — matching on the id alone could pick Drive and
    // reject the mailbox as "not an email account".
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('google_drive', 'shared@example.com', TEAMMATE),
      account('gmail', 'shared@example.com', TEAMMATE),
    ]);

    const resolved = await resolveEmailAccount(CALLER, 'shared@example.com');

    expect(resolved.platform).toBe('gmail');
    expect(resolved.ownerUserId).toBe(TEAMMATE);
  });

  it('still explains when the id belongs only to a non-email platform', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('linkedin', 'li-acc', CALLER),
    ]);

    await expect(resolveEmailAccount(CALLER, 'li-acc')).rejects.toThrow(
      /linkedin account, not an email account/
    );
  });
});

/**
 * Reading a teammate's shared mailbox and SENDING from it are different acts.
 * Org sharing was introduced as "share CRM across org members, keep other assets
 * private" and extended one platform at a time; mail predates it entirely, so
 * sending as a teammate was never granted. Fixing the read bug must not quietly
 * hand it over — the ticket reports only reads.
 */
/**
 * The old lookup (getAccountById) caught its own DynamoDB errors and returned
 * null, so a transient failure surfaced as "not found". The org-shared lookup
 * does not, so an unwrapped throw would escape the email tool's catch — it only
 * recognises EmailProviderError and two message substrings — and reach the
 * caller as a raw exception. Fail honestly, but as a typed provider error.
 */
describe('resolveEmailAccount — connected-account lookup failures (ENG-943)', () => {
  it('reports a lookup failure as a provider error rather than a raw throw', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockRejectedValue(
      new Error('ProvisionedThroughputExceededException')
    );

    await expect(resolveEmailAccount(CALLER, 'me@example.com')).rejects.toThrow(
      EmailProviderError
    );
  });

  it('does not disguise a lookup failure as a missing account', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockRejectedValue(new Error('boom'));

    await expect(resolveEmailAccount(CALLER, 'me@example.com')).rejects.not.toThrow(/not found/i);
  });

  it('reports a lookup failure on the auto-resolve path too', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockRejectedValue(new Error('boom'));

    await expect(resolveDefaultEmailAccount(CALLER)).rejects.toThrow(EmailProviderError);
  });
});

describe('resolveEmailAccount — send is own-mailbox only (ENG-943)', () => {
  const shared = account('gmail', 'teammate@example.com', TEAMMATE);
  const own = account('gmail', 'me@example.com', CALLER);

  it('refuses to send from a teammate’s org-shared mailbox', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([shared]);

    await expect(resolveEmailAccount(CALLER, shared.account_id, 'send')).rejects.toThrow(
      /shared with your organization for reading/i
    );
  });

  it('names the mailbox it refused, rather than claiming it does not exist', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([shared]);

    await expect(resolveEmailAccount(CALLER, shared.account_id, 'send')).rejects.toThrow(
      new RegExp(shared.account_id)
    );
  });

  it('still sends from the caller’s own mailbox', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([own]);

    const resolved = await resolveEmailAccount(CALLER, own.account_id, 'send');

    expect(resolved.ownerUserId).toBe(CALLER);
    expect(resolved.accountId).toBe(own.account_id);
  });

  it('still READS a teammate’s org-shared mailbox — the bug stays fixed', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([shared]);

    const resolved = await resolveEmailAccount(CALLER, shared.account_id, 'read');

    expect(resolved.ownerUserId).toBe(TEAMMATE);
  });

  it('defaults to read when no operation is given', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([shared]);

    const resolved = await resolveEmailAccount(CALLER, shared.account_id);

    expect(resolved.ownerUserId).toBe(TEAMMATE);
  });
});

describe('resolveDefaultEmailAccount (ENG-943)', () => {
  it('falls back to an org-shared mailbox when the caller has none of their own', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('google_drive', 'mine@example.com', CALLER),
      account('gmail', 'teammate@example.com', TEAMMATE),
    ]);

    const resolved = await resolveDefaultEmailAccount(CALLER);

    expect(resolved?.accountId).toBe('teammate@example.com');
    expect(resolved?.ownerUserId).toBe(TEAMMATE);
  });

  it('prefers the caller\'s own mailbox over a shared one on the same platform', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('gmail', 'mine@example.com', CALLER),
      account('gmail', 'teammate@example.com', TEAMMATE),
    ]);

    const resolved = await resolveDefaultEmailAccount(CALLER);

    expect(resolved?.accountId).toBe('mine@example.com');
    expect(resolved?.ownerUserId).toBe(CALLER);
  });

  it('prefers gmail over outlook when both are accessible', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('outlook', 'work@example.com', CALLER),
      account('gmail', 'personal@example.com', CALLER),
    ]);

    const resolved = await resolveDefaultEmailAccount(CALLER);

    expect(resolved?.platform).toBe('gmail');
  });

  it('returns null when no mailbox is accessible at all', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('linkedin', 'li-acc', CALLER),
    ]);

    await expect(resolveDefaultEmailAccount(CALLER)).resolves.toBeNull();
  });
});

/**
 * The auto-resolve path has to honour the same read/send split as the named one.
 * Only read_verification_code calls it today, so no caller can currently reach a
 * teammate's mailbox for a send — but the restriction living in resolveEmailAccount
 * alone means the first future send caller silently gets what the named path
 * refuses. Take the operation here too, so the rule holds wherever a mailbox is
 * picked rather than wherever it happens to be named.
 */
describe('resolveDefaultEmailAccount — send is own-mailbox only (ENG-943)', () => {
  it('will not auto-pick a teammate’s org-shared mailbox to send from', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('gmail', 'teammate@example.com', TEAMMATE),
    ]);

    await expect(resolveDefaultEmailAccount(CALLER, 'send')).resolves.toBeNull();
  });

  it('picks the caller’s own mailbox for a send even on a later platform', async () => {
    // gmail comes first in EMAIL_PLATFORMS, so a platform-ordered pick that
    // ignored the operation would hand back the teammate's gmail here.
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('gmail', 'teammate@example.com', TEAMMATE),
      account('outlook', 'mine@example.com', CALLER),
    ]);

    const resolved = await resolveDefaultEmailAccount(CALLER, 'send');

    expect(resolved?.accountId).toBe('mine@example.com');
    expect(resolved?.ownerUserId).toBe(CALLER);
  });

  it('still auto-picks a teammate’s shared mailbox for a read', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('gmail', 'teammate@example.com', TEAMMATE),
    ]);

    const resolved = await resolveDefaultEmailAccount(CALLER, 'read');

    expect(resolved?.ownerUserId).toBe(TEAMMATE);
  });

  it('defaults to read when no operation is given — read_verification_code’s path', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      account('gmail', 'teammate@example.com', TEAMMATE),
    ]);

    const resolved = await resolveDefaultEmailAccount(CALLER);

    expect(resolved?.ownerUserId).toBe(TEAMMATE);
  });
});
