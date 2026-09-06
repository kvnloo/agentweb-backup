/**
 * ENG-1526 — the Google Ads tracking override must be bound to a disclosed approval.
 *
 * It used to be `args.override_tracking_check === true` and nothing else. The model could
 * set it unilaterally, and the only thing standing against that was a sentence in the tool
 * description ("Never set it on your own").
 *
 * ENG-941 wrote this threat model down for the Meta path and dismissed exactly that
 * defence — "an override the model can introduce after approval is not user-granted,
 * whatever the tool description says" — then hardened Meta and left Google on the sentence.
 *
 * These drive the real handler with a real HMAC. The mechanism is only worth anything if a
 * forged or borrowed token actually fails, so most of these are adversarial.
 */

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    resumeCampaign: jest.fn().mockResolvedValue(undefined),
    getCampaignFinalUrls: jest.fn().mockResolvedValue(['https://untagged.test']),
  },
}));

// Untagged page ⇒ the gate BLOCKS unless a valid override applies. That is what makes
// "did the override actually take effect?" observable in the result.
jest.mock('../services/googleAdsTrackingPreflight', () => ({
  preflightTrackingGate: jest.fn().mockResolvedValue({
    ok: false,
    results: [{ url: 'https://untagged.test', status: 'unmeasured', mechanisms: [], checkedFor: [] }],
    blockedUrls: ['https://untagged.test'],
    warnings: [],
    message: 'Launch blocked: pre-flight tracking check failed.',
  }),
  TRACKING_MECHANISMS: [],
}));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-eng-1526';

import { AgentModeService } from '../services/agentModeService';

const svc = new AgentModeService();

const baseArgs = {
  customer_id: '2883029950',
  entity_type: 'CAMPAIGN' as const,
  action: 'RESUME',
  campaign_resource_name: 'customers/2883029950/campaigns/1',
};

const call = (over: Record<string, any> = {}) =>
  svc.handleCallGoogleAdsApi('user-1', { ...baseArgs, ...over } as any, { sessionId: 's1' });

describe('ENG-1526 — a waiver the model cannot grant itself', () => {
  it('halts and discloses instead of silently waiving', async () => {
    const r = await call({ override_tracking_check: true });
    expect(r.awaitingUserConfirmation).toBe(true);
    expect(r.confirmationPrompt).toMatch(/WAIVE the pre-flight tracking check/i);
    // The consequence has to be in the prompt, not just the fact of the waiver.
    expect(r.confirmationPrompt).toMatch(/cannot report a conversion|cannot evaluate/i);
    expect(typeof r.tracking_override_token).toBe('string');
  });

  it('applies the waiver when the issued token is replayed with the same arguments', async () => {
    const halt = await call({ override_tracking_check: true });
    const r = await call({ override_tracking_check: true, tracking_override_token: halt.tracking_override_token });
    // Gate waived ⇒ the resume proceeded rather than returning a block.
    expect(r.awaitingUserConfirmation).toBeUndefined();
    expect(r.blocked).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it('refuses a forged token', async () => {
    const r = await call({ override_tracking_check: true, tracking_override_token: 'deadbeef'.repeat(8) });
    expect(r.awaitingUserConfirmation).toBe(true);
  });

  // The point of signing the CALL rather than issuing a bare permission slip: approval is
  // for the launch the user was shown, not for any launch afterwards.
  it('refuses a token issued for a different campaign', async () => {
    const halt = await call({ override_tracking_check: true });
    const r = await call({
      override_tracking_check: true,
      campaign_resource_name: 'customers/2883029950/campaigns/999',
      tracking_override_token: halt.tracking_override_token,
    });
    expect(r.awaitingUserConfirmation).toBe(true);
  });

  it('refuses a token issued for a different customer', async () => {
    const halt = await call({ override_tracking_check: true });
    const r = await call({
      override_tracking_check: true,
      customer_id: '9999999999',
      tracking_override_token: halt.tracking_override_token,
    });
    expect(r.awaitingUserConfirmation).toBe(true);
  });

  it('is key-order independent, so a re-emitted argument object still matches', async () => {
    const halt = await call({ override_tracking_check: true });
    const reordered = {
      tracking_override_token: halt.tracking_override_token,
      action: 'RESUME',
      override_tracking_check: true,
      campaign_resource_name: baseArgs.campaign_resource_name,
      entity_type: 'CAMPAIGN' as const,
      customer_id: baseArgs.customer_id,
    };
    const r = await svc.handleCallGoogleAdsApi('user-1', reordered as any, { sessionId: 's1' });
    expect(r.awaitingUserConfirmation).toBeUndefined();
  });

  // A call that waives nothing must be completely untouched — no token, no halt, and the
  // gate still doing its job.
  it('leaves a non-override call alone, and still blocks it', async () => {
    const r = await call({});
    expect(r.awaitingUserConfirmation).toBeUndefined();
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('tracking_preflight');
  });

  it('does not treat a truthy-but-not-true flag as a claim', async () => {
    const r = await call({ override_tracking_check: 'yes' as any });
    expect(r.awaitingUserConfirmation).toBeUndefined();
    expect(r.blocked).toBe(true);
  });

  it('ignores a token supplied without the override flag', async () => {
    const halt = await call({ override_tracking_check: true });
    const r = await call({ tracking_override_token: halt.tracking_override_token });
    expect(r.blocked).toBe(true);
  });
});
