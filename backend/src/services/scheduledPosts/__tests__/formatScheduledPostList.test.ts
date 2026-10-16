import {
  formatScheduledPostList,
  formatRelativeTime,
  truncatePreview,
  NOTHING_SCHEDULED_TEXT,
  SCHEDULED_POST_PREVIEW_LENGTH,
  type ScheduledPostListRecord,
} from '../formatScheduledPostList';

const NOW = new Date('2026-10-16T12:00:00Z');
const LA = 'America/Los_Angeles';

function rec(p: Partial<ScheduledPostListRecord> & { id: string }): ScheduledPostListRecord {
  return {
    platform: 'x',
    publishAt: new Date('2026-10-16T14:00:00Z'),
    content: 'hello world',
    mediaUrls: [],
    status: 'pending',
    ...p,
  };
}

describe('formatScheduledPostList (ENG-2511)', () => {
  it('returns an explicit nothing-scheduled result for empty input', () => {
    const v = formatScheduledPostList([], { now: NOW, timeZone: LA });
    expect(v).toEqual({ empty: true, text: NOTHING_SCHEDULED_TEXT, groups: [] });
    expect(v.text).not.toBe('');
  });

  it('treats only-inactive input as nothing scheduled by default', () => {
    const v = formatScheduledPostList([rec({ id: 'a', status: 'fired' }), rec({ id: 'b', status: 'cancelled' })], {
      now: NOW,
      timeZone: LA,
    });
    expect(v.empty).toBe(true);
  });

  it('groups by platform in X, Instagram, LinkedIn order, sorted by time ascending', () => {
    const v = formatScheduledPostList(
      [
        rec({ id: 'li1', platform: 'linkedin', publishAt: new Date('2026-10-17T00:00:00Z') }),
        rec({ id: 'x2', platform: 'x', publishAt: new Date('2026-10-18T00:00:00Z') }),
        rec({ id: 'ig1', platform: 'instagram', mediaUrls: ['https://a/1.png'] }),
        rec({ id: 'x1', platform: 'x', publishAt: new Date('2026-10-16T13:00:00Z') }),
      ],
      { now: NOW, timeZone: LA },
    );
    if (v.empty) throw new Error('expected rows');
    expect(v.groups.map((g) => g.label)).toEqual(['X', 'Instagram', 'LinkedIn']);
    expect(v.groups[0].rows.map((r) => r.id)).toEqual(['x1', 'x2']);
    expect(v.text.startsWith('X:\n')).toBe(true);
  });

  it('excludes fired/cancelled by default and includes them via option', () => {
    const records = [rec({ id: 'p' }), rec({ id: 'f', status: 'fired' }), rec({ id: 'c', status: 'cancelled' })];
    const def = formatScheduledPostList(records, { now: NOW, timeZone: LA });
    if (def.empty) throw new Error('expected rows');
    expect(def.groups[0].rows.map((r) => r.id)).toEqual(['p']);
    const all = formatScheduledPostList(records, { now: NOW, timeZone: LA, includeInactive: true });
    if (all.empty) throw new Error('expected rows');
    expect(all.groups[0].rows.map((r) => r.id).sort()).toEqual(['c', 'f', 'p']);
    expect(all.text).toContain('FIRED');
    expect(all.text).toContain('CANCELLED');
  });

  it('row carries platform, local time, relative time, preview, media count and id', () => {
    const v = formatScheduledPostList(
      [rec({ id: 'rec-123', platform: 'linkedin', mediaUrls: ['https://a/1.png', 'https://a/2.png'] })],
      { now: NOW, timeZone: LA },
    );
    if (v.empty) throw new Error('expected rows');
    const row = v.groups[0].rows[0];
    expect(row).toMatchObject({ id: 'rec-123', platform: 'linkedin', relativeTime: 'in 2h', mediaCount: 2, pastDue: false });
    expect(row.localTime).toMatch(/Oct 16, 2026.*7:00\sAM PDT/);
    expect(row.line).toContain('[2 media]');
    expect(row.line).toContain('id rec-123');
  });

  it('converts across the DST boundary in the user timezone', () => {
    const v = formatScheduledPostList(
      [
        rec({ id: 'before', publishAt: new Date('2026-10-31T16:00:00Z') }), // PDT (UTC-7) → 9:00 AM
        rec({ id: 'after', publishAt: new Date('2026-11-02T17:00:00Z') }), // PST (UTC-8) → 9:00 AM
      ],
      { now: NOW, timeZone: LA },
    );
    if (v.empty) throw new Error('expected rows');
    const [before, after] = v.groups[0].rows;
    expect(before.localTime).toMatch(/Oct 31, 2026.*9:00\sAM PDT/);
    expect(after.localTime).toMatch(/Nov 2, 2026.*9:00\sAM PST/);
  });

  it('flags past-due pending posts instead of hiding them', () => {
    const v = formatScheduledPostList([rec({ id: 'late', publishAt: new Date('2026-10-16T10:00:00Z') })], {
      now: NOW,
      timeZone: LA,
    });
    if (v.empty) throw new Error('expected rows');
    const row = v.groups[0].rows[0];
    expect(row.pastDue).toBe(true);
    expect(row.relativeTime).toBe('2h ago');
    expect(row.line).toContain('PAST DUE');
  });

  it('is deterministic for identical inputs', () => {
    const records = [rec({ id: 'a' }), rec({ id: 'b', platform: 'linkedin' })];
    expect(formatScheduledPostList(records, { now: NOW, timeZone: LA })).toEqual(
      formatScheduledPostList(records, { now: NOW, timeZone: LA }),
    );
  });
});

describe('truncatePreview', () => {
  it('keeps short content and collapses whitespace', () => {
    expect(truncatePreview('a\n\n  b')).toBe('a b');
  });

  it('truncates to the fixed length with an ellipsis', () => {
    const out = truncatePreview('x'.repeat(200));
    expect([...out].length).toBe(SCHEDULED_POST_PREVIEW_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not split emoji code points', () => {
    const out = truncatePreview('😀'.repeat(100), 10);
    expect([...out]).toHaveLength(10);
    expect(out).toBe('😀'.repeat(9) + '…');
  });
});

describe('formatRelativeTime', () => {
  it.each([
    ['2026-10-16T12:00:20Z', 'now'],
    ['2026-10-16T12:45:00Z', 'in 45m'],
    ['2026-10-17T12:00:00Z', 'in 24h'],
    ['2026-10-20T12:00:00Z', 'in 4d'],
    ['2026-10-16T11:30:00Z', '30m ago'],
  ])('%s → %s', (iso, expected) => {
    expect(formatRelativeTime(new Date(iso), NOW)).toBe(expected);
  });
});
