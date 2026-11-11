import { detectLinkedInInviteSendBlock } from '../controllers/agentModeController';

// ENG-2900: session 817db5ee hit the step limit after send-invite returned
// "LinkedIn account disconnected"; the failure must name the dead account, not the step budget.
const call = (result: any, args: any = { action: 'send-invite', account_id: 'acc-1' }) => ({
  name: 'linkedin_outreach',
  arguments: args,
  success: false,
  result,
});

describe('detectLinkedInInviteSendBlock — disconnected account (ENG-2900)', () => {
  it('labels a disconnected-account send-invite failure as a reconnect block', () => {
    const block = detectLinkedInInviteSendBlock([
      call({
        success: false,
        message: 'LinkedIn account disconnected',
        error: 'The LinkedIn account is disconnected from Unipile and cannot be used for outreach.',
      }),
    ]);
    expect(block).not.toBeNull();
    expect(block!.accountId).toBe('acc-1');
    expect(block!.notice).toMatch(/disconnected/);
    expect(block!.notice).toMatch(/Settings > Connected Accounts/);
  });

  it('still labels the account-level cooldown as before', () => {
    const block = detectLinkedInInviteSendBlock([call({ success: false, error: 'Cannot resend yet' })]);
    expect(block!.notice).toMatch(/invitation cooldown/);
  });

  it('ignores a disconnected error on a non-invite action', () => {
    expect(
      detectLinkedInInviteSendBlock([
        call({ success: false, message: 'LinkedIn account disconnected' }, { action: 'get-profile' }),
      ]),
    ).toBeNull();
  });
});
