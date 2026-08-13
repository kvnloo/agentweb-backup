/**
 * Tests for the `email` Emma tool's account resolution (ENG-943).
 *
 * list_connected_accounts reports every mailbox the caller can reach, including
 * one a teammate shared with the org. Those mailboxes live in the OWNER's user
 * record, which is where the provider reads and refreshes its OAuth tokens — so
 * every provider call has to be made with the resolved ownerUserId, not the
 * caller's userId. Making them as the caller is exactly what produced the
 * ticket's 'Connected account "..." not found' on search/list/get.
 */

const mockResolveEmailAccount = jest.fn();
const mockSearchEmails = jest.fn();
const mockListEmails = jest.fn();
const mockGetEmails = jest.fn();
const mockSendEmail = jest.fn();

class MockEmailProviderError extends Error {}

const mockAssertStillAccessible = jest.fn();

jest.mock('../../services/emailProviderService', () => ({
  bootstrapEmailProviders: jest.fn().mockResolvedValue(undefined),
  resolveEmailAccount: (...args: any[]) => mockResolveEmailAccount(...args),
  // Re-checked at the last moment before the provider is called with the
  // owner's credentials — see assertStillAccessible.
  assertStillAccessible: (...args: any[]) => mockAssertStillAccessible(...args),
  // Guards each provider call on both sides; the real one re-checks sharing
  // before the call and again before the result is returned.
  withAccessGuard: (_u: any, _r: any, _o: any, read: () => any) => read(),
  EmailProviderError: MockEmailProviderError,
}));

import { emmaToolRegistry } from '../../emma/registry';

// Import tools.ts to ensure tools are registered.
import '../../emma/tools';

const tool = emmaToolRegistry.getTool('email');
if (!tool) throw new Error('email tool not registered');

/** The caller running the scheduled report. */
const CALLER_USER_ID = 'user-caller-123';
/** The teammate whose Gmail is shared with the org — where the tokens live. */
const OWNER_USER_ID = 'user-owner-456';
const ACCOUNT_ID = 'harsha@agentweb.pro';

const context = { userId: CALLER_USER_ID, sessionId: 'session-abc', llmModel: 'test-model' };

const PROVIDER = {
  searchEmails: (...args: any[]) => mockSearchEmails(...args),
  listEmails: (...args: any[]) => mockListEmails(...args),
  getEmails: (...args: any[]) => mockGetEmails(...args),
  sendEmail: (...args: any[]) => mockSendEmail(...args),
};

/** An org-shared mailbox: reachable by the caller, owned by someone else. */
const ORG_SHARED_ACCOUNT = {
  platform: 'gmail',
  provider: PROVIDER,
  accountId: ACCOUNT_ID,
  ownerUserId: OWNER_USER_ID,
};

const MESSAGE = { id: 'msg-1', threadId: 't-1', subject: 'Your RankAI Login Code', from: 'no-reply@rankai.ai' };

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveEmailAccount.mockResolvedValue(ORG_SHARED_ACCOUNT);
  mockSearchEmails.mockResolvedValue([MESSAGE]);
  mockListEmails.mockResolvedValue([MESSAGE]);
  mockGetEmails.mockResolvedValue([MESSAGE]);
  mockSendEmail.mockResolvedValue({ messageId: 'msg-sent', threadId: 't-1' });
});

