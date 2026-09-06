/**
 * ENG-926 §B — CAPI user_data normalisation, pinned against Meta's OWN implementation.
 *
 * Matching only works when the SHA-256 we send equals the SHA-256 Meta computed from the
 * same person's data on their side. That makes normalisation a wire contract, not a
 * stylistic choice: any difference silently costs a match, with no error anywhere.
 *
 * ─── Where these expected hashes come from ──────────────────────────────────────────
 *
 * They are not hand-computed from the documentation. Meta's `fbevents.js` was loaded in a
 * clean browser against a dummy pixel id, real values were passed to `fbq('init', …)`, and
 * the `ud[…]` hashes it produced were captured off the wire (2026-08-17). Each expectation
 * below is therefore Meta's own answer for that input.
 *
 * The same request also carries `ncud[…]` masks — the normalised value with letters as `*`,
 * digits as `#` — which is how the rules below were read off rather than guessed:
 *
 *   "O'Brien-Smith"      -> ncud[fn] = ***********      (11)  punctuation dropped
 *   "  van der  BERG  "  -> ncud[ln] = **********       (10)  ALL whitespace dropped
 *   "MacDonald 3rd"      -> ncud[ln] = *********#**     (12)  digits KEPT
 *   "José"               -> ncud[fn] = ***~             (4)   accent PRESERVED, not folded
 *   "07911123456"        -> ncud[ph] = ##########       (10)  leading zero dropped
 *
 * One cross-check that the capture is trustworthy: the `ph` hash for "+1 (555) 010-0839"
 * below is byte-identical to the one Haven's live pixel sent for the same number earlier
 * the same day, from a different page and a different browser.
 */

import { normaliseUserDataField } from '../services/metaUserDataNormalisation';
import crypto from 'crypto';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const hashed = (field: 'em' | 'ph' | 'fn' | 'ln', raw: string) =>
  sha256(normaliseUserDataField(field, raw));

describe('normaliseUserDataField — agreement with Meta, by hash', () => {
  it.each([
    ['fn', "O'Brien-Smith", '16765783f9c8c8a3accf27f1abb877688cb5904c21a4a7afb5f125bcfcb246ba'],
    ['ln', '  van der  BERG  ', 'aad607ca3121d5d843c2cd64e8c73c2a24fa3a4cb890ed8d40a1efa8af7a14d5'],
    ['fn', 'José', 'd994e1d001886fe5b45b1267bd1fa2b752ac50742579bd3dad7b2a2aa0ed6866'],
    ['ln', 'MacDonald 3rd', '4915f00c475b4c7d2970e3b3231cd943edb2fe004d09a11ed5cf0fc9c9ed215e'],
    ['em', ' Test.User+tag@Example.COM ', '61c2008e1da48e507546d2faa8e3cdcaad3958f8b667013afdc00d4a2c996369'],
    ['em', 'UPPER@Example.com', '4e3cc7c487a7cad7edf96f10eac280847d2d10d10943987057c431e3f18e3255'],
    ['ph', '+1 (555) 010-0839', '299ca84c952ed7890949e1d35caae807be18582735fd73974143cca2e1ac9d4c'],
    ['ph', '07911123456', 'f7edb45bb2851d8871236cea7e7fec97322d3c4d458c781fb7f258cafae6489f'],
  ] as const)('%s %j hashes exactly as Meta hashes it', (field, raw, expected) => {
    expect(hashed(field, raw)).toBe(expected);
  });
});

describe('fn / ln — the defect this fixes', () => {
  it('drops punctuation, so O\'Brien and OBrien are the same person', () => {
    expect(normaliseUserDataField('fn', "O'Brien")).toBe('obrien');
    expect(normaliseUserDataField('ln', 'Smith-Jones')).toBe('smithjones');
    expect(normaliseUserDataField('ln', 'St. John')).toBe('stjohn');
  });

  it('drops INTERNAL whitespace, not merely surrounding — the larger real-world miss', () => {
    // The previous implementation trimmed and lowercased only, so every multi-word surname
    // hashed differently from Meta's version of the same name. Far more common than
    // apostrophes.
    expect(normaliseUserDataField('ln', 'van der Berg')).toBe('vanderberg');
    expect(normaliseUserDataField('ln', '  Mac  Donald ')).toBe('macdonald');
    expect(normaliseUserDataField('fn', 'Mary Jane')).toBe('maryjane');
  });

  it('PRESERVES accented letters rather than folding them to ASCII', () => {
    // Verified against Meta: "José" normalises to four characters, not five ("jose" would
    // be four too, but the hash proves the accent survives). Transliterating here would
    // break every non-English name that currently matches.
    expect(normaliseUserDataField('fn', 'José')).toBe('josé');
    expect(normaliseUserDataField('ln', 'Müller')).toBe('müller');
    expect(normaliseUserDataField('ln', 'Ñuñez')).toBe('ñuñez');
  });

  it('keeps digits inside a name', () => {
    expect(normaliseUserDataField('ln', 'MacDonald 3rd')).toBe('macdonald3rd');
  });

  it('returns empty for input that is entirely punctuation or space', () => {
    // Caller must treat empty as "no value" rather than hashing it — hashing the empty
    // string produces a real, constant, meaningless hash that would be sent as if it
    // identified someone.
    expect(normaliseUserDataField('fn', '   ')).toBe('');
    expect(normaliseUserDataField('ln', "-'.")).toBe('');
  });
});

describe('em / ph — unchanged behaviour, pinned so a refactor cannot drift it', () => {
  it('email keeps dots, plus and at — only trims and lowercases', () => {
    // Stripping punctuation here would be actively wrong: it changes the address.
    expect(normaliseUserDataField('em', ' Test.User+tag@Example.COM ')).toBe('test.user+tag@example.com');
  });

  it('phone keeps digits only and drops leading zeros', () => {
    expect(normaliseUserDataField('ph', '+1 (555) 010-0839')).toBe('15550100839');
    expect(normaliseUserDataField('ph', '07911123456')).toBe('7911123456');
  });

  it('phone does not invent a country code it was never given', () => {
    // A number entered without one still under-matches. That is a data-quality gap, not
    // something normalisation can fix, and pretending otherwise would corrupt good numbers.
    expect(normaliseUserDataField('ph', '7911123456')).toBe('7911123456');
  });
});

describe('malformed input', () => {
  it('never throws and never returns non-strings', () => {
    for (const field of ['em', 'ph', 'fn', 'ln'] as const) {
      expect(normaliseUserDataField(field, undefined as any)).toBe('');
      expect(normaliseUserDataField(field, null as any)).toBe('');
      expect(normaliseUserDataField(field, 42 as any)).toBe('');
      expect(normaliseUserDataField(field, {} as any)).toBe('');
    }
  });
});
