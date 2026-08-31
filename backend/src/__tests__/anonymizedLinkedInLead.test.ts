/**
 * ENG-1002: the shared anonymized-LinkedIn-hit rule.
 *
 * The original fix matched exactly one string — "LinkedIn Member" — which is
 * only the en-US spelling of the placeholder. These tests pin the widened rule
 * and, just as importantly, pin what it must NOT swallow.
 */

import {
  isAnonymizedSearchLead,
  isAnonymizedSearchItem,
} from '../utils/anonymizedLinkedInLead';

describe('isAnonymizedSearchLead', () => {
  describe('drops placeholders', () => {
    it.each([
      ['LinkedIn', 'Member'],
      ['linkedin', 'member'],
      ['LinkedIn', 'User'],
      ['Anonymous', 'LinkedIn Member'],
    ])('drops the English placeholder "%s %s" even when a URL came with it', (firstName, lastName) => {
      expect(
        isAnonymizedSearchLead({
          firstName,
          lastName,
          linkedin: 'https://www.linkedin.com/in/ACoAAA-opaque',
        }),
      ).toBe(true);
    });

    it.each([
      ['Miembro', 'de LinkedIn', 'Spanish'],
      ['LinkedIn', 'Mitglied', 'German'],
      ['Membre', 'LinkedIn', 'French'],
      ['Utente', 'LinkedIn', 'Italian'],
      ['Usuário', 'do LinkedIn', 'Portuguese'],
      ['领英会员', '', 'Chinese'],
    ])('drops the unlinkable localized placeholder "%s %s" (%s)', (firstName, lastName) => {
      expect(isAnonymizedSearchLead({ firstName, lastName })).toBe(true);
    });

    it('drops a hit with neither a name nor a profile URL', () => {
      expect(isAnonymizedSearchLead({})).toBe(true);
      expect(isAnonymizedSearchLead({ firstName: '  ', lastName: '' })).toBe(true);
    });
  });

  describe('keeps real people', () => {
    it('keeps a named, linkable lead', () => {
      expect(
        isAnonymizedSearchLead({
          firstName: 'Amy',
          lastName: 'Foley',
          linkedin: 'https://www.linkedin.com/in/amy-foley',
        }),
      ).toBe(false);
    });

    it('keeps a named lead that has no profile URL', () => {
      expect(isAnonymizedSearchLead({ firstName: 'Amy', lastName: 'Foley' })).toBe(false);
    });

    // The brand-token rule must not catch people who put a LinkedIn badge in
    // their own name field — they are linkable, so they are dedup-able.
    it.each([
      'Jane Doe | LinkedIn Top Voice',
      'Rui Chen — LinkedIn Trainer',
    ])('keeps the linkable real person "%s"', (name) => {
      const [firstName, ...rest] = name.split(' ');
      expect(
        isAnonymizedSearchLead({
          firstName,
          lastName: rest.join(' '),
          linkedin: 'https://www.linkedin.com/in/jane-doe',
        }),
      ).toBe(false);
    });
  });
});

describe('isAnonymizedSearchItem', () => {
  it('reads the placeholder off a raw Unipile item using `name`', () => {
    expect(isAnonymizedSearchItem({ name: 'LinkedIn Member', headline: 'CTO' })).toBe(true);
  });

  it('reads the placeholder off first_name / last_name', () => {
    expect(isAnonymizedSearchItem({ first_name: 'LinkedIn', last_name: 'User' })).toBe(true);
  });

  it('keeps an item that has a public_identifier and a real name', () => {
    expect(
      isAnonymizedSearchItem({ name: 'Amy Foley', public_identifier: 'amy-foley' }),
    ).toBe(false);
  });

  it('keeps an item whose only URL is a messy profile_url', () => {
    expect(
      isAnonymizedSearchItem({
        name: 'Amy Foley',
        profile_url: 'https://www.linkedin.com/in/amy-foley?miniProfileUrn=x',
      }),
    ).toBe(false);
  });

  it('drops a completely empty item, and tolerates a non-object', () => {
    expect(isAnonymizedSearchItem({})).toBe(true);
    expect(isAnonymizedSearchItem(null)).toBe(true);
    expect(isAnonymizedSearchItem('nonsense')).toBe(true);
  });

  it('agrees with the mapped-lead form for the same input', () => {
    const item = { name: 'Miembro de LinkedIn', headline: 'Gerente' };
    expect(isAnonymizedSearchItem(item)).toBe(
      isAnonymizedSearchLead({ firstName: 'Miembro', lastName: 'de LinkedIn' }),
    );
  });
});

describe('the anonymized sentinel must not build a URL that defeats the rule', () => {
  // `isAnonymizedSearchLead` returns early on any truthy `linkedin`, so a URL built
  // from LinkedIn's `"undefined"` sentinel short-circuits the brand-token and
  // empty-name rules underneath it. That kept exactly the rows this function exists
  // to reject — and since every one of them normalizes to the SAME lookup key, the
  // CRM write boundary could merge distinct real people into a single lead.

  it('rejects an anonymized item whose placeholder name is not the en-US spelling', () => {
    expect(isAnonymizedSearchItem({
      name: 'Miembro de LinkedIn',
      public_identifier: 'undefined',
    })).toBe(true);
  });

  it('rejects an anonymized item with no name at all', () => {
    expect(isAnonymizedSearchItem({ public_identifier: 'undefined' })).toBe(true);
  });

  it('rejects one whose profile_url is the fabricated link', () => {
    expect(isAnonymizedSearchItem({
      name: 'Miembro de LinkedIn',
      profile_url: 'https://www.linkedin.com/in/undefined?trk=x',
    })).toBe(true);
  });

  it('still keeps a real person who has a real slug', () => {
    expect(isAnonymizedSearchItem({
      name: 'Jennifer Sun',
      public_identifier: 'jennifer-sun-1a2b3c',
    })).toBe(false);
  });

  it('still keeps a real person known only by profile_url', () => {
    expect(isAnonymizedSearchItem({
      name: 'Jennifer Sun',
      profile_url: 'https://www.linkedin.com/in/jennifer-sun-1a2b3c?trk=search',
    })).toBe(false);
  });
});
