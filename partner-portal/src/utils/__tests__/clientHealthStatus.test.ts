import { adsLayerConnection, campaignCountLabel, deriveQuickStatus, quickSummary } from '../clientHealthStatus';

const base = { has_ads: true, has_lander: true, has_crm: true };

describe('deriveQuickStatus (ENG-2133)', () => {
  it('never-connected ads is onboarding, not at-risk or blocked — even with nothing else set up', () => {
    expect(deriveQuickStatus({ ...base, has_ads: false, ad_connection: 'never_connected' })).toBe('onboarding');
    expect(deriveQuickStatus({ has_ads: false, ad_connection: 'never_connected', has_lander: false, has_crm: false }))
      .toBe('onboarding');
  });

  // ENG-2188: this test previously asserted 'at-risk'. An expired token is reconnect work.
  it('an expired ad connection needs attention, not at-risk', () => {
    expect(deriveQuickStatus({ ...base, ad_connection: 'expired' })).toBe('needs-attention');
    expect(deriveQuickStatus({ ...base, ad_connection: 'expired', ad_connection_all_platforms: 'expired' }))
      .toBe('needs-attention');
  });

  it('connected ads keep the healthy / mediocre split on lander and CRM', () => {
    expect(deriveQuickStatus({ ...base, ad_connection: 'connected' })).toBe('healthy');
    expect(deriveQuickStatus({ ...base, ad_connection: 'connected', has_crm: false })).toBe('mediocre');
  });

  it('treats ads on Google/LinkedIn as activated, split on lander and CRM like connected', () => {
    expect(deriveQuickStatus({ ...base, has_ads: false, ad_connection: 'other_platform' })).toBe('healthy');
    expect(deriveQuickStatus({ ...base, has_ads: false, ad_connection: 'other_platform', has_crm: false })).toBe('mediocre');
    expect(quickSummary({ ...base, has_ads: false, ad_connection: 'other_platform' })).toBe('Ads on Google/LinkedIn');
  });

  it('falls back to has_ads when an older backend omits ad_connection', () => {
    expect(deriveQuickStatus({ ...base, has_ads: false })).toBe('onboarding');
    expect(deriveQuickStatus(base)).toBe('healthy');
  });
});

describe('deriveQuickStatus across ad platforms (ENG-2188)', () => {
  it('an expired Meta token with Google/LinkedIn still connected is not an expiry', () => {
    expect(deriveQuickStatus({ ...base, ad_connection: 'expired', ad_connection_all_platforms: 'connected' })).toBe('healthy');
    expect(quickSummary({ ...base, ad_connection: 'expired', ad_connection_all_platforms: 'connected' }))
      .toBe('Meta connection expired — reconnect needed');
  });

  it('an expired Google/LinkedIn-only connection needs attention', () => {
    expect(deriveQuickStatus({ ...base, has_ads: false, ad_connection: 'other_platform', ad_connection_all_platforms: 'expired' }))
      .toBe('needs-attention');
  });

  it('never shows at-risk from roster flags, whatever the setup gaps', () => {
    const connections = ['never_connected', 'connected', 'expired', 'other_platform'] as const;
    const allPlatforms = [undefined, 'never_connected', 'connected', 'expired'] as const;
    for (const ad_connection of connections) {
      for (const ad_connection_all_platforms of allPlatforms) {
        for (const has_lander of [true, false]) {
          for (const has_crm of [true, false]) {
            const status = deriveQuickStatus({ has_ads: true, ad_connection, ad_connection_all_platforms, has_lander, has_crm });
            expect(status).not.toBe('at-risk');
          }
        }
      }
    }
  });
});

describe('quickSummary (ENG-2133)', () => {
  it('names activation and expiry distinctly', () => {
    expect(quickSummary({ ...base, has_ads: false, ad_connection: 'never_connected' })).toBe('Ads not connected yet');
    expect(quickSummary({ ...base, ad_connection: 'expired' })).toBe('Ad connection expired — reconnect needed');
    expect(quickSummary({ ...base, ad_connection: 'connected' })).toBe('All layers connected');
  });
});

describe('adsLayerConnection (ENG-2133, #3070 review)', () => {
  it('prefers connection and falls back to connected for older responses', () => {
    expect(adsLayerConnection({ connected: true, connection: 'expired' })).toBe('expired');
    expect(adsLayerConnection({ connected: false, connection: 'never_connected' })).toBe('never_connected');
    expect(adsLayerConnection({ connected: true })).toBe('connected');
    expect(adsLayerConnection({ connected: false })).toBe('never_connected');
  });
});

describe('campaignCountLabel (ENG-2133, #3070 review)', () => {
  it('never presents an incomplete read as a confirmed count', () => {
    expect(campaignCountLabel({ active_campaigns: 3, campaigns_complete: true })).toBe('3');
    expect(campaignCountLabel({ active_campaigns: 3 })).toBe('3');
    expect(campaignCountLabel({ active_campaigns: 2, campaigns_complete: false })).toBe('2+ (read incomplete)');
    expect(campaignCountLabel({ active_campaigns: 0, campaigns_complete: false })).toBe('Unconfirmed (read incomplete)');
  });
});
