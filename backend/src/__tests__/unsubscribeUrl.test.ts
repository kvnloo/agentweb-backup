/**
 * Unit tests for unsubscribeUrl utility.
 * Sign and verify HMAC-SHA256 signatures over (listId:leadId:email).
 */

describe('unsubscribeUrl utility', () => {
  const ORIGINAL_SECRET = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-key-do-not-use';
    jest.resetModules();
  });

  afterAll(() => {
    process.env.JWT_SECRET = ORIGINAL_SECRET;
  });

  describe('signUnsubscribeUrl', () => {
    it('appends a sig query parameter to the base unsubscribe URL', () => {
      const { signUnsubscribeUrl } = require('../utils/unsubscribeUrl');
      const url = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
      });
      expect(url).toMatch(/^https:\/\/app\.agentweb\.pro\/crm-unsubscribe\?listId=list-1&leadId=lead-1&email=foo%40example\.com&sig=[a-f0-9]{64}$/);
    });

    it('produces a deterministic signature for the same inputs', () => {
      const { signUnsubscribeUrl } = require('../utils/unsubscribeUrl');
      const url1 = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
      });
      const url2 = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
      });
      expect(url1).toBe(url2);
    });

    it('produces different signatures for different inputs', () => {
      const { signUnsubscribeUrl } = require('../utils/unsubscribeUrl');
      const url1 = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
      });
      const url2 = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-2',
        email: 'foo@example.com',
      });
      expect(url1).not.toBe(url2);
    });

    it('throws when JWT_SECRET is empty', () => {
      delete process.env.JWT_SECRET;
      jest.resetModules();
      const { signUnsubscribeUrl } = require('../utils/unsubscribeUrl');
      expect(() =>
        signUnsubscribeUrl({
          baseUrl: 'https://app.agentweb.pro',
          listId: 'list-1',
          leadId: 'lead-1',
          email: 'foo@example.com',
        })
      ).toThrow();
    });

    it('url-encodes email characters in the URL', () => {
      const { signUnsubscribeUrl } = require('../utils/unsubscribeUrl');
      const url = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'a+b@example.com',
      });
      expect(url).toContain('email=a%2Bb%40example.com');
    });

    it('strips a trailing slash from baseUrl so the path is not doubled', () => {
      const { signUnsubscribeUrl } = require('../utils/unsubscribeUrl');
      const url = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro/',
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
      });
      expect(url).not.toMatch(/\/\/crm-unsubscribe/);
      expect(url).toMatch(/^https:\/\/app\.agentweb\.pro\/crm-unsubscribe\?/);
    });

    it('round-trips a falsy email (empty string normalises to empty)', () => {
      const { signUnsubscribeUrl, verifyUnsubscribeSignature } = require('../utils/unsubscribeUrl');
      const url = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-1',
        email: '',
      });
      const sig = new URL(url).searchParams.get('sig')!;
      const ok = verifyUnsubscribeSignature({
        listId: 'list-1',
        leadId: 'lead-1',
        email: '',
        sig,
      });
      expect(ok).toBe(true);
    });
  });

  describe('verifyUnsubscribeSignature', () => {
    it('returns true for a freshly signed signature (round-trip)', () => {
      const { signUnsubscribeUrl, verifyUnsubscribeSignature } = require('../utils/unsubscribeUrl');
      const url = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
      });
      const sig = new URL(url).searchParams.get('sig')!;
      const ok = verifyUnsubscribeSignature({
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
        sig,
      });
      expect(ok).toBe(true);
    });

    it('returns false when listId is tampered', () => {
      const { signUnsubscribeUrl, verifyUnsubscribeSignature } = require('../utils/unsubscribeUrl');
      const url = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
      });
      const sig = new URL(url).searchParams.get('sig')!;
      const ok = verifyUnsubscribeSignature({
        listId: 'list-EVIL',
        leadId: 'lead-1',
        email: 'foo@example.com',
        sig,
      });
      expect(ok).toBe(false);
    });

    it('returns false when leadId is tampered', () => {
      const { signUnsubscribeUrl, verifyUnsubscribeSignature } = require('../utils/unsubscribeUrl');
      const url = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
      });
      const sig = new URL(url).searchParams.get('sig')!;
      const ok = verifyUnsubscribeSignature({
        listId: 'list-1',
        leadId: 'lead-EVIL',
        email: 'foo@example.com',
        sig,
      });
      expect(ok).toBe(false);
    });

    it('returns false when email is tampered', () => {
      const { signUnsubscribeUrl, verifyUnsubscribeSignature } = require('../utils/unsubscribeUrl');
      const url = signUnsubscribeUrl({
        baseUrl: 'https://app.agentweb.pro',
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
      });
      const sig = new URL(url).searchParams.get('sig')!;
      const ok = verifyUnsubscribeSignature({
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'evil@example.com',
        sig,
      });
      expect(ok).toBe(false);
    });

    it('returns false for an empty sig', () => {
      const { verifyUnsubscribeSignature } = require('../utils/unsubscribeUrl');
      const ok = verifyUnsubscribeSignature({
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
        sig: '',
      });
      expect(ok).toBe(false);
    });

    it('returns false for a sig of wrong length (timing-safe equality)', () => {
      const { verifyUnsubscribeSignature } = require('../utils/unsubscribeUrl');
      const ok = verifyUnsubscribeSignature({
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
        sig: 'short',
      });
      expect(ok).toBe(false);
    });

    it('returns false for a sig with non-hex characters', () => {
      const { verifyUnsubscribeSignature } = require('../utils/unsubscribeUrl');
      const ok = verifyUnsubscribeSignature({
        listId: 'list-1',
        leadId: 'lead-1',
        email: 'foo@example.com',
        sig: 'z'.repeat(64),
      });
      expect(ok).toBe(false);
    });

    it('throws when JWT_SECRET is empty', () => {
      delete process.env.JWT_SECRET;
      jest.resetModules();
      const { verifyUnsubscribeSignature } = require('../utils/unsubscribeUrl');
      expect(() =>
        verifyUnsubscribeSignature({
          listId: 'list-1',
          leadId: 'lead-1',
          email: 'foo@example.com',
          sig: 'a'.repeat(64),
        })
      ).toThrow();
    });

    it('returns false when timingSafeEqual throws (defensive catch)', () => {
      jest.resetModules();
      const crypto = require('crypto');
      const spy = jest.spyOn(crypto, 'timingSafeEqual').mockImplementation(() => {
        throw new Error('forced crypto failure');
      });
      try {
        const { signUnsubscribeUrl, verifyUnsubscribeSignature } = require('../utils/unsubscribeUrl');
        const url = signUnsubscribeUrl({
          baseUrl: 'https://app.agentweb.pro',
          listId: 'list-1',
          leadId: 'lead-1',
          email: 'foo@example.com',
        });
        const sig = new URL(url).searchParams.get('sig')!;
        const ok = verifyUnsubscribeSignature({
          listId: 'list-1',
          leadId: 'lead-1',
          email: 'foo@example.com',
          sig,
        });
        // Defensive catch must convert any unexpected throw into a quiet false,
        // never let the exception bubble out of verify.
        expect(ok).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
