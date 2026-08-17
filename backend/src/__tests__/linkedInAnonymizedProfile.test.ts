/**
 * ENG-1198 follow-up — one definition of "LinkedIn anonymized this".
 *
 * ENG-1198 fixed three call sites with three separate inline comparisons and left
 * one half of the problem open: Unipile also sends `public_profile_url` already
 * built from the bad identifier, so a caller that correctly rejected the identifier
 * still recreated the fake URL from its own fallback field.
 */

import {
  isAnonymizedIdentifier,
  isFabricatedProfileUrl,
  usablePublicIdentifier,
  usableProfileUrl,
} from '../utils/linkedInAnonymizedProfile';

describe('isAnonymizedIdentifier', () => {
  it('catches the literal string LinkedIn actually sends', () => {
    // Not null, not absent — the four-letter string, which is truthy and so
    // survives every naive `identifier ? ... : null` guard.
    expect(isAnonymizedIdentifier('undefined')).toBe(true);
  });

  it('does not touch a real slug, including ones containing the word', () => {
    expect(isAnonymizedIdentifier('powell-li-wang-63692786')).toBe(false);
    expect(isAnonymizedIdentifier('undefined-industries-ceo')).toBe(false);
  });

  it('is not fooled by a genuinely absent value', () => {
    expect(isAnonymizedIdentifier(undefined)).toBe(false);
    expect(isAnonymizedIdentifier(null)).toBe(false);
  });
});

describe('isFabricatedProfileUrl', () => {
  it('catches the URL Unipile builds from the placeholder', () => {
    expect(isFabricatedProfileUrl('https://www.linkedin.com/in/undefined')).toBe(true);
    expect(isFabricatedProfileUrl('https://www.linkedin.com/in/undefined/')).toBe(true);
    expect(isFabricatedProfileUrl('https://www.linkedin.com/in/undefined?trk=x')).toBe(true);
  });

  it('catches a fabricated URL carrying a fragment', () => {
    // split('?') alone leaves '#about' attached, which pushes the path off the end
    // of the anchored match and let the fake URL through.
    expect(isFabricatedProfileUrl('https://www.linkedin.com/in/undefined#about')).toBe(true);
    expect(isFabricatedProfileUrl('https://www.linkedin.com/in/undefined/?x=1#exp')).toBe(true);
    expect(usableProfileUrl('https://www.linkedin.com/in/undefined#about')).toBeNull();
  });

  it('strips a fragment from a real URL too', () => {
    expect(usableProfileUrl('https://www.linkedin.com/in/jian-liang#experience')).toBe(
      'https://www.linkedin.com/in/jian-liang',
    );
  });

  it('leaves a real profile URL alone, including a slug ending in the word', () => {
    expect(isFabricatedProfileUrl('https://www.linkedin.com/in/li-wang-cpa-5035b311')).toBe(false);
    // Guards the regex: only the WHOLE final segment counts, not a suffix.
    expect(isFabricatedProfileUrl('https://www.linkedin.com/in/notundefined')).toBe(false);
  });

  it('handles non-strings without throwing', () => {
    expect(isFabricatedProfileUrl(undefined)).toBe(false);
    expect(isFabricatedProfileUrl(null)).toBe(false);
    expect(isFabricatedProfileUrl(42)).toBe(false);
  });
});

describe('usablePublicIdentifier', () => {
  it('collapses both failure shapes to null', () => {
    expect(usablePublicIdentifier('undefined')).toBeNull();
    expect(usablePublicIdentifier('')).toBeNull();
    expect(usablePublicIdentifier('   ')).toBeNull();
    expect(usablePublicIdentifier(undefined)).toBeNull();
  });

  it('returns a real slug, trimmed', () => {
    expect(usablePublicIdentifier(' powell-li-wang-63692786 ')).toBe('powell-li-wang-63692786');
  });
});

describe('usableProfileUrl', () => {
  it('rejects the fabricated URL the identifier check alone would miss', () => {
    // The regression: crmEnrichmentService rejected the identifier, then fell back
    // to Unipile's own public_profile_url and rebuilt the same dead link.
    expect(usableProfileUrl('https://www.linkedin.com/in/undefined')).toBeNull();
    expect(usableProfileUrl('https://www.linkedin.com/in/undefined?utm=x')).toBeNull();
  });

  it('strips query params from a real URL, as the previous inline code did', () => {
    expect(usableProfileUrl('https://www.linkedin.com/in/jian-liang?trk=search')).toBe(
      'https://www.linkedin.com/in/jian-liang',
    );
  });

  it('returns null for absent or empty input', () => {
    expect(usableProfileUrl(null)).toBeNull();
    expect(usableProfileUrl('')).toBeNull();
  });
});
