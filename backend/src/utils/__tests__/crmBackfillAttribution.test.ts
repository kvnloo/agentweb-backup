/**
 * Tests for crmBackfillAttribution — pure compute logic for the
 * lead-attribution backfill script.
 */

import {
  deriveAttributionFromUser,
  isLeadAttributionAlreadyPopulated,
  buildAttributionUpdateExpression,
} from '../crmBackfillAttribution';
import type { AttributionTouch } from '../../types/attribution';

const touchA: AttributionTouch = {
  timestamp: '2026-04-01T10:00:00.000Z',
  utm: { source: 'linkedin', medium: 'social', campaign: 'launch' },
  referrer: 'https://linkedin.com/feed',
};

const touchB: AttributionTouch = {
  timestamp: '2026-04-19T10:00:00.000Z',
  utm: { source: 'meta', medium: 'cpc' },
};

describe('isLeadAttributionAlreadyPopulated', () => {
  it('returns false when no attribution fields are set', () => {
    expect(
      isLeadAttributionAlreadyPopulated({ listId: 'l1', leadId: 'lead_1' })
    ).toBe(false);
  });

  it('returns true when firstTouch exists', () => {
    expect(
      isLeadAttributionAlreadyPopulated({
        listId: 'l1',
        leadId: 'lead_1',
        firstTouch: touchA,
      })
    ).toBe(true);
  });

  it('returns true when only utmSource is set', () => {
    expect(
      isLeadAttributionAlreadyPopulated({
        listId: 'l1',
        leadId: 'lead_1',
        utmSource: 'linkedin',
      })
    ).toBe(true);
  });
});

describe('deriveAttributionFromUser', () => {
  const emptyLead = { listId: 'l1', leadId: 'lead_1', email: 'jane@example.com' };

  it('returns null when user is null (prospect-only lead)', () => {
    expect(deriveAttributionFromUser(emptyLead, null)).toBeNull();
  });

  it('returns null when lead already has attribution (idempotent)', () => {
    const lead = { ...emptyLead, firstTouch: touchA };
    const user = {
      userId: 'u1',
      email: 'jane@example.com',
      firstTouch: touchB,
    };
    expect(deriveAttributionFromUser(lead, user)).toBeNull();
  });

  it('copies firstTouch, lastTouch, utmSource, utmMedium from a clean user', () => {
    const user = {
      userId: 'u1',
      email: 'jane@example.com',
      firstTouch: touchA,
      lastTouch: touchA,
      utmSource: 'linkedin',
      utmMedium: 'social',
    };
    const update = deriveAttributionFromUser(emptyLead, user);
    expect(update).not.toBeNull();
    expect(update!.firstTouch).toEqual(touchA);
    expect(update!.lastTouch).toEqual(touchA);
    expect(update!.utmSource).toBe('linkedin');
    expect(update!.utmMedium).toBe('social');
  });

  it('falls back to firstTouch.utm when user lacks top-level utmSource', () => {
    const user = {
      userId: 'u1',
      email: 'jane@example.com',
      firstTouch: touchA, // has utm.source=linkedin, utm.medium=social
    };
    const update = deriveAttributionFromUser(emptyLead, user);
    expect(update!.utmSource).toBe('linkedin');
    expect(update!.utmMedium).toBe('social');
  });

  it('copies user.firstTouch to lead.lastTouch when user has no lastTouch', () => {
    const user = {
      userId: 'u1',
      email: 'jane@example.com',
      firstTouch: touchA,
    };
    const update = deriveAttributionFromUser(emptyLead, user);
    expect(update!.firstTouch).toEqual(touchA);
    expect(update!.lastTouch).toEqual(touchA);
  });

  it('preserves distinct lastTouch when user has one', () => {
    const user = {
      userId: 'u1',
      email: 'jane@example.com',
      firstTouch: touchA,
      lastTouch: touchB,
    };
    const update = deriveAttributionFromUser(emptyLead, user);
    expect(update!.firstTouch).toEqual(touchA);
    expect(update!.lastTouch).toEqual(touchB);
  });

  it('returns null when user has no attribution at all (nothing to copy)', () => {
    const user = { userId: 'u1', email: 'jane@example.com' };
    expect(deriveAttributionFromUser(emptyLead, user)).toBeNull();
  });

  it('respects { force: true } and overwrites populated leads', () => {
    const lead = { ...emptyLead, firstTouch: touchB };
    const user = {
      userId: 'u1',
      email: 'jane@example.com',
      firstTouch: touchA,
    };
    // Without force: returns null (skip)
    expect(deriveAttributionFromUser(lead, user)).toBeNull();
    // With force: still won't overwrite firstTouch (earliest wins contract),
    // but lastTouch is unset on lead so the user's firstTouch propagates.
    const forced = deriveAttributionFromUser(lead, user, { force: true });
    expect(forced).not.toBeNull();
    expect(forced!.firstTouch).toBeUndefined(); // lead.firstTouch already set
    expect(forced!.lastTouch).toEqual(touchA);
  });
});

describe('buildAttributionUpdateExpression', () => {
  it('returns undefined for null or empty update', () => {
    expect(buildAttributionUpdateExpression(null)).toBeUndefined();
    expect(buildAttributionUpdateExpression({})).toBeUndefined();
  });

  it('builds a SET expression for all four fields', () => {
    const expr = buildAttributionUpdateExpression({
      firstTouch: touchA,
      lastTouch: touchA,
      utmSource: 'linkedin',
      utmMedium: 'social',
    });
    expect(expr).toBeDefined();
    expect(expr!.UpdateExpression.startsWith('SET ')).toBe(true);
    expect(Object.keys(expr!.ExpressionAttributeNames)).toHaveLength(4);
    expect(Object.values(expr!.ExpressionAttributeNames).sort()).toEqual([
      'firstTouch',
      'lastTouch',
      'utmMedium',
      'utmSource',
    ]);
    expect(Object.values(expr!.ExpressionAttributeValues)).toEqual(
      expect.arrayContaining([touchA, 'linkedin', 'social'])
    );
  });

  it('handles partial updates (just utmSource)', () => {
    const expr = buildAttributionUpdateExpression({ utmSource: 'meta' });
    expect(expr).toBeDefined();
    expect(expr!.UpdateExpression).toBe('SET #attr_0 = :attr_0');
    expect(expr!.ExpressionAttributeNames['#attr_0']).toBe('utmSource');
    expect(expr!.ExpressionAttributeValues[':attr_0']).toBe('meta');
  });
});
