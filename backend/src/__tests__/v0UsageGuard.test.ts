import {
  _resetV0UsageGuardForTest,
  guardedV0ChatCreate,
  guardedV0CorrectionMessage,
  getV0UsageCountForScope,
} from '../services/v0UsageGuard';

describe('v0UsageGuard', () => {
  beforeEach(() => {
    _resetV0UsageGuardForTest();
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
