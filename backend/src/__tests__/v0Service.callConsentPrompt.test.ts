/** ENG-2783: what the platform tells the AI site builder about the call-consent notice, and what the capture route forwards. */
import { buildBrandEnrichedPrompt, buildCaptureRoute, type BrandContext } from '../services/v0Service';
import { buildCallConsentNotice, CALL_CONSENT_NAME_PLACEHOLDER } from '../services/voice/callConsent';

describe('call-consent notice in the generator prompt', () => {
  it('a lead capture form (phone collected): unchecked required-when-phone checkbox, the exact label with the placeholder name, and the callConsent body', () => {
    const p = buildBrandEnrichedPrompt('p', { brandName: 'Acme' } as BrandContext, 'list1');
    const label = buildCallConsentNotice(CALL_CONSENT_NAME_PLACEHOLDER);
    expect(p).toContain('collecting: email (required), firstName, lastName, company, phone');
    expect(p).toContain('CALL CONSENT');
    expect(p).toContain('UNCHECKED by default');
    expect(p).toContain('WHEN a phone number was entered');
    expect(p).toContain('directly ABOVE the submit button'.replace('directly', 'Directly'));
    expect(p).toContain(JSON.stringify(label));
    expect(label).toBe(
      'By checking this box and submitting, I agree that [REGISTERED BUSINESS NAME] may call me at the number above about my enquiry, including automated calls that use a computer-generated voice. Agreeing is not a condition of purchase. I can stop calls at any time by pressing 3 on a call.',
    );
    expect(p).toContain(`callConsent: { granted: <the checkbox state, a boolean>, text: CALL_CONSENT_TEXT, version: "v1" }`);
    // No registered-name source: the builder must leave the placeholder and not invent a name (brandName is a marketing name).
    expect(p).toContain('Leave the placeholder EXACTLY as written');
    expect(p).not.toContain('may call me'.concat(' ', 'Acme'));
    expect(p).not.toContain('I agree that Acme');
  });

  it('with a registered business name known, the label carries it and no placeholder instruction is given', () => {
    const p = buildBrandEnrichedPrompt('p', { brandName: 'Acme', registeredBusinessName: 'Acme Plumbing LLC' } as BrandContext, 'list1');
    expect(p).toContain(JSON.stringify(buildCallConsentNotice('Acme Plumbing LLC')));
    expect(p).not.toContain(CALL_CONSENT_NAME_PLACEHOLDER);
    expect(p).not.toContain('Leave the placeholder');
  });

  it('no lead capture form (no lead list, so no phone is collected): no call-consent instruction at all', () => {
    const p = buildBrandEnrichedPrompt('p', { brandName: 'Acme' } as BrandContext, undefined);
    expect(p).not.toContain('CALL CONSENT');
    expect(p).not.toContain('callConsent');
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
