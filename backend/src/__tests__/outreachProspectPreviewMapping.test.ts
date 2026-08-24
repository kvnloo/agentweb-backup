/**
 * ENG-1198 follow-up — the anonymized sentinel must not become a preview URL.
 *
 * `mapUnipileItemToPreview` is pure, so this needs no service wiring. LinkedIn
 * returns out-of-network profiles with `public_identifier` set to the literal
 * string "undefined", and Unipile builds `profile_url` from that same value — so
 * both branches of the URL fallback could produce https://www.linkedin.com/in/undefined
 * and hand it to the FE as a real prospect link.
 */

import { mapUnipileItemToPreview } from '../services/outreachProspectPreviewService';

describe('mapUnipileItemToPreview — linkedin_url', () => {
  it('does not build a URL from the anonymized slug', () => {
    const mapped = mapUnipileItemToPreview({
      name: 'LinkedIn Member',
      public_identifier: 'undefined',
    });

    expect(mapped.linkedin_url).toBe('');
  });

  it('does not fall back to the fabricated profile_url either', () => {
    const mapped = mapUnipileItemToPreview({
      name: 'LinkedIn Member',
      profile_url: 'https://www.linkedin.com/in/undefined?miniProfileUrn=urn%3Ali%3Aabc',
    });

    expect(mapped.linkedin_url).toBe('');
  });

  it('builds the URL from a real slug', () => {
    const mapped = mapUnipileItemToPreview({
      name: 'Jennifer Sun',
      public_identifier: 'jennifer-sun-1a2b3c',
    });

    expect(mapped.linkedin_url).toBe('https://www.linkedin.com/in/jennifer-sun-1a2b3c');
  });

  it('still strips the tracking query off a real profile_url', () => {
    const mapped = mapUnipileItemToPreview({
      name: 'Jennifer Sun',
      profile_url: 'https://www.linkedin.com/in/jennifer-sun-1a2b3c?miniProfileUrn=urn%3Ali%3Aabc',
    });

    expect(mapped.linkedin_url).toBe('https://www.linkedin.com/in/jennifer-sun-1a2b3c');
  });

  it('leaves the id non-empty even when no URL survives (the FE keys on it)', () => {
    const mapped = mapUnipileItemToPreview({
      name: 'LinkedIn Member',
      provider_id: 'ACoAAA123',
      public_identifier: 'undefined',
    });

    expect(mapped.id).toBeTruthy();
  });
});
