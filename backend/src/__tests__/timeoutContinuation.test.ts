import {
  collectMediaGeneratedSince,
  buildTimeoutContinuationMessage,
  collectTurnWorkSince,
  buildTimeoutPartialWorkMessage,
  hasDeferredMediaBudgetToolCall,
  hasPersistedMediaBudgetDeferral,
  hasUnresolvedMediaDeferral,
} from '../utils/timeoutContinuation';

describe('collectMediaGeneratedSince', () => {
  // Turn began at 06:47 (matches the real ENG-510 prod incident window).
  const turnStart = Date.parse('2026-07-24T06:47:00Z');
  const marker = (iso: string, url = 'https://s3/img.png', filename = 'img.png') => ({
    metadata: { kind: 'image-generated', imageUrl: url, imageFilename: filename, timestamp: iso },
  });

  it('returns [] for non-array input', () => {
    expect(collectMediaGeneratedSince(undefined, turnStart)).toEqual([]);
    expect(collectMediaGeneratedSince(null, turnStart)).toEqual([]);
  });

  it('ignores markers persisted before the turn started (prior turns)', () => {
    expect(collectMediaGeneratedSince([marker('2026-07-24T06:40:00Z')], turnStart)).toEqual([]);
  });

  it('ignores non-image markers, URL-less markers, and malformed messages', () => {
    const msgs = [
      { metadata: { kind: 'image-generated', timestamp: '2026-07-24T06:54:00Z' } }, // no imageUrl
      { metadata: { kind: 'other', imageUrl: 'x', timestamp: '2026-07-24T06:54:00Z' } }, // wrong kind
      { metadata: null },
      {},
    ];
    expect(collectMediaGeneratedSince(msgs, turnStart)).toEqual([]);
  });

  it('collects markers at/after turn start, prefers message.timestamp, and URL-dedupes', () => {
    const msgs = [
      marker('2026-07-24T06:54:00Z', 'https://s3/v1.png', 'v1.png'), // after → kept
      // message.timestamp present (preferred over metadata.timestamp)
      {
        timestamp: '2026-07-24T06:58:00Z',
        metadata: { kind: 'image-generated', imageUrl: 'https://s3/v2.png', imageFilename: 'v2.png', timestamp: '2026-07-24T06:40:00Z' },
      },
      marker('2026-07-24T06:59:00Z', 'https://s3/v1.png', 'v1-dup.png'), // dup URL → dropped
      marker('2026-07-24T06:40:00Z', 'https://s3/old.png'), // before → excluded
    ];
    expect(collectMediaGeneratedSince(msgs, turnStart)).toEqual([
      { imageUrl: 'https://s3/v1.png', filename: 'v1.png' },
      { imageUrl: 'https://s3/v2.png', filename: 'v2.png' },
    ]);
  });

  it('skips null/undefined message entries and markers with no timestamp at all', () => {
    const msgs = [
      null,
      undefined,
      // valid image-generated marker but NO timestamp anywhere → Date.parse gets nothing
      // (rawTs falsy → NaN → not finite) so it is excluded rather than counted.
      { metadata: { kind: 'image-generated', imageUrl: 'https://s3/no-ts.png', imageFilename: 'x.png' } },
    ];
    expect(collectMediaGeneratedSince(msgs as any, turnStart)).toEqual([]);
  });

  it('falls back to a default filename when the marker omits one', () => {
    const msgs = [{ metadata: { kind: 'image-generated', imageUrl: 'https://s3/x.png', timestamp: '2026-07-24T06:54:00Z' } }];
    expect(collectMediaGeneratedSince(msgs, turnStart)).toEqual([
      { imageUrl: 'https://s3/x.png', filename: 'generated-image.png' },
    ]);
  });
});

