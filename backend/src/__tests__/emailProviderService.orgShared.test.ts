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
