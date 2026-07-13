import {
  _resetV0UsageGuardForTest,
  buildV0IdempotencyKey,
  isReservationBlocking,
  guardedV0ChatCreate,
  guardedV0CorrectionMessage,
  getV0UsageCountForScope,
  clearV0UsageForPage,
  type V0UsageRecord,
} from '../services/v0UsageGuard';

const reservedRecord = (updatedAt: string): V0UsageRecord => ({
  idempotencyKey: 'k',
  userId: 'u',
  operation: 'additional_page_chat_create',
  scopeId: 's',
  status: 'reserved',
  createdAt: updatedAt,
  updatedAt,
});

describe('v0UsageGuard', () => {
  beforeEach(() => {
    _resetV0UsageGuardForTest();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('buildV0IdempotencyKey — prompt-independent (ENG-287)', () => {
    // The enriched prompt is not stable between attempts (brand context varies), so
    // keying on it means retries never dedupe. The identity of "the same generation"
    // is (operation, user, site/scope, slug) — not the prompt text.
    const base = {
      userId: 'u1',
      operation: 'additional_page_chat_create' as const,
      scopeId: 'site_1',
      slug: 'book-a-demo',
    };

    test('same key for the same page regardless of prompt content', () => {
      expect(buildV0IdempotencyKey({ ...base, prompt: 'first enriched prompt' })).toBe(
        buildV0IdempotencyKey({ ...base, prompt: 'a totally different enriched prompt' }),
      );
    });

    test('different slug yields a different key', () => {
      expect(buildV0IdempotencyKey({ ...base, prompt: 'p' })).not.toBe(
        buildV0IdempotencyKey({ ...base, slug: 'other-slug', prompt: 'p' }),
      );
    });
  });

  describe('isReservationBlocking (ENG-287)', () => {
    const now = Date.parse('2026-07-10T04:00:00.000Z');
    const TTL = 20 * 60 * 1000;

    test('no record does not block', () => {
      expect(isReservationBlocking(undefined, now, TTL)).toBe(false);
    });

    test('a failed record does not block a retry', () => {
      const rec = { ...reservedRecord('2026-07-10T03:59:00.000Z'), status: 'failed' as const };
      expect(isReservationBlocking(rec, now, TTL)).toBe(false);
    });

    test('a succeeded record does not block (handled as reuse elsewhere)', () => {
      const rec = { ...reservedRecord('2026-07-10T03:59:00.000Z'), status: 'succeeded' as const };
      expect(isReservationBlocking(rec, now, TTL)).toBe(false);
    });

    test('a fresh reserved record blocks (genuine concurrent generation)', () => {
      expect(isReservationBlocking(reservedRecord('2026-07-10T03:59:00.000Z'), now, TTL)).toBe(true);
    });

    test('a stale reserved record does not block (abandoned by a crash)', () => {
      // 25 min old > 20 min TTL → treat as abandoned so a retry can proceed.
      expect(isReservationBlocking(reservedRecord('2026-07-10T03:35:00.000Z'), now, TTL)).toBe(false);
    });
  });

  test('a retry after a failed attempt proceeds (never hard-fails as "in flight")', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(new Error('v0 chat creation (additional page) timed out after 300s'))
      .mockResolvedValueOnce({ id: 'chat_retry_ok' });

    await expect(
      guardedV0ChatCreate({
        userId: 'u1',
        operation: 'additional_page_chat_create',
        scopeId: 'site_1',
        slug: 'book-a-demo',
        prompt: 'attempt one enriched',
        create,
      }),
    ).rejects.toThrow(/timed out/);

    // Retry — different enriched prompt, same page. Must run, not throw "in flight".
    const second = await guardedV0ChatCreate({
      userId: 'u1',
      operation: 'additional_page_chat_create',
      scopeId: 'site_1',
      slug: 'book-a-demo',
      prompt: 'attempt two enriched (different)',
      create,
    });

    expect(second).toMatchObject({ id: 'chat_retry_ok' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  test('a genuinely in-progress generation blocks a concurrent duplicate', async () => {
    let release!: (v: { id: string }) => void;
    const inflight = new Promise<{ id: string }>((r) => {
      release = r;
    });
    const create = jest.fn().mockReturnValueOnce(inflight).mockResolvedValue({ id: 'x' });

    const args = {
      userId: 'u1',
      operation: 'additional_page_chat_create' as const,
      scopeId: 'site_1',
      slug: 'book-a-demo',
      prompt: 'p',
      create,
    };

    const first = guardedV0ChatCreate(args); // reserves, then awaits the hanging create
    await Promise.resolve(); // let the reservation land before the concurrent call

    await expect(guardedV0ChatCreate(args)).rejects.toThrow(/in progress/i);

    release({ id: 'chat_first' });
    await first;
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('reuses a completed chat for duplicate first-page idempotency key', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'chat_1' });

    const first = await guardedV0ChatCreate({
      userId: 'user_1',
      operation: 'first_page_chat_create',
      scopeId: 'page_1',
      prompt: 'Build a page',
      create,
    });
    const second = await guardedV0ChatCreate({
      userId: 'user_1',
      operation: 'first_page_chat_create',
      scopeId: 'page_1',
      prompt: '  build   a PAGE ',
      create,
    });

    expect(first).toMatchObject({ id: 'chat_1' });
    expect(second).toMatchObject({ id: 'chat_1', reused: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(getV0UsageCountForScope({ userId: 'user_1', scopeId: 'page_1' })).toBe(1);
  });

  test('keys additional-page chat creation by route identity, not prompt wording', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'chat_route' });

    const first = await guardedV0ChatCreate({
      userId: 'user_1',
      operation: 'additional_page_chat_create',
      scopeId: 'site_1',
      slug: 'rankai-book-a-demo',
      prompt: 'Build the RankAI booking page',
      create,
    });
    const second = await guardedV0ChatCreate({
      userId: 'user_1',
      operation: 'additional_page_chat_create',
      scopeId: 'site_1',
      slug: 'rankai-book-a-demo',
      prompt: 'Build the RankAI booking page with newer context',
      create,
    });

    expect(first).toMatchObject({ id: 'chat_route' });
    expect(second).toMatchObject({ id: 'chat_route', reused: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('does not include prompt hash in chat-create idempotency keys', () => {
    const keyA = buildV0IdempotencyKey({
      userId: 'user_1',
      operation: 'additional_page_chat_create',
      scopeId: 'site_1',
      slug: 'rankai-book-a-demo',
      prompt: 'first phrasing',
    });
    const keyB = buildV0IdempotencyKey({
      userId: 'user_1',
      operation: 'additional_page_chat_create',
      scopeId: 'site_1',
      slug: 'rankai-book-a-demo',
      prompt: 'second phrasing',
    });

    expect(keyA).toBe(keyB);
  });

  test('lets a stale reserved chat-create lock be retried', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T03:16:57.000Z'));
    const create = jest
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ id: 'chat_retry' });

    void guardedV0ChatCreate({
      userId: 'user_1',
      operation: 'additional_page_chat_create',
      scopeId: 'site_1',
      slug: 'rankai-book-a-demo',
      prompt: 'Build page',
      create,
    }).catch(() => {});

    jest.setSystemTime(new Date('2026-07-10T03:47:28.000Z'));
    const retry = await guardedV0ChatCreate({
      userId: 'user_1',
      operation: 'additional_page_chat_create',
      scopeId: 'site_1',
      slug: 'rankai-book-a-demo',
      prompt: 'Build page',
      create,
    });

    expect(retry).toMatchObject({ id: 'chat_retry' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  test('dedupes a double-fire of the SAME correction attempt', async () => {
    const send = jest.fn().mockResolvedValue({ ok: true });
    const args = { userId: 'user_1', scopeId: 'page_1', chatId: 'chat_1', attempt: 0, send };

    const first = await guardedV0CorrectionMessage(args);
    const second = await guardedV0CorrectionMessage(args);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ skipped: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a LATER correction attempt on the same chat still sends — the validation loop is 3 attempts, not 1 (ENG-287 residual F7)', async () => {
    // The correction key used to be (user, scope, chatId) with no attempt component, so
    // once the first correction succeeded every subsequent attempt returned {skipped:true}.
    // The call sites ignore that flag, so the loop re-downloaded the SAME broken zip and
    // failed identically — the 3-attempt self-heal was really 1 attempt + 2 wasted rounds.
    const send = jest.fn().mockResolvedValue({ ok: true });
    const base = { userId: 'user_1', scopeId: 'page_1', chatId: 'chat_1', send };

    const first = await guardedV0CorrectionMessage({ ...base, attempt: 0 });
    const second = await guardedV0CorrectionMessage({ ...base, attempt: 1 });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('a FAILED correction does not skip the retry — the validation loop depends on it (ENG-287)', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('v0 correction message timed out after 300s'))
      .mockResolvedValueOnce({ ok: true });

    await expect(
      guardedV0CorrectionMessage({ userId: 'user_1', scopeId: 'page_1', chatId: 'chat_1', send }),
    ).rejects.toThrow(/timed out/);

    const retry = await guardedV0CorrectionMessage({
      userId: 'user_1',
      scopeId: 'page_1',
      chatId: 'chat_1',
      send,
    });

    expect(retry).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('clearV0UsageForPage frees the identity — regenerating a deleted page gets a NEW chat (ENG-287)', async () => {
    const create = jest
      .fn()
      .mockResolvedValueOnce({ id: 'chat_old' })
      .mockResolvedValueOnce({ id: 'chat_new' });
    const args = {
      userId: 'user_1',
      operation: 'additional_page_chat_create' as const,
      scopeId: 'site_1',
      slug: 'book-a-demo',
      prompt: 'p',
      create,
    };

    await guardedV0ChatCreate(args);
    // Without the clear, the succeeded record is a permanent identity: the second
    // call would return chat_old as reused and silently ignore the new prompt.
    await clearV0UsageForPage({ userId: 'user_1', pageId: 'page_x', siteId: 'site_1', slug: 'book-a-demo' });
    const second = await guardedV0ChatCreate(args);

    expect(second).toMatchObject({ id: 'chat_new' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  describe('chat reuse is bounded by age — a `succeeded` row must not be immortal (ENG-287 residual F2)', () => {
    // `status: succeeded` means "the CHAT was created", NOT "a page was delivered".
    // Reuse is correct while v0 is merely slow (resume is free and catches a late
    // completion). It is a permanent wedge once the chat is a dead end: every retry
    // reuses the same dead chat, and since the prompt is deliberately not part of the
    // key, retrying with a DIFFERENT prompt changes nothing. The age ceiling is the
    // backstop that makes "cannot wedge" a guarantee rather than a hope.
    const args = () => ({
      userId: 'user_1',
      operation: 'additional_page_chat_create' as const,
      scopeId: 'site_1',
      slug: 'book-a-demo',
      prompt: 'p',
    });

    test('a FRESH succeeded chat is still reused — a slow v0 generation resumes for free', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-10T04:00:00.000Z'));
      const create = jest.fn().mockResolvedValue({ id: 'chat_1' });

      await guardedV0ChatCreate({ ...args(), create });
      // Retry 10 min later — inside the reuse ceiling. v0 may still be finishing.
      jest.setSystemTime(new Date('2026-07-10T04:10:00.000Z'));
      const second = await guardedV0ChatCreate({ ...args(), create });

      expect(second).toEqual({ id: 'chat_1', reused: true });
      expect(create).toHaveBeenCalledTimes(1); // no second charge
    });

    test('a STALE succeeded chat is NOT reused — the retry mints a fresh chat instead of wedging forever', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-10T04:00:00.000Z'));
      const create = jest
        .fn()
        .mockResolvedValueOnce({ id: 'chat_dead' })
        .mockResolvedValueOnce({ id: 'chat_fresh' });

      await guardedV0ChatCreate({ ...args(), create });
      // Past the 45-min reuse ceiling: whatever happened to chat_dead, it is never
      // going to deliver. Without this, the route is unbuildable for all time.
      jest.setSystemTime(new Date('2026-07-10T05:00:00.000Z'));
      const second = await guardedV0ChatCreate({ ...args(), create });

      expect(second).toMatchObject({ id: 'chat_fresh' });
      expect(create).toHaveBeenCalledTimes(2);
    });
  });

  test('deleting a ROOT page does not free a sub-page identity that merely shares its slug (ENG-287 residual F11b)', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'chat_subpage' });
    const subPage = {
      userId: 'user_1',
      operation: 'additional_page_chat_create' as const,
      scopeId: 'site_1',
      slug: 'pricing',
      prompt: 'p',
      create,
    };

    await guardedV0ChatCreate(subPage);
    // Root pages have no slug. Passing a slug derived from the root's NAME could collide
    // with a real sub-page route on the same site and free the wrong identity.
    await clearV0UsageForPage({ userId: 'user_1', pageId: 'root_page', siteId: 'site_1' });
    const afterRootDelete = await guardedV0ChatCreate(subPage);

    expect(afterRootDelete).toEqual({ id: 'chat_subpage', reused: true });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