describe('email tool — org-shared mailbox resolution', () => {
  it('resolves a read for the caller', async () => {
    await tool.execute({ action: 'list', account_id: ACCOUNT_ID }, context);
    expect(mockResolveEmailAccount).toHaveBeenCalledWith(CALLER_USER_ID, ACCOUNT_ID, 'read');
  });

  it('searches as the mailbox owner, not the caller', async () => {
    const result = await tool.execute(
      { action: 'search', account_id: ACCOUNT_ID, query: 'from:rankai.ai newer_than:1d' },
      context
    );

    expect(mockSearchEmails).toHaveBeenCalledWith(OWNER_USER_ID, ACCOUNT_ID, 'from:rankai.ai newer_than:1d', 10);
    expect(mockSearchEmails).not.toHaveBeenCalledWith(CALLER_USER_ID, ACCOUNT_ID, expect.anything(), expect.anything());
    expect(result).toEqual({ emails: [MESSAGE], count: 1 });
  });

  it('lists as the mailbox owner, not the caller', async () => {
    const result = await tool.execute({ action: 'list', account_id: ACCOUNT_ID, folder: 'INBOX' }, context);

    expect(mockListEmails).toHaveBeenCalledWith(OWNER_USER_ID, ACCOUNT_ID, 'INBOX', 20);
    expect(mockListEmails).not.toHaveBeenCalledWith(CALLER_USER_ID, ACCOUNT_ID, expect.anything(), expect.anything());
    expect(result).toEqual({ emails: [MESSAGE], count: 1 });
  });

  it('gets messages as the mailbox owner, not the caller', async () => {
    const result = await tool.execute(
      { action: 'get', account_id: ACCOUNT_ID, message_ids: ['msg-1'] },
      context
    );

    expect(mockGetEmails).toHaveBeenCalledWith(OWNER_USER_ID, ACCOUNT_ID, ['msg-1']);
    expect(mockGetEmails).not.toHaveBeenCalledWith(CALLER_USER_ID, ACCOUNT_ID, expect.anything());
    expect(result).toEqual({ emails: [MESSAGE], count: 1 });
  });

  it('resolves a send as a write, so a teammate’s mailbox can be refused', async () => {
    mockResolveEmailAccount.mockResolvedValue({ ...ORG_SHARED_ACCOUNT, ownerUserId: CALLER_USER_ID });

    await tool.execute(
      { action: 'send', account_id: ACCOUNT_ID, to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
      context
    );

    expect(mockResolveEmailAccount).toHaveBeenCalledWith(CALLER_USER_ID, ACCOUNT_ID, 'send');
  });

  it('sends from the caller’s own mailbox', async () => {
    mockResolveEmailAccount.mockResolvedValue({ ...ORG_SHARED_ACCOUNT, ownerUserId: CALLER_USER_ID });

    const result = await tool.execute(
      { action: 'send', account_id: ACCOUNT_ID, to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
      context
    );

    expect(mockSendEmail).toHaveBeenCalledWith(
      CALLER_USER_ID,
      ACCOUNT_ID,
      expect.objectContaining({ to: 'someone@example.com', subject: 'Hi', body: 'Hello' })
    );
    expect(result).toEqual({ success: true, messageId: 'msg-sent', threadId: 't-1' });
  });

  it('surfaces the send refusal on a teammate’s shared mailbox as an error', async () => {
    mockResolveEmailAccount.mockRejectedValue(
      new MockEmailProviderError(
        `Account "${ACCOUNT_ID}" belongs to a teammate and is shared with your organization for reading only.`
      )
    );

    const result = await tool.execute(
      { action: 'send', account_id: ACCOUNT_ID, to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
      context
    );

    expect(result.error).toContain('reading only');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('reads the caller\'s own mailbox as the caller', async () => {
    mockResolveEmailAccount.mockResolvedValue({ ...ORG_SHARED_ACCOUNT, ownerUserId: CALLER_USER_ID });

    await tool.execute({ action: 'list', account_id: ACCOUNT_ID }, context);

    expect(mockListEmails).toHaveBeenCalledWith(CALLER_USER_ID, ACCOUNT_ID, 'INBOX', 20);
  });

  it('surfaces an unresolvable account as an error rather than throwing', async () => {
    mockResolveEmailAccount.mockRejectedValue(
      new Error(`Connected account "${ACCOUNT_ID}" not found. Use list_connected_accounts to get valid account IDs.`)
    );

    const result = await tool.execute({ action: 'list', account_id: ACCOUNT_ID }, context);

    expect(result.error).toContain('not found');
    expect(mockListEmails).not.toHaveBeenCalled();
  });
});
