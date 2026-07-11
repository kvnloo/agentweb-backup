import {
  _resetV0UsageGuardForTest,
  buildV0IdempotencyKey,
  guardedV0ChatCreate,
  guardedV0CorrectionMessage,
  getV0UsageCountForScope,
} from '../services/v0UsageGuard';

describe('v0UsageGuard', () => {
  beforeEach(() => {
    _resetV0UsageGuardForTest();
  });

  afterEach(() => {
    jest.useRealTimers();
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

  test('allows only one correction message per chat', async () => {
    const send = jest.fn().mockResolvedValue({ ok: true });

    const first = await guardedV0CorrectionMessage({
      userId: 'user_1',
      scopeId: 'page_1',
      chatId: 'chat_1',
      send,
    });
    const second = await guardedV0CorrectionMessage({
      userId: 'user_1',
      scopeId: 'page_1',
      chatId: 'chat_1',
      send,
    });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ skipped: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
