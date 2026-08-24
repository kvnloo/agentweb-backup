/**
 * ENG-1523 — a refused launch must survive the trip to the browser.
 *
 * RULE 7.5 refuses correctly. What the user saw was a green success tick, because
 * three things lined up:
 *
 *   1. `extractMinimalToolResult` had no branch for `call_google_ads_api`, so the
 *      block payload fell through to `return {}` — the reason was destroyed
 *      SERVER-SIDE, before any frontend could render it.
 *   2. A block is a RETURNED value, not a throw, so `toolCall.error` is never set.
 *   3. The frontend status ternary is `error ? 'error' : awaitingUserConfirmation
 *      ? 'awaiting_confirmation' : 'completed'` — with neither field present it
 *      resolves to 'completed', which paints green.
 *
 * This suite covers link 1, which is the prerequisite: while the backend deletes the
 * payload, no frontend change can recover it.
 *
 * Asserts on the MINIMIZED result rather than the gate's return value, because the
 * gate was always correct — the loss happened downstream of it.
 */

import { AgentModeService } from '../services/agentModeService';

// The minimizer is private; it is the unit under test, and testing it through a full
// tool dispatch would prove far less about the branch that actually runs.
const minimize = (result: any, toolName: string) =>
  (AgentModeService.prototype as any)['extractMinimalToolResult'].call(
    Object.create(AgentModeService.prototype),
    result,
    toolName,
  );

/** The exact shape runGoogleAdsTrackingGate returns on a refusal. */
const BLOCK = {
  success: false,
  blocked: true,
  reason: 'tracking_preflight',
  error:
    'Launch blocked: pre-flight tracking check failed. These final URLs are not measurable...',
  trackingCheck: {
    measured: false,
    urlResults: [{ url: 'https://example.test', status: 'unmeasured', mechanisms: [] }],
  },
};

describe('ENG-1523 — the refusal reaches the browser', () => {
  it('preserves the block reason for call_google_ads_api', () => {
    const out = minimize(BLOCK, 'call_google_ads_api');
    expect(out.blocked).toBe(true);
    expect(out.success).toBe(false);
    expect(out.reason).toBe('tracking_preflight');
    expect(out.error).toMatch(/Launch blocked/);
  });

  it('preserves the per-URL evidence, so the UI can say WHICH url failed', () => {
    const out = minimize(BLOCK, 'call_google_ads_api');
    expect(out.trackingCheck.urlResults[0].url).toBe('https://example.test');
    expect(out.trackingCheck.measured).toBe(false);
  });

  // metaLaunchGate returns this identical shape in five places, so the erasure was
  // never Google-only. Keying on the payload rather than the tool name covers both,
  // and any future gate, without another branch in the minimizer.
  it('preserves a Meta launch block too — same shape, same erasure', () => {
    const out = minimize(BLOCK, 'call_meta_ads_api');
    expect(out.blocked).toBe(true);
    expect(out.error).toMatch(/Launch blocked/);
  });

  it('preserves a block from a tool that has no minimizer branch at all', () => {
    const out = minimize(BLOCK, 'some_future_gated_tool');
    expect(out.blocked).toBe(true);
  });

  // ENG-1358: measurable, but nothing proves an Ads conversion can be recorded. The
  // gate computes this and its callers relay it deliberately; the minimizer used to
  // discard it one layer later, which is the same outcome by a longer route.
  it('preserves the ENG-1358 warning on a PERMITTED launch', () => {
    const out = minimize(
      { success: true, message: 'Campaign resumed', trackingWarning: 'found GA4:G-KKJE0Q33LF, but no Google Ads conversion tag' },
      'call_google_ads_api',
    );
    expect(out.success).toBe(true);
    expect(out.trackingWarning).toMatch(/no Google Ads conversion tag/);
    expect(out.message).toBe('Campaign resumed');
  });

  // CodeRabbit caught this on review: the comment claimed the result was merged, the
  // code returned three fields, and the created resource's id was dropped. Warning the
  // operator while losing the thing the warning is ABOUT is its own bug — the ledger
  // would say a resource was created without saying which.
  it('keeps the created resource id alongside an AD CREATE warning', () => {
    const out = minimize(
      { success: true, adResourceName: 'customers/123/adGroupAds/1~2', trackingWarning: 'no AW- tag on the final url' },
      'call_google_ads_api',
    );
    expect(out.adResourceName).toBe('customers/123/adGroupAds/1~2');
    expect(out.trackingWarning).toMatch(/no AW- tag/);
  });

  it('keeps the asset group id alongside an ASSET_GROUP CREATE warning', () => {
    const out = minimize(
      { success: true, assetGroupResourceName: 'customers/123/assetGroups/9', trackingWarning: 'w' },
      'call_google_ads_api',
    );
    expect(out.assetGroupResourceName).toBe('customers/123/assetGroups/9');
  });

  // Carried by suffix so a future producer is covered without another edit here...
  it('carries any *ResourceName a future producer attaches', () => {
    const out = minimize({ success: true, campaignResourceName: 'customers/1/campaigns/2', trackingWarning: 'w' }, 'call_google_ads_api');
    expect(out.campaignResourceName).toBe('customers/1/campaigns/2');
  });

  // ...but this must stay a MINIMIZER. A warning must not become a hole that lets an
  // arbitrary payload ride along.
  it('does not let arrays or objects ride along on a warning', () => {
    const out = minimize(
      { success: true, trackingWarning: 'w', campaigns: [{ id: '1' }], someObject: { big: true }, count: 42 },
      'call_google_ads_api',
    );
    expect(out.campaigns).toBeUndefined();
    expect(out.someObject).toBeUndefined();
    expect(out.count).toBeUndefined();
  });

  // The whole point of the minimizer is to keep stored payloads small. The fix must
  // not become a hole that preserves everything.
  it('still minimizes an ordinary success to nothing', () => {
    const out = minimize({ success: true, campaigns: [{ id: '1' }, { id: '2' }] }, 'call_google_ads_api');
    expect(out.blocked).toBeUndefined();
    expect(out.campaigns).toBeUndefined();
  });

  it('does not treat a falsy blocked flag as a block', () => {
    const out = minimize({ success: true, blocked: false, message: 'Campaign resumed' }, 'call_google_ads_api');
    expect(out.blocked).toBeUndefined();
  });

  // The confirmation gate is checked first and must keep winning: a call that both
  // halts for approval and carries a warning is still awaiting the human.
  it('leaves the confirmation gate ahead of the new branches', () => {
    const out = minimize(
      { awaitingUserConfirmation: true, confirmationPrompt: 'Enable this campaign?', trackingWarning: 'x' },
      'call_meta_ads_api',
    );
    expect(out.awaitingUserConfirmation).toBe(true);
    expect(out.confirmationPrompt).toBe('Enable this campaign?');
  });
});
