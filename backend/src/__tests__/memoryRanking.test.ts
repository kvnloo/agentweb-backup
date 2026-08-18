import {
  cosineSimilarity,
  rankMemoriesByRelevance,
  describeMemoryAge,
  formatMemoryLine,
  buildMemoryContextMessage,
  MEMORY_STALENESS_NOTE,
} from '../utils/memoryRanking';

describe('cosineSimilarity', () => {
  it('returns ~1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns 0 (no NaN) for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('returns 0 for mismatched dimensions instead of throwing', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('rankMemoriesByRelevance', () => {
  it('returns [] for empty input', () => {
    expect(rankMemoriesByRelevance([], [1, 0], 5)).toEqual([]);
  });

  it('when count <= limit, returns all sorted newest-first (no scoring needed)', () => {
    const mems = [
      { memoryId: 'a', createdAt: '2026-01-01T00:00:00Z', embedding: [0, 1] },
      { memoryId: 'b', createdAt: '2026-03-01T00:00:00Z', embedding: [1, 0] },
    ];
    const result = rankMemoriesByRelevance(mems, [0, 1], 5);
    expect(result.map((m) => m.memoryId)).toEqual(['b', 'a']); // newest first
  });

  it('when count > limit, retrieves the semantically relevant memory even if it is older', () => {
    const mems = [
      { memoryId: 'old-relevant', createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] },
      { memoryId: 'new-irrelevant', createdAt: '2026-05-01T00:00:00Z', embedding: [0, 1] },
    ];
    const result = rankMemoriesByRelevance(mems, [1, 0], 1); // query matches old-relevant
    expect(result.map((m) => m.memoryId)).toEqual(['old-relevant']);
  });

  it('does not silently lose memories that lack an embedding (graceful), preferring a real match', () => {
    const mems = [
      { memoryId: 'recent-no-embedding', createdAt: '2026-05-01T00:00:00Z' },
      { memoryId: 'old-match', createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] },
    ];
    const result = rankMemoriesByRelevance(mems, [1, 0], 1);
    expect(result.map((m) => m.memoryId)).toEqual(['old-match']);
  });

  it('uses recency as a tie-breaker when relevance is equal', () => {
    const mems = [
      { memoryId: 'older', createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] },
      { memoryId: 'newer', createdAt: '2026-05-01T00:00:00Z', embedding: [1, 0] },
    ];
    const result = rankMemoriesByRelevance(mems, [1, 0], 1); // equal similarity
    expect(result.map((m) => m.memoryId)).toEqual(['newer']);
  });

  it('returns [] for null/undefined memories', () => {
    expect(rankMemoriesByRelevance(null as any, [1, 0], 5)).toEqual([]);
  });

  it('honors a provided recencyWeight in the scoring path', () => {
    const mems = [
      { memoryId: 'a', createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] },
      { memoryId: 'b', createdAt: '2026-05-01T00:00:00Z', embedding: [1, 0] },
      { memoryId: 'c', createdAt: '2026-03-01T00:00:00Z', embedding: [0, 1] },
    ];
    const res = rankMemoriesByRelevance(mems, [1, 0], 2, { recencyWeight: 0.5 });
    expect(res.map((m) => m.memoryId)).toEqual(['b', 'a']);
  });

  it('handles the single-memory scoring path (limit 0)', () => {
    const res = rankMemoriesByRelevance(
      [{ memoryId: 'x', createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] }],
      [1, 0],
      0
    );
    expect(res).toEqual([]);
  });

  it('does not throw when createdAt is missing/equal', () => {
    const res = rankMemoriesByRelevance([{ memoryId: 'a' }, { memoryId: 'b' }], [1, 0], 5);
    expect(res).toHaveLength(2);
  });
});

describe('describeMemoryAge', () => {
  const now = new Date('2026-07-13T12:00:00Z');

  it('returns "today" for a memory saved earlier the same day', () => {
    expect(describeMemoryAge('2026-07-13T01:00:00Z', now)).toBe('today');
  });

  it('returns "yesterday" for a memory saved ~1 day ago', () => {
    expect(describeMemoryAge('2026-07-12T06:00:00Z', now)).toBe('yesterday');
  });

  it('returns "N days ago" for older memories', () => {
    expect(describeMemoryAge('2026-07-09T12:00:00Z', now)).toBe('4 days ago');
  });

  it('returns null when the saved timestamp is missing', () => {
    expect(describeMemoryAge(undefined, now)).toBeNull();
  });

  it('returns null for an unparseable timestamp instead of NaN', () => {
    expect(describeMemoryAge('not-a-date', now)).toBeNull();
  });

  it('returns null for a future saved-date rather than a contradictory "today"', () => {
    // Clock skew or an updatedAt bumped ahead would otherwise render "(saved <future>, today)".
    expect(describeMemoryAge('2026-07-25T12:00:00Z', now)).toBeNull();
  });

  it('buckets by UTC calendar date, not 24h windows, so it never contradicts the saved date near midnight', () => {
    // Scheduled runs fire around midnight; a memory saved the previous calendar day but
    // < 24h ago must read "yesterday" (matching its displayed 2026-07-12 stamp), not "today".
    const justAfterMidnight = new Date('2026-07-13T00:30:00Z');
    expect(describeMemoryAge('2026-07-12T23:00:00Z', justAfterMidnight)).toBe('yesterday');
  });
});

