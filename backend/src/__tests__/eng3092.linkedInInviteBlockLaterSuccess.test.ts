import { detectLinkedInInviteSendBlock } from '../controllers/agentModeController';

// ENG-3092: session 97d98044 sent 10 invitations on a second account after the first
// account was refused as disconnected, and the owner was still told "No invitations can be sent".

const DISCONNECTED =
  'The LinkedIn account is disconnected from Unipile and cannot be used for outreach.\n\n' +
  'Next steps:\n1. Go to Settings > Connected Accounts and click Reconnect on your LinkedIn account.';
const DAILY_CEILING =
  "This LinkedIn account has already sent 10 LinkedIn connection requests in the last 24 hours, which is today's safety ceiling of 10 " +
  "(this account's configured daily cap — raise it in Settings or ask Emma to update it if you have LinkedIn Premium). " +
  'Remaining actions should be left for a later run.\n\nThis is a deliberate daily safety limit on our side, not a LinkedIn rejection.';
const IDENTITY =
  'Refused to send: the LinkedIn profile at https://www.linkedin.com/in/example does not appear to belong to this lead (Lead Name, Company). ' +
  "Verify or correct the lead's LinkedIn URL before contacting them.";

const invite = (accountId: string | undefined, error?: string) => ({
  name: 'linkedin_outreach',
  arguments: { action: 'send-invite', ...(accountId ? { account_id: accountId } : {}) },
  result: {},
  ...(error ? { error } : {}),
});
const sent = (accountId?: string) => invite(accountId);

describe('detectLinkedInInviteSendBlock: a later send on another account (ENG-3092)', () => {
  it('gives no notice for the sanitized ledger of session 97d98044', () => {
    // Stored order of the 21 send-invite calls: 5 disconnected on acct-a, then on acct-b
    // sent, identity, 8 sent, ceiling, ceiling, sent, ceiling, identity, identity.
    const ledger = [
      ...Array.from({ length: 5 }, () => invite('acct-a', DISCONNECTED)),
      sent('acct-b'),
      invite('acct-b', IDENTITY),
      ...Array.from({ length: 8 }, () => sent('acct-b')),
      invite('acct-b', DAILY_CEILING),
      invite('acct-b', DAILY_CEILING),
      sent('acct-b'),
      invite('acct-b', DAILY_CEILING),
      invite('acct-b', IDENTITY),
      invite('acct-b', IDENTITY),
    ];
    expect(ledger.filter((c) => !('error' in c))).toHaveLength(10);
    expect(detectLinkedInInviteSendBlock(ledger)).toBeNull();
  });

  it('gives no disconnected notice when one later invite succeeds on a different account', () => {
    expect(detectLinkedInInviteSendBlock([invite('acct-a', DISCONNECTED), sent('acct-b')])).toBeNull();
  });

  it('gives no cooldown notice when a later invite succeeds on a different account', () => {
    expect(detectLinkedInInviteSendBlock([invite('acct-a', 'Cannot resend yet'), sent('acct-b')])).toBeNull();
  });

  it('keeps the notice when there is no later invite (session 5ce91f8f shape)', () => {
    const block = detectLinkedInInviteSendBlock([invite('acct-a', DISCONNECTED)]);
    expect(block!.notice).toMatch(/No invitations can be sent/);
    expect(block!.accountId).toBe('acct-a');
  });

  it('keeps the notice when every later invite also fails, including on another account', () => {
    const block = detectLinkedInInviteSendBlock([
      invite('acct-a', DISCONNECTED),
      invite('acct-a', DISCONNECTED),
      invite('acct-b', DISCONNECTED),
    ]);
    expect(block!.notice).toMatch(/No invitations can be sent/);
    expect(block!.accountId).toBe('acct-a');
  });

  it('keeps the notice when the only success came before the failure', () => {
    const block = detectLinkedInInviteSendBlock([sent('acct-b'), invite('acct-a', DISCONNECTED)]);
    expect(block!.notice).toMatch(/disconnected/);
  });

  it('keeps the cooldown notice when the later success is on the same account', () => {
    const block = detectLinkedInInviteSendBlock([invite('acct-a', 'Cannot resend yet'), sent('acct-a')]);
    expect(block!.notice).toMatch(/invitation cooldown/);
  });

  it('keeps the notice when neither call names an account', () => {
    const block = detectLinkedInInviteSendBlock([invite(undefined, DISCONNECTED), sent(undefined)]);
    expect(block!.notice).toMatch(/disconnected/);
  });

  it('reports the block on the second account when the first was covered by a later success', () => {
    const block = detectLinkedInInviteSendBlock([
      invite('acct-a', DISCONNECTED),
      sent('acct-b'),
      invite('acct-b', 'Cannot resend yet'),
    ]);
    expect(block!.accountId).toBe('acct-b');
    expect(block!.notice).toMatch(/invitation cooldown/);
  });
});