describe('buildTimeoutContinuationMessage', () => {
  it('returns null when no media was delivered this turn', () => {
    expect(buildTimeoutContinuationMessage([])).toBeNull();
    expect(buildTimeoutContinuationMessage(undefined)).toBeNull();
    expect(buildTimeoutContinuationMessage(null)).toBeNull();
  });

  it('embeds a single image inline (markdown) and invites "continue"', () => {
    const msg = buildTimeoutContinuationMessage([{ imageUrl: 'https://s3/v1.png', filename: 'v1.png' }])!;
    expect(msg).toContain('1 image ');
    expect(msg).not.toContain('1 images');
    expect(msg).toContain('here it is');
    expect(msg).toContain('![v1.png](https://s3/v1.png)'); // renders inline → user actually gets it
    expect(msg.toLowerCase()).toContain('continue');
  });

  it('embeds every completed image so partial work is delivered even if the rest fail', () => {
    const msg = buildTimeoutContinuationMessage([
      { imageUrl: 'https://s3/v1.png', filename: 'v1.png' },
      { imageUrl: 'https://s3/v2.png', filename: 'v2.png' },
    ])!;
    expect(msg).toContain('2 images');
    expect(msg).toContain('here they are');
    expect(msg).toContain('![v1.png](https://s3/v1.png)');
    expect(msg).toContain('![v2.png](https://s3/v2.png)');
  });
});

