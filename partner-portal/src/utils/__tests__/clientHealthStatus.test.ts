import { deriveQuickStatus, quickSummary } from '../clientHealthStatus';

const base = { has_ads: true, has_lander: true, has_crm: true };

describe('deriveQuickStatus (ENG-2133)', () => {
  it('never-connected ads is onboarding, not at-risk or blocked — even with nothing else set up', () => {
    expect(deriveQuickStatus({ ...base, has_ads: false, ad_connection: 'never_connected' })).toBe('onboarding');
    expect(deriveQuickStatus({ has_ads: false, ad_connection: 'never_connected', has_lander: false, has_crm: false }))
      .toBe('onboarding');
  });

  it('an expired ad connection is at-risk', () => {
    expect(deriveQuickStatus({ ...base, ad_connection: 'expired' })).toBe('at-risk');
  });

  it('connected ads keep the healthy / mediocre split on lander and CRM', () => {
    expect(deriveQuickStatus({ ...base, ad_connection: 'connected' })).toBe('healthy');
    expect(deriveQuickStatus({ ...base, ad_connection: 'connected', has_crm: false })).toBe('mediocre');
  });

  it('falls back to has_ads when an older backend omits ad_connection', () => {
    expect(deriveQuickStatus({ ...base, has_ads: false })).toBe('onboarding');
    expect(deriveQuickStatus(base)).toBe('healthy');
  });
});

describe('quickSummary (ENG-2133)', () => {
  it('names activation and expiry distinctly', () => {
    expect(quickSummary({ ...base, has_ads: false, ad_connection: 'never_connected' })).toBe('Ads not connected yet');
    expect(quickSummary({ ...base, ad_connection: 'expired' })).toBe('Ad connection expired');
    expect(quickSummary({ ...base, ad_connection: 'connected' })).toBe('All layers connected');
  });
});
