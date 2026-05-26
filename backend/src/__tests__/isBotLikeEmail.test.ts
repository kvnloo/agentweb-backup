/**
 * Tests for the tightened isBotLikeEmail filter. The pre-fix filter only
 * caught Gmail dot-tricks and a handful of test domains, letting most
 * disposable-email signups slip through into the loop's "real user" count.
 *
 * Cases here are derived from the actual signup data in prod on 2026-05-25:
 *   3 real human signups looked human → must NOT be flagged.
 *   97 internally-flagged "bot-like" rows existed but used a loose pattern;
 *   we tighten the pattern without false-positiving on the 3 real ones.
 */

import { UserDB } from '../services/db';

describe('isBotLikeEmail', () => {
  describe('real humans must NOT be flagged', () => {
    const realEmails = [
      // Actual signups from prod on 2026-05-25
      'seo@contentninja.in',
      'esvetcov@xcures.com',
      'jed@angelschool.pro',
      // Common legit corporate emails
      'harsha@agentweb.pro',
      'jane.doe@stripe.com',
      'p.smith@acme.co.uk',
      'eng-team@startup.io',
      // Single Gmail plus-tag (legit filtering)
      'firstname.lastname+newsletter@gmail.com',
      // Gmail with up to 2 dots (still legit)
      'first.last@gmail.com',
      'a.b.c@gmail.com',
    ];

    for (const email of realEmails) {
      it(`treats ${email} as a real user`, () => {
        expect(UserDB.isBotLikeEmail(email)).toBe(false);
      });
    }
  });

  describe('disposable / throwaway providers ARE flagged', () => {
    const throwawayEmails = [
      'foo@mailinator.com',
      'asdf@guerrillamail.com',
      'someone@10minutemail.com',
      'temp@yopmail.com',
      'spam@trashmail.com',
      'random@sharklasers.com',
      'MIXED.CASE@MAILINATOR.COM', // case insensitive
    ];

    for (const email of throwawayEmails) {
      it(`flags ${email} as bot-like`, () => {
        expect(UserDB.isBotLikeEmail(email)).toBe(true);
      });
    }
  });

  describe('Gmail abuse patterns', () => {
    it('flags 3+ dot Gmail addresses (legacy rule, preserved)', () => {
      expect(UserDB.isBotLikeEmail('a.b.c.d@gmail.com')).toBe(true);
      expect(UserDB.isBotLikeEmail('w.x.y.z.a@gmail.com')).toBe(true);
    });

    it('flags Gmail with 2+ plus segments (abuse pattern)', () => {
      expect(UserDB.isBotLikeEmail('real.name+spam+bot@gmail.com')).toBe(true);
      expect(UserDB.isBotLikeEmail('user+a+b+c@gmail.com')).toBe(true);
    });

    it('does NOT flag Gmail with a single plus segment (legit filtering)', () => {
      expect(UserDB.isBotLikeEmail('user+work@gmail.com')).toBe(false);
      expect(UserDB.isBotLikeEmail('newsletter+aiweekly@gmail.com')).toBe(false);
    });
  });

  describe('test / internal accounts', () => {
    it('flags configured test domains', () => {
      expect(UserDB.isBotLikeEmail('anyone@test.com')).toBe(true);
      expect(UserDB.isBotLikeEmail('anyone@onb.com')).toBe(true);
      expect(UserDB.isBotLikeEmail('anyone@example.com')).toBe(true);
      expect(UserDB.isBotLikeEmail('anyone@example.org')).toBe(true);
    });

    it('flags internal smoke-test prefixes at agentweb.pro', () => {
      expect(UserDB.isBotLikeEmail('test123@agentweb.pro')).toBe(true);
      expect(UserDB.isBotLikeEmail('smoketest-foo@agentweb.pro')).toBe(true);
      expect(UserDB.isBotLikeEmail('attrtest@agentweb.pro')).toBe(true);
      expect(UserDB.isBotLikeEmail('qa-cli@agentweb.pro')).toBe(true);
      expect(UserDB.isBotLikeEmail('botrunner@agentweb.pro')).toBe(true);
    });

    it('flags the updates subdomain', () => {
      expect(UserDB.isBotLikeEmail('hello@updates.agentweb.pro')).toBe(true);
    });
  });

  describe('random-looking local parts', () => {
    it('flags ≥16 char local part with no vowel (script-generated pattern)', () => {
      expect(UserDB.isBotLikeEmail('xkj7nq9wptsm3bzv@somedomain.com')).toBe(true);
    });

    it('does NOT flag long local parts that contain vowels (human handles)', () => {
      expect(UserDB.isBotLikeEmail('alexander.hamilton@somedomain.com')).toBe(false);
      expect(UserDB.isBotLikeEmail('catherine_winchester@bigcorp.io')).toBe(false);
    });

    it('does NOT flag short consonant-heavy initials (real handles do this)', () => {
      expect(UserDB.isBotLikeEmail('jp@stripe.com')).toBe(false);
      expect(UserDB.isBotLikeEmail('mlk@acme.com')).toBe(false);
    });
  });

  describe('malformed inputs', () => {
    it('returns false on empty string', () => {
      expect(UserDB.isBotLikeEmail('')).toBe(false);
    });

    it('returns false on missing @', () => {
      expect(UserDB.isBotLikeEmail('notanemail')).toBe(false);
    });

    it('returns false on missing domain', () => {
      expect(UserDB.isBotLikeEmail('local@')).toBe(false);
    });
  });
});