describe('ENG-907 — salvaging a timed-out turn that did real work', () => {
  // The ENG-907 production window: user message 22:46:57, cap fired 22:56:57.
  const turnStart = Date.parse('2026-08-04T22:46:57Z');
  const at = (iso: string) => ({ timestamp: iso });

  const assistant = (iso: string, content: unknown, metadata?: Record<string, unknown>) => ({
    role: 'assistant',
    content,
    ...at(iso),
    metadata: { timestamp: iso, ...(metadata || {}) },
  });
  const tool = (iso: string, name: string) => ({
    role: 'tool',
    name,
    content: '{"ok":true}',
    ...at(iso),
    metadata: { timestamp: iso },
  });

  describe('collectTurnWorkSince', () => {
    it('returns nothing for non-array input', () => {
      expect(collectTurnWorkSince(undefined, turnStart)).toEqual({ narrationCount: 0, toolNames: [] });
      expect(collectTurnWorkSince(null, turnStart)).toEqual({ narrationCount: 0, toolNames: [] });
    });

    it("ignores an EARLIER turn's work", () => {
      const msgs = [
        assistant('2026-08-04T22:40:00Z', 'from a previous turn'),
        tool('2026-08-04T22:40:05Z', 'twitter_outreach'),
      ];
      expect(collectTurnWorkSince(msgs, turnStart)).toEqual({ narrationCount: 0, toolNames: [] });
    });

    it('counts this turn\'s narration and de-dupes tool names in first-seen order', () => {
      const msgs = [
        assistant('2026-08-04T22:47:00Z', 'Scanned batch 1.'),
        tool('2026-08-04T22:48:21Z', 'twitter_outreach'),
        assistant('2026-08-04T22:48:30Z', 'Session is logged out but the API works.'),
        tool('2026-08-04T22:48:56Z', 'you_search_news'),
        tool('2026-08-04T22:49:30Z', 'twitter_outreach'),
      ];
      expect(collectTurnWorkSince(msgs, turnStart)).toEqual({
        narrationCount: 2,
        toolNames: ['twitter_outreach', 'you_search_news'],
      });
    });

    it('never counts the canned error/diagnostic closing as salvaged work', () => {
      // This is the exact shape of the ENG-907 final message.
      const msgs = [
        assistant(
          '2026-08-04T22:56:58Z',
          'The research process for your article took longer than expected and timed out.',
          { isErrorMessage: true, isDiagnosticMessage: true },
        ),
      ];
      expect(collectTurnWorkSince(msgs, turnStart)).toEqual({ narrationCount: 0, toolNames: [] });
    });

    it('does not count a previously-persisted continuation message (no compounding on retry)', () => {
      const msgs = [
        assistant('2026-08-04T22:56:58Z', 'Partial results …', { kind: 'generation-timeout-continuation' }),
      ];
      expect(collectTurnWorkSince(msgs, turnStart).narrationCount).toBe(0);
    });

    it('dates a message from metadata.timestamp when the top-level one is missing', () => {
      // Persisted rows are not uniform — some carry the timestamp only in metadata.
      // Falling back matters: an undated message is dropped, which would silently
      // under-count the very work this salvage exists to report.
      const msgs = [
        { role: 'assistant', content: 'Scanned batch 1.', metadata: { timestamp: '2026-08-04T22:47:00Z' } },
        { role: 'tool', name: 'twitter_outreach', content: '{}', metadata: { timestamp: '2026-08-04T22:48:00Z' } },
      ];
      expect(collectTurnWorkSince(msgs as any, turnStart)).toEqual({
        narrationCount: 1,
        toolNames: ['twitter_outreach'],
      });
    });

    it('skips a tool row with no usable name rather than listing a blank', () => {
      const msgs = [
        { role: 'tool', content: '{}', ...at('2026-08-04T22:48:00Z') },
        { role: 'tool', name: 42, content: '{}', ...at('2026-08-04T22:48:01Z') },
        tool('2026-08-04T22:48:02Z', 'twitter_outreach'),
      ];
      expect(collectTurnWorkSince(msgs as any, turnStart).toolNames).toEqual(['twitter_outreach']);
    });

    it("does not count the user's own message as work the assistant did", () => {
      // The turn window starts at the user's message, so it is inside the range by
      // definition. Only assistant narration and executed tools count as salvaged work.
      const msgs = [
        { role: 'user', content: 'Find the 10 best X posts…', ...at('2026-08-04T22:46:57Z') },
        { role: 'system', content: 'context', ...at('2026-08-04T22:46:58Z') },
      ];
      expect(collectTurnWorkSince(msgs as any, turnStart)).toEqual({ narrationCount: 0, toolNames: [] });
    });

    it('counts a narration row that carries no metadata at all', () => {
      // Not every persisted assistant row has a metadata object. Reading the exclusion
      // flags off it must not throw or accidentally drop real work.
      const msgs = [{ role: 'assistant', content: 'Scanned batch 1.', ...at('2026-08-04T22:47:00Z') }];
      expect(collectTurnWorkSince(msgs as any, turnStart).narrationCount).toBe(1);
    });

    it('excludes a diagnostic-only closing (not just one flagged as an error)', () => {
      // The ENG-907 closing carries both flags, but the error-path diagnosis LLM can
      // write a diagnostic message without isErrorMessage. Counting it as salvaged work
      // would be the same false success.
      const msgs = [
        assistant('2026-08-04T22:56:58Z', 'The run appears to have stalled.', { isDiagnosticMessage: true }),
      ];
      expect(collectTurnWorkSince(msgs, turnStart).narrationCount).toBe(0);
    });

    it('ignores blank/non-string assistant content and undated messages', () => {
      const msgs = [
        assistant('2026-08-04T22:47:00Z', '   '),
        assistant('2026-08-04T22:47:01Z', [{ type: 'text', text: 'array form' }]),
        { role: 'assistant', content: 'no timestamp at all' },
        null,
      ];
      expect(collectTurnWorkSince(msgs as any, turnStart).narrationCount).toBe(0);
    });
  });

  describe('buildTimeoutPartialWorkMessage', () => {
    it('returns null when the turn produced nothing — an empty timeout stays a 504', () => {
      expect(buildTimeoutPartialWorkMessage({ narrationCount: 0, toolNames: [] })).toBeNull();
      expect(buildTimeoutPartialWorkMessage(null)).toBeNull();
      expect(buildTimeoutPartialWorkMessage(undefined)).toBeNull();
    });

    it('leads with partial results, names the tools, and invites continue', () => {
      const msg = buildTimeoutPartialWorkMessage({
        narrationCount: 3,
        toolNames: ['twitter_outreach', 'you_search_news'],
      })!;
      expect(msg).toMatch(/Partial results/i);
      expect(msg).toContain('`twitter_outreach`');
      expect(msg).toContain('`you_search_news`');
      expect(msg).toMatch(/continue/i);
      expect(msg).toMatch(/won't redo/i);
      // It must never read as the ENG-907 failure it replaces.
      expect(msg).not.toMatch(/please try (your request )?again/i);
    });

    it('salvages a turn that ran tools but never narrated', () => {
      const msg = buildTimeoutPartialWorkMessage({ narrationCount: 0, toolNames: ['twitter_outreach'] });
      expect(msg).toMatch(/Partial results/i);
    });

    it('salvages a turn that narrated but ran no tools', () => {
      const msg = buildTimeoutPartialWorkMessage({ narrationCount: 1, toolNames: [] })!;
      expect(msg).toMatch(/Partial results/i);
      expect(msg).toContain('steps above');
    });

    it('caps the tool list so a long run stays readable', () => {
      const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
      const msg = buildTimeoutPartialWorkMessage({ narrationCount: 1, toolNames: many })!;
      expect(msg).toContain('`f`');
      expect(msg).not.toContain('`g`');
      expect(msg).toContain('and 3 more');
    });
  });
});

describe('hasDeferredMediaBudgetToolCall', () => {
  it('returns false for non-array input', () => {
    expect(hasDeferredMediaBudgetToolCall(undefined)).toBe(false);
    expect(hasDeferredMediaBudgetToolCall(null)).toBe(false);
  });

  it('returns false when no tool call was deferred', () => {
    const toolCalls = [
      { result: { success: true, imageUrl: 'https://s3/v1.png' } },
      { result: { success: true, imageUrl: 'https://s3/v2.png' } },
    ];
    expect(hasDeferredMediaBudgetToolCall(toolCalls)).toBe(false);
  });

  it('returns true when a generate_image call was deferred for the media time budget', () => {
    const toolCalls = [
      { result: { success: true, imageUrl: 'https://s3/v1.png' } },
      { result: { success: true, imageUrl: 'https://s3/v2.png' } },
      { result: { success: true, imageUrl: 'https://s3/v3.png' } },
      { result: { deferred: true, reason: 'media_generation_time_budget' } },
    ];
    expect(hasDeferredMediaBudgetToolCall(toolCalls)).toBe(true);
  });

  it('does NOT treat an ENG-822 handler-supplied deferral (different reason) as a media-budget deferral', () => {
    const toolCalls = [
      { result: { deferred: true, reason: 'anonymous_account_scoped' } },
    ];
    expect(hasDeferredMediaBudgetToolCall(toolCalls)).toBe(false);
  });

  it('ignores malformed entries', () => {
    const toolCalls = [null, undefined, {}, { result: null }, { result: {} }] as any;
    expect(hasDeferredMediaBudgetToolCall(toolCalls)).toBe(false);
  });
});

describe('hasPersistedMediaBudgetDeferral', () => {
  // ENG-1239: hasDeferredMediaBudgetToolCall only sees a settled turn's OWN toolCalls
  // ledger — it can't tell the whole-turn-timeout catch branch (agentModeController.ts)
  // whether the turn it just abandoned was mid-media-batch, because that branch never
  // gets a `response` object (the generation promise rejected). This reads the same
  // signal off the PERSISTED session history instead — the tool-role message toolDispatch
  // writes the instant it defers a media call (metadata.mediaBudgetDeferred: true,
  // matches the real production session 822c1ed4 at 2026-08-14T18:20:51.907Z) — so the
  // catch branch can tell a genuine media-batch pause apart from an unrelated timeout.
  const turnStart = Date.parse('2026-08-14T18:00:00Z');
  const deferredMarker = (iso: string) => ({
    role: 'tool',
    metadata: { mediaBudgetDeferred: true, timestamp: iso },
  });

  it('returns false for non-array input', () => {
    expect(hasPersistedMediaBudgetDeferral(undefined, turnStart)).toBe(false);
    expect(hasPersistedMediaBudgetDeferral(null, turnStart)).toBe(false);
  });

  it('returns false when nothing was deferred this turn', () => {
    const msgs = [
      { role: 'tool', metadata: { kind: 'image-generated', imageUrl: 'https://s3/v1.png', timestamp: '2026-08-14T18:20:51.906Z' } },
      { role: 'assistant', content: 'done', timestamp: '2026-08-14T18:20:52.000Z' },
    ];
    expect(hasPersistedMediaBudgetDeferral(msgs, turnStart)).toBe(false);
  });

  it('returns true for a deferral marker persisted at/after the turn started (the real incident shape)', () => {
    const msgs = [
      { role: 'tool', metadata: { kind: 'image-generated', imageUrl: 'https://s3/v1.png', timestamp: '2026-08-14T18:20:51.906Z' } },
      deferredMarker('2026-08-14T18:20:51.907Z'),
    ];
    expect(hasPersistedMediaBudgetDeferral(msgs, turnStart)).toBe(true);
  });

  it('ignores a deferral marker persisted before THIS turn started (an earlier turn already resolved it)', () => {
    expect(hasPersistedMediaBudgetDeferral([deferredMarker('2026-08-14T17:00:00Z')], turnStart)).toBe(false);
  });

  it('skips null/undefined entries and markers with no timestamp at all', () => {
    const msgs = [null, undefined, { role: 'tool', metadata: { mediaBudgetDeferred: true } }];
    expect(hasPersistedMediaBudgetDeferral(msgs as any, turnStart)).toBe(false);
  });
});

describe('hasUnresolvedMediaDeferral', () => {
  // ENG-1239: a durability backstop for the in-process auto-continuation chain — if the
  // backend process dies mid-batch (e.g. a deploy), the chain is lost with no record it
  // was ever attempted. This lets the NEXT touch of the session (e.g. the customer
  // reopening it) detect "the last thing that happened here was an unresolved media
  // pause" and re-trigger a resume, without a new persistence layer — just reading
  // whether the tail of session history still shows a pause nothing has resolved yet.
  it('returns false for non-array or empty input', () => {
    expect(hasUnresolvedMediaDeferral(undefined)).toBe(false);
    expect(hasUnresolvedMediaDeferral(null)).toBe(false);
    expect(hasUnresolvedMediaDeferral([])).toBe(false);
  });

  it('returns true when the last message is the whole-turn-timeout partial-delivery notice for a media batch', () => {
    const msgs = [
      { role: 'user', content: 'make 4 images' },
      { role: 'assistant', content: '3 done so far', metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs)).toBe(true);
  });

  it('returns true when the last message is the model\'s own reply carrying a deferred generate_image toolCall', () => {
    const msgs = [
      {
        role: 'assistant',
        content: '3 of 4 done, reply continue',
        metadata: { toolCalls: [{ result: { deferred: true, reason: 'media_generation_time_budget' } }] },
      },
    ];
    expect(hasUnresolvedMediaDeferral(msgs)).toBe(true);
  });

  it('returns false when the last message is a normal completed reply (nothing pending)', () => {
    const msgs = [
      { role: 'assistant', content: '3 done', metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true } },
      { role: 'assistant', content: 'All 4 creatives are ready.', metadata: { toolCalls: [{ result: { success: true } }] } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs)).toBe(false);
  });

  it('returns false once superseded by the round-cap exhaustion notice (auto-retry must not loop forever)', () => {
    const msgs = [
      { role: 'assistant', content: '3 done', metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true } },
      { role: 'assistant', content: "couldn't finish automatically", metadata: { kind: 'auto-continuation-exhausted' } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs)).toBe(false);
  });

  it('returns false for a non-media whole-turn-timeout notice (generic salvaged-work pause)', () => {
    const msgs = [
      { role: 'assistant', content: 'partial research results', metadata: { kind: 'generation-timeout-continuation' } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs)).toBe(false);
  });

  // ENG-1239 (live-tested, ENG-1239 rework verification): a process death (e.g. a deploy)
  // can kill the auto-continuation's OWN turn AFTER it persists the synthetic
  // `[SYSTEM]` directive (role: 'user', kind: 'auto-continuation') but BEFORE it produces
  // any reply — leaving that directive itself as the dangling last message. The two
  // assistant-authored shapes above don't match a 'user'-role tail, so this needs its own
  // check: verified live on the preview (session ef03e629), where killing the backend
  // right after the continuation's directive was saved left getSession unable to detect
  // anything was unresolved until this case was added.
  it('returns true when the last message is OUR OWN dangling auto-continuation directive with no reply yet', () => {
    const msgs = [
      { role: 'assistant', content: '3 done', metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true } },
      { role: 'user', content: '[SYSTEM] This is an automatic continuation...', metadata: { kind: 'auto-continuation', timestamp: '2026-08-14T18:21:20Z' } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs)).toBe(true);
  });

  it('does NOT treat a REAL dangling customer message (no auto-continuation kind) as an unresolved media deferral', () => {
    const msgs = [
      { role: 'assistant', content: '3 done', metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true } },
      { role: 'user', content: 'actually, can you also add a fifth image?', metadata: { timestamp: '2026-08-14T18:21:20Z' } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs)).toBe(false);
  });

  it('ignores a null/malformed last entry', () => {
    expect(hasUnresolvedMediaDeferral([{ role: 'user', content: 'hi' }, null] as any)).toBe(false);
  });

  // CodeRabbit (PR #2479): incremental checkpointing (persistIncrementally) can persist
  // the raw tool-role deferral marker toolDispatch writes (metadata.mediaBudgetDeferred:
  // true) BEFORE the model's own follow-up narration is ever composed — a process death in
  // exactly that window leaves that tool-role message as the tail, a THIRD unresolved shape
  // neither the user- nor assistant-authored checks above matched. Safe to key off the flag
  // alone now: toolDispatch only ever sets it for a genuine media-budget pause (a
  // handler-supplied deferral, e.g. ENG-822's anonymous-account-scoped refusal, is
  // deliberately left untagged — see toolDispatch.ts and its own regression test).
  it('returns true when the last message is the raw tool-role deferral marker (a checkpoint mid-turn)', () => {
    const msgs = [
      { role: 'user', content: 'make 4 images' },
      { role: 'tool', content: 'paused...', metadata: { mediaBudgetDeferred: true, timestamp: '2026-08-19T18:00:00Z' } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs)).toBe(true);
  });

  it('does NOT treat a tool-role message without the mediaBudgetDeferred flag as unresolved', () => {
    const msgs = [
      { role: 'tool', content: 'Sign in to use this feature.', metadata: { timestamp: '2026-08-19T18:00:00Z' } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs)).toBe(false);
  });

  // ENG-1239 (rework): getSession is a passive READ endpoint — merely reopening a session
  // must never silently spend the customer's credits on a batch they may have long since
  // abandoned. sinceMs bounds the backstop to a genuinely RECENT pause; an old one just sits
  // there until the customer explicitly re-engages (types "continue"), same as pre-fix.
  // Optional and defaults to no bound, so every test above (and any other caller) is
  // unaffected — only getSession opts into staleness bounding.
  it('returns false for an otherwise-matching pause older than sinceMs (stale — do not auto-resume on a passive reopen)', () => {
    const sinceMs = Date.parse('2026-08-14T18:00:00Z');
    const msgs = [
      { role: 'assistant', content: '3 done', metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true, timestamp: '2026-08-14T17:00:00Z' } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs, sinceMs)).toBe(false);
  });

  it('returns true for a matching pause at/after sinceMs', () => {
    const sinceMs = Date.parse('2026-08-14T18:00:00Z');
    const msgs = [
      { role: 'assistant', content: '3 done', metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true, timestamp: '2026-08-14T18:05:00Z' } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs, sinceMs)).toBe(true);
  });

  it('treats a dangling auto-continuation directive with no timestamp at all as stale once sinceMs is set (fail closed)', () => {
    const sinceMs = Date.parse('2026-08-14T18:00:00Z');
    const msgs = [
      { role: 'user', content: '[SYSTEM] automatic continuation...', metadata: { kind: 'auto-continuation' } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs, sinceMs)).toBe(false);
  });

  it('defaults to no staleness bound when sinceMs is omitted (backward compatible)', () => {
    const msgs = [
      { role: 'assistant', content: '3 done', metadata: { kind: 'generation-timeout-continuation', mediaBudgetDeferred: true, timestamp: '2020-01-01T00:00:00Z' } },
    ];
    expect(hasUnresolvedMediaDeferral(msgs)).toBe(true);
  });
});