describe('formatMemoryLine', () => {
  const now = new Date('2026-07-13T12:00:00Z');

  it('stamps a memory with its saved date and age so stale facts are visibly old', () => {
    const line = formatMemoryLine(
      { category: 'insight', content: 'Instagram token expired — skip Instagram', createdAt: '2026-07-09T12:00:00Z' },
      now
    );
    // The age prefix is what lets the model recognize a stale operational note (ENG-305).
    expect(line).toBe('- [insight] (saved 2026-07-09, 4 days ago) Instagram token expired — skip Instagram');
  });

  it('prefers updatedAt over createdAt when both are present', () => {
    const line = formatMemoryLine(
      { category: 'preference', content: 'x', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-07-12T12:00:00Z' },
      now
    );
    expect(line).toBe('- [preference] (saved 2026-07-12, yesterday) x');
  });

  it('falls back to an unstamped line when no timestamp is available', () => {
    const line = formatMemoryLine({ category: 'fact', content: 'no date here' }, now);
    expect(line).toBe('- [fact] no date here');
  });

  it('defaults the category label when missing', () => {
    const line = formatMemoryLine({ content: 'orphan' }, now);
    expect(line).toBe('- [general] orphan');
  });
});

describe('buildMemoryContextMessage', () => {
  const now = new Date('2026-07-13T12:00:00Z');

  it('returns null when there are no memories', () => {
    expect(buildMemoryContextMessage('Account Memory:', [], now)).toBeNull();
    expect(buildMemoryContextMessage('Account Memory:', null as any, now)).toBeNull();
  });

  it('renders a header, dated lines, and the staleness caution', () => {
    const msg = buildMemoryContextMessage(
      'Account Memory (facts from previous sessions):',
      [
        { category: 'insight', content: 'Instagram token expired — skip Instagram', createdAt: '2026-07-09T12:00:00Z' },
        { category: 'preference', content: 'Post to LinkedIn and Instagram daily', createdAt: '2026-07-13T09:00:00Z' },
      ],
      now
    );
    expect(msg).toContain('Account Memory (facts from previous sessions):');
    expect(msg).toContain('- [insight] (saved 2026-07-09, 4 days ago) Instagram token expired — skip Instagram');
    expect(msg).toContain('- [preference] (saved 2026-07-13, today) Post to LinkedIn and Instagram daily');
    expect(msg).toContain(MEMORY_STALENESS_NOTE);
  });

  // ENG-1310: a caution that only ever trailed the list lost to the list's own "facts"
  // framing on a long memory block — the note now bookends the content so it is the
  // first and last thing the model reads, not just an afterthought at the bottom.
  it('bookends the memory list with the staleness caution (ENG-1310)', () => {
    const msg = buildMemoryContextMessage(
      'Account Memory (unverified notes from previous sessions):',
      [{ category: 'insight', content: 'GA4: 416 form_starts, 91 submits', createdAt: '2026-07-31T12:00:00Z' }],
      now
    ) as string;

    const firstNoteIdx = msg.indexOf(MEMORY_STALENESS_NOTE);
    const headerIdx = msg.indexOf('Account Memory (unverified notes from previous sessions):');
    const lastLineIdx = msg.indexOf('GA4: 416 form_starts, 91 submits');
    const lastNoteIdx = msg.lastIndexOf(MEMORY_STALENESS_NOTE);

    expect(firstNoteIdx).toBeGreaterThanOrEqual(0);
    // The caution appears BEFORE the header/list...
    expect(firstNoteIdx).toBeLessThan(headerIdx);
    // ...and again AFTER it, so it is not lost at the end of a long block.
    expect(lastNoteIdx).toBeGreaterThan(headerIdx);
    expect(lastNoteIdx).not.toBe(firstNoteIdx);
    // Specifically after the LAST rendered memory line, not merely after the header —
    // a note sandwiched between the header and the list would satisfy the two checks
    // above without ever bookending the actual content.
    expect(lastNoteIdx).toBeGreaterThan(lastLineIdx);
    // And it is the true suffix of the message — nothing trails the closing caution.
    expect(msg.endsWith(MEMORY_STALENESS_NOTE)).toBe(true);
  });
});

describe('MEMORY_STALENESS_NOTE', () => {
  // ENG-1187: a memory-sourced metric ("416 form_starts → 91 submits") was quoted as current
  // in a client-facing report. The original note (ENG-305) only warned about stale config/
  // state facts (disabled channels, expired tokens) — it must also cover numeric figures.
  it('warns against repeating a stale metric/count/KPI as current, not just config/state facts', () => {
    expect(MEMORY_STALENESS_NOTE).toMatch(/metric|count|KPI/i);
  });

  it('still warns against silently skipping a configured action from stale state (ENG-305)', () => {
    expect(MEMORY_STALENESS_NOTE).toMatch(/disabled|expired/i);
  });

  // ENG-1310 AC1: "A remembered figure is never presented as a current measurement... it
  // carries its date and source." The note existed before (ENG-305/1187) but only said
  // "re-verify" with no concrete fallback wording — the model still had to invent how to
  // hedge. It now names the exact label to use when it cannot re-verify before answering.
  it('gives a concrete "unverified — from <date> notes:" fallback label when re-verification is not possible (ENG-1310 AC1)', () => {
    expect(MEMORY_STALENESS_NOTE).toMatch(/unverified — from <saved date> notes:/i);
    expect(MEMORY_STALENESS_NOTE).toMatch(/must not state it as current/i);
  });

  // ENG-1310 AC1 follow-up: formatMemoryLine falls back to an unstamped line when no
  // timestamp is available, so the "<saved date>" fallback label has nothing to fill in —
  // without an explicit undated form the model would have to invent one.
  it('gives an "unverified — from undated notes:" fallback for memory lines with no saved date', () => {
    expect(MEMORY_STALENESS_NOTE).toMatch(/unverified — from undated notes:/i);
  });
});

describe('cosineSimilarity — additional branches', () => {
  it('returns 0 for a null vector', () => {
    expect(cosineSimilarity(null as any, [1])).toBe(0);
  });

  it('returns 0 when the second vector is all zeros', () => {
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });
});
