import {
  MAX_TASTE_ITEMS,
  MAX_TASTE_SOURCES,
  TASTE_MEMORY_PREFIX,
  TasteMemoryStore,
  TasteProfileService,
  TasteSourceAccessError,
  TasteValidationError,
} from '../services/tasteProfileService';

function memoryHarness(seed: any[] = []) {
  const rows = [...seed];
  let counter = 0;
  const store: TasteMemoryStore = {
    getUserMemories: jest.fn(async () => [...rows]),
    addMemory: jest.fn(async (userId, category, content, sourceSessionId) => {
      const item = {
        userId,
        memoryId: `m-${++counter}`,
        category,
        content,
        sourceSessionId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      rows.push(item);
      return item;
    }),
    updateMemory: jest.fn(async (_userId, memoryId, updates) => {
      const index = rows.findIndex((row) => row.memoryId === memoryId);
      if (index < 0) return undefined;
      rows[index] = { ...rows[index], ...updates, updatedAt: new Date().toISOString() };
      return rows[index];
    }),
    deleteMemory: jest.fn(async (_userId, memoryId) => {
      const index = rows.findIndex((row) => row.memoryId === memoryId);
      if (index >= 0) rows.splice(index, 1);
    }),
  };
  return { store, rows };
}

describe('TasteProfileService', () => {
  it('imports X bookmarks through the existing account-scoped reader and persists aggregates only', async () => {
    const xReader = {
      getBookmarks: jest.fn().mockResolvedValue([
        {
          id: '1',
          text: 'minimal typography motion unique-private-phrase-123',
          entities: { urls: [{ expanded_url: 'https://linear.app/acme/private-board#secret' }] },
        },
        {
          id: '2',
          text: 'minimal typography motion',
          entities: { urls: [{ expanded_url: 'https://linear.app/another' }] },
        },
      ]),
    };
    const { store, rows } = memoryHarness();
    const service = new TasteProfileService(xReader, store);

    const profile = await service.importXBookmarks('user-a', 'acct-a');

    expect(xReader.getBookmarks).toHaveBeenCalledWith('user-a', 'acct-a');
    expect(profile.sources).toEqual([{ source: 'x_bookmarks', itemCount: 2 }]);
    expect(profile.topDomains).toContain('linear.app');
    expect(profile.styleSignals.map((signal) => signal.name)).toEqual(
      expect.arrayContaining(['minimal', 'motion', 'editorial'])
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('preference');
    expect(rows[0].sourceSessionId).toMatch(new RegExp(`^${TASTE_MEMORY_PREFIX}`));
    expect(rows[0].content).not.toContain('unique-private-phrase-123');
    expect(rows[0].content).not.toContain('/acme/private-board');
    expect(rows[0].content).not.toContain('acct-a');
  });

  it('maps a non-owned or missing X account to the same tenant-safe error', async () => {
    const xReader = {
      getBookmarks: jest.fn().mockRejectedValue(
        new Error('No twitter account with id "unavailable-account" connected for this user')
      ),
    };
    const { store } = memoryHarness();
    const service = new TasteProfileService(xReader, store);

    await expect(service.importXBookmarks('user-a', 'unavailable-account'))
      .rejects.toBeInstanceOf(TasteSourceAccessError);
    expect(store.addMemory).not.toHaveBeenCalled();
  });

  it('rejects credential-shaped fields in generic collection items', async () => {
    const { store } = memoryHarness();
    const service = new TasteProfileService({ getBookmarks: jest.fn() }, store);
    const sensitiveField = ['access', 'token'].join('_');
    const item: any = { title: 'reference' };
    item[sensitiveField] = 'REDACTED';

    await expect(service.importCollection('user-a', [item]))
      .rejects.toBeInstanceOf(TasteValidationError);
    expect(store.addMemory).not.toHaveBeenCalled();
  });

  it('enforces a bounded collection size before persistence', async () => {
    const { store } = memoryHarness();
    const service = new TasteProfileService({ getBookmarks: jest.fn() }, store);
    const items = Array.from({ length: MAX_TASTE_ITEMS + 1 }, (_, index) => ({
      title: `reference ${index}`,
    }));

    await expect(service.importCollection('user-a', items))
      .rejects.toThrow(`items supports at most ${MAX_TASTE_ITEMS} entries`);
    expect(store.addMemory).not.toHaveBeenCalled();
  });

  it('normalizes and deduplicates collection items without retaining URL paths', async () => {
    const { store, rows } = memoryHarness();
    const service = new TasteProfileService({ getBookmarks: jest.fn() }, store);

    const profile = await service.importCollection(
      'user-a',
      [
        { title: 'Minimal editorial grid', url: 'https://example.com/a#fragment', tags: ['minimal'] },
        { title: 'Minimal editorial grid', url: 'https://example.com/a#fragment', tags: ['minimal'] },
        { title: 'Subtle motion grid', url: 'https://example.com/b', tags: ['motion'] },
      ],
      'design-board'
    );

    expect(profile.itemCount).toBe(2);
    expect(profile.topDomains).toEqual(['example.com']);
    expect(store.addMemory).toHaveBeenCalledTimes(1);
    expect(rows[0].content).not.toContain('/a');
    expect(rows[0].content).not.toContain('/b');
  });

  it('re-importing the same source updates its aggregate instead of multiplying memories', async () => {
    const xReader = {
      getBookmarks: jest
        .fn()
        .mockResolvedValueOnce([
          { text: 'minimal minimal typography typography' },
          { text: 'motion motion' },
        ])
        .mockResolvedValueOnce([
          { text: 'premium premium refined refined' },
        ]),
    };
    const { store, rows } = memoryHarness();
    const service = new TasteProfileService(xReader, store);

    await service.importXBookmarks('user-a', 'acct-a');
    await service.importXBookmarks('user-a', 'acct-a');

    expect(rows).toHaveLength(1);
    expect(store.addMemory).toHaveBeenCalledTimes(1);
    expect(store.updateMemory).toHaveBeenCalledTimes(1);
    const profile = await service.getProfile('user-a');
    expect(profile.itemCount).toBe(1);
    expect(profile.styleSignals.map((signal) => signal.name)).toContain('premium');
  });

  it('aggregates separate X and design-collection snapshots into one profile', async () => {
    const xReader = {
      getBookmarks: jest.fn().mockResolvedValue([
        { text: 'minimal minimal motion motion typography typography' },
      ]),
    };
    const { store } = memoryHarness();
    const service = new TasteProfileService(xReader, store);

    await service.importXBookmarks('user-a', 'acct-a');
    const profile = await service.importCollection(
      'user-a',
      [
        { title: 'editorial editorial premium premium' },
        { title: 'motion motion subtle subtle' },
      ],
      'moodboard'
    );

    expect(profile.sourceCount).toBe(2);
    expect(profile.itemCount).toBe(3);
    expect(profile.sources).toEqual([
      { source: 'collection', itemCount: 2 },
      { source: 'x_bookmarks', itemCount: 1 },
    ]);
  });



  it('projects one profile through surface-specific Taste Skill rules', async () => {
    const { store } = memoryHarness();
    const service = new TasteProfileService({ getBookmarks: jest.fn() }, store);

    await service.importCollection(
      'user-a',
      [
        { title: 'minimal minimal editorial editorial motion motion', url: 'https://example.com/a' },
        { title: 'minimal editorial motion', url: 'https://example.com/b' },
      ],
      'design-board'
    );

    const landing = await service.getApplication('user-a', 'landing_page');
    expect(landing.active).toBe(true);
    expect(landing.intensity).toBe('strong');
    expect(landing.dials.designVariance).toBeGreaterThanOrEqual(1);
    expect(landing.dials.designVariance).toBeLessThanOrEqual(10);
    expect(landing.promptContext).toContain('Apply the Taste Skill process');
    expect(landing.promptContext).toContain('DESIGN_VARIANCE=');
    expect(landing.promptContext).toContain('Existing brand assets');

    const research = await service.getApplication('user-a', 'research');
    expect(research.active).toBe(true);
    expect(research.intensity).toBe('subtle');
    expect(research.promptContext).toContain('must never change factual findings');

    const email = await service.getApplication('user-a', 'email');
    expect(email.active).toBe(false);
    expect(email.intensity).toBe('off');
    expect(email.promptContext).toBe('');
  });

  it('applies Taste to a prompt without exposing raw source content', async () => {
    const { store } = memoryHarness();
    const service = new TasteProfileService({ getBookmarks: jest.fn() }, store);

    await service.importCollection(
      'user-a',
      [
        { title: 'premium premium motion motion secret-once-only' },
        { title: 'premium motion' },
      ],
      'refs'
    );

    const applied = await service.applyToPrompt(
      'user-a',
      'image',
      'Create a product hero image',
      'strong'
    );

    expect(applied.prompt).toContain('Create a product hero image');
    expect(applied.prompt).toContain('TASTE CONTEXT');
    expect(applied.prompt).toContain('intensity=strong');
    expect(applied.prompt).not.toContain('secret-once-only');
  });

  it('leaves prompts unchanged when the surface defaults Taste off', async () => {
    const { store } = memoryHarness();
    const service = new TasteProfileService({ getBookmarks: jest.fn() }, store);
    await service.importCollection('user-a', [{ title: 'minimal minimal' }], 'refs');

    const applied = await service.applyToPrompt('user-a', 'crm', 'Find overdue leads');

    expect(applied.application.active).toBe(false);
    expect(applied.prompt).toBe('Find overdue leads');
  });

  it('caps durable source fan-out while still allowing an existing source to be replaced', async () => {
    const seed = Array.from({ length: MAX_TASTE_SOURCES }, (_, index) => ({
      memoryId: `taste-${index}`,
      category: 'preference',
      content: `Taste Profile aggregate (raw source content intentionally not retained): {"schema":"taste.profile.v1","source":"collection","sourceKey":"seed-${index}","itemCount":1,"topDomains":[],"topTerms":[],"styleSignals":[],"generatedAt":"2026-09-30T00:00:00.000Z"}`,
      sourceSessionId: `${TASTE_MEMORY_PREFIX}seed-${index}`,
    }));
    const { store } = memoryHarness(seed);
    const service = new TasteProfileService({ getBookmarks: jest.fn() }, store);

    await expect(service.importCollection('user-a', [{ title: 'new reference' }], 'new-source'))
      .rejects.toThrow(`Taste supports at most ${MAX_TASTE_SOURCES} durable sources`);
    expect(store.addMemory).not.toHaveBeenCalled();
  });

  it('deletes only Taste memories for the authenticated user', async () => {
    const { store, rows } = memoryHarness([
      {
        memoryId: 'taste-1',
        category: 'preference',
        content: 'Taste Profile aggregate: {}',
        sourceSessionId: `${TASTE_MEMORY_PREFIX}x-hash`,
      },
      {
        memoryId: 'normal-1',
        category: 'preference',
        content: 'Prefers weekly reports',
        sourceSessionId: 'session-123',
      },
    ]);
    const service = new TasteProfileService({ getBookmarks: jest.fn() }, store);

    const deleted = await service.deleteProfile('user-a');

    expect(deleted).toBe(1);
    expect(store.deleteMemory).toHaveBeenCalledWith('user-a', 'taste-1');
    expect(rows.map((row) => row.memoryId)).toEqual(['normal-1']);
  });
});
