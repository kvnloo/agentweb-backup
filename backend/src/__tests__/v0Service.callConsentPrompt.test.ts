/** ENG-2783: what the platform tells the AI site builder about the call-consent notice, and what the capture route forwards. */
import { buildBrandEnrichedPrompt, buildBrandContextFromUser, buildCaptureRoute, registeredBusinessNameOf, type BrandContext } from '../services/v0Service';
import { buildCallConsentNotice } from '../services/voice/callConsent';

describe('call-consent notice in the generator prompt', () => {
  it('business name known: the exact notice with the real name, the unchecked required-when-phone checkbox and the callConsent body, no brackets', () => {
    const brand: BrandContext = { brandName: 'Acme', registeredBusinessName: 'Acme Plumbing LLC' };
    const p = buildBrandEnrichedPrompt('p', brand, 'list1');
    expect(p).toContain('collecting: email (required), firstName, lastName, company, phone');
    expect(p).toContain('CALL CONSENT');
    expect(p).toContain('UNCHECKED by default');
    expect(p).toContain('WHEN a phone number was entered');
    expect(p).toContain('Directly ABOVE the submit button');
    expect(p).toContain(JSON.stringify(buildCallConsentNotice('Acme Plumbing LLC')));
    expect(buildCallConsentNotice('Acme Plumbing LLC')).toBe(
      'By checking this box and submitting, I agree that Acme Plumbing LLC may call me at the number above about my enquiry, including automated calls that use a computer-generated voice. Agreeing is not a condition of purchase. I can stop calls at any time by pressing 3 on a call.',
    );
    expect(p).toContain('callConsent: { granted: <the checkbox state, a boolean>, text: CALL_CONSENT_TEXT, version: "v1" }');
    expect(p).not.toMatch(/\[[^\]]*name[^\]]*\]/i);
    expect(p).not.toMatch(/registered business name/i);
  });

  it('business name unknown: NO notice block at all and no placeholder text anywhere (the page then records no consent)', () => {
    const p = buildBrandEnrichedPrompt('p', { brandName: 'Acme' }, 'list1');
    expect(p).toContain('LEAD CAPTURE FORM');
    expect(p).not.toContain('CALL CONSENT');
    expect(p).not.toContain('callConsent');
    expect(p).not.toMatch(/\[[^\]]*name[^\]]*\]/i);
    expect(p).not.toMatch(/registered business name/i);
  });

  it('no lead capture form (no lead list): no call-consent instruction even with a name', () => {
    const p = buildBrandEnrichedPrompt('p', { registeredBusinessName: 'Acme Plumbing LLC' }, undefined);
    expect(p).not.toContain('CALL CONSENT');
  });
});

describe('where the business name comes from (already-loaded data only)', () => {
  it('prefers the hot-lead-call announced name, then the account company name, then the org name, else none', () => {
    expect(registeredBusinessNameOf({ name: 'Org Name', hotLeadCall: { announcedName: 'Acme Plumbing' } }, { companyName: 'Acme Co' })).toBe('Acme Plumbing');
    expect(registeredBusinessNameOf({ name: 'Org Name' }, { companyName: 'Acme Co' })).toBe('Acme Co');
    expect(registeredBusinessNameOf({ name: 'Org Name' }, {})).toBe('Org Name');
    expect(registeredBusinessNameOf({}, {})).toBeUndefined();
    expect(registeredBusinessNameOf(null, undefined)).toBeUndefined();
  });
  it('skips a candidate with brackets, quotes or angle brackets (it could be a placeholder or break the prompt)', () => {
    expect(registeredBusinessNameOf({ name: '[NAME]' }, { companyName: 'Acme "Best" Co' })).toBeUndefined();
    expect(registeredBusinessNameOf({ name: 'Real Org' }, { companyName: '[YOUR COMPANY NAME]' })).toBe('Real Org');
  });
  it('buildBrandContextFromUser carries it, and omits it when nothing is known', () => {
    expect(buildBrandContextFromUser({ companyName: 'Acme Co' }, undefined, { name: 'Org' }).registeredBusinessName).toBe('Acme Co');
    expect(buildBrandContextFromUser({}, undefined, null).registeredBusinessName).toBeUndefined();
  });
});

describe('platform capture route', () => {
  const route = buildCaptureRoute({ '/': 'list_1' }, 'https://api.example.test');
  it('forwards the visitor page (Referer) as visitorPageUrl and keeps spreading the body (callConsent rides along)', () => {
    expect(route).toContain('visitorPageUrl = (h.get("referer") || "").trim()');
    expect(route).toContain('...(visitorPageUrl ? { visitorPageUrl } : {})');
    expect(route).toContain('...body,');
  });
});
