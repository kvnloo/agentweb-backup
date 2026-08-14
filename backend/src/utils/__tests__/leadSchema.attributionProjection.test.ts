/**
 * ENG-1175 — one shared attribution projection for every lead-returning path.
 *
 * Why a helper rather than three inline spreads: ENG-1176 shipped two real bugs
 * (one of them on the DESTRUCTIVE delete path) for exactly one reason — the
 * standard-field list was copied into eight places and the copies drifted. The
 * filter logic was shared; the data describing it was not. Three projections
 * each growing their own idea of "the attribution shape" is that same bug
 * waiting to happen, so the shape is defined once, here, and spread.
 *
 * The contract is mostly about ABSENCE, which is the part that is easy to get
 * wrong and impossible to notice: an empty object where a missing field belongs
 * turns "capture never ran" into "capture ran and found nothing". Those two are
 * different answers to the only question these gates ask.
 */

import { projectLeadAttribution } from '../leadSchema';

describe('projectLeadAttribution (ENG-1175)', () => {
  describe('absence is preserved, never invented', () => {
    it('returns no keys at all for a lead with no attribution', () => {
      // AC1: omitted entirely, NOT `{ firstTouch: {} }`.
      expect(projectLeadAttribution({ leadId: 'l1', email: 'a@b.com' })).toEqual({});
    });

    it('omits firstTouch when the stored value is an empty object', () => {
      // An empty blob is indistinguishable from no blob in meaning, and AC1
      // forbids emitting one. normalizeAttribution never writes this shape, so
      // its presence means corruption, not "captured nothing".
      const out = projectLeadAttribution({ firstTouch: {} });
      expect(out).not.toHaveProperty('firstTouch');
    });

    it('omits a non-empty object carrying no recognisable attribution key', () => {
      // Being an object is not enough. A corrupt or legacy blob like this would
      // otherwise be promoted to a valid firstTouch, and every consumer that
      // reads presence-as-capture would report that capture ran on a record
      // where nothing was captured — the exact confusion AC1/AC4 exist to stop.
      expect(projectLeadAttribution({ firstTouch: { foo: 'bar' } })).not.toHaveProperty('firstTouch');
      expect(projectLeadAttribution({ lastTouch: { 0: 'x', legacyBlob: true } })).not.toHaveProperty('lastTouch');
    });

    it('keeps a touch carrying any single recognised key', () => {
      // The capture middleware always writes timestamp + landingUrl, but a
      // touch narrowed to just one real field is still real data, not corruption.
      for (const key of ['timestamp', 'landingUrl', 'referrer']) {
        expect(projectLeadAttribution({ firstTouch: { [key]: 'x' } })).toHaveProperty('firstTouch');
      }
      expect(projectLeadAttribution({ firstTouch: { utm: { source: 'google' } } })).toHaveProperty('firstTouch');
      expect(projectLeadAttribution({ firstTouch: { clickIds: { gclid: 'g' } } })).toHaveProperty('firstTouch');
    });

    it.each([
      ['a string', 'gclid=123'],
      ['an array', [{ utm: { source: 'google' } }]],
      ['null', null],
      ['a number', 42],
    ])('omits a malformed firstTouch stored as %s, without throwing', (_label, value) => {
      // A malformed blob must not crash the read path for every OTHER field on
      // the lead — the caller asked for a lead, not just its attribution.
      expect(() => projectLeadAttribution({ firstTouch: value })).not.toThrow();
      expect(projectLeadAttribution({ firstTouch: value })).not.toHaveProperty('firstTouch');
    });
  });

  describe('AC4 — captured-nothing is distinguishable from never-captured', () => {
    const neverCaptured = projectLeadAttribution({ leadId: 'organic' });
    const capturedNoClick = projectLeadAttribution({
      firstTouch: { timestamp: '2026-08-14T00:00:00Z', landingUrl: 'https://x.test/' },
    });

    it('a lead that was never captured has no firstTouch key', () => {
      expect(neverCaptured).not.toHaveProperty('firstTouch');
    });

    it('a lead captured with no click ID still reports its firstTouch', () => {
      expect(capturedNoClick.firstTouch).toEqual({
        timestamp: '2026-08-14T00:00:00Z',
        landingUrl: 'https://x.test/',
      });
      expect(capturedNoClick).not.toHaveProperty('clickIds');
    });

    it('the two are not equal — the whole point of AC4', () => {
      expect(neverCaptured).not.toEqual(capturedNoClick);
    });
  });

  describe('what it carries when attribution exists', () => {
    const lead = {
      firstTouch: {
        timestamp: '2026-08-01T10:00:00Z',
        landingUrl: 'https://x.test/lp?gclid=Cj0real',
        utm: { source: 'google', medium: 'cpc' },
        clickIds: { gclid: 'Cj0real' },
      },
      lastTouch: { timestamp: '2026-08-09T10:00:00Z', landingUrl: 'https://x.test/pricing' },
      utmSource: 'google',
      utmMedium: 'cpc',
      clickIds: { gclid: 'Cj0real' },
    };

    it('carries firstTouch, lastTouch and all three denormalized fields', () => {
      const out = projectLeadAttribution(lead);
      expect(out.firstTouch).toEqual(lead.firstTouch);
      expect(out.lastTouch).toEqual(lead.lastTouch);
      expect(out.utmSource).toBe('google');
      expect(out.utmMedium).toBe('cpc');
      expect(out.clickIds).toEqual({ gclid: 'Cj0real' });
    });

    it('does not alias the stored blob', () => {
      // A caller mutating the response must not reach back into the record the
      // rest of the request is still reading from.
      const out = projectLeadAttribution(lead);
      (out.firstTouch as any).utm.source = 'MUTATED';
      expect(lead.firstTouch.utm.source).toBe('google');
    });

    it('omits an empty clickIds map rather than reporting an attributed lead', () => {
      // Mirrors the ENG-1176 storage contract: an empty map would make
      // `is_not_empty` count an organic lead as paid.
      const out = projectLeadAttribution({ firstTouch: { landingUrl: 'https://x.test/' }, clickIds: {} });
      expect(out).not.toHaveProperty('clickIds');
    });
  });
});
