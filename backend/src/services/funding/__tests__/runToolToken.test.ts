import { RunToolTokenStore } from '../runToolToken';
import { turnRunReq } from '../../../loginHost/protocol';

const CLAIMS = { runId: 'run-1', userId: 'user-1', sessionId: 'session-1' };

describe('RunToolTokenStore', () => {
  describe('the token is accepted by the login host\'s own request schema', () => {
    const accepted = (token: string) => turnRunReq.shape.bridgeToken.safeParse(token).success;

    it('even when the random bytes would start the base64url text with "-" or "_" (a bare token failed ~1 turn in 32 before it was sent)', () => {
      const spy = jest.spyOn(require('crypto'), 'randomBytes');
      try {
        for (const first of [0xf8, 0xfc]) {
          // 0xf8... => base64url "-", 0xfc... => "_"
          spy.mockReturnValueOnce(Buffer.concat([Buffer.from([first]), Buffer.alloc(31, 7)]) as never);
          const store = new RunToolTokenStore();
          const token = store.mint(CLAIMS);
          expect(token).toContain(Buffer.concat([Buffer.from([first]), Buffer.alloc(31, 7)]).toString('base64url'));
          expect(accepted(token)).toBe(true);
          expect(store.verify(token)).toMatchObject({ ok: true });
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('for every starting symbol, and for ordinary random tokens', () => {
      const store = new RunToolTokenStore();
      for (let i = 0; i < 2000; i++) expect(accepted(store.mint({ ...CLAIMS, runId: `run-${i}` }))).toBe(true);
    });
  });

  it('verifies a minted token and returns the run it is bound to', () => {
    const store = new RunToolTokenStore();
    const token = store.mint(CLAIMS);
    expect(store.verify(token)).toEqual({ ok: true, claims: CLAIMS });
    expect(store.verify(token, 'run-1')).toEqual({ ok: true, claims: CLAIMS });
  });

  it('rejects a missing token', () => {
    const store = new RunToolTokenStore();
    store.mint(CLAIMS);
    expect(store.verify(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(store.verify('')).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a forged token', () => {
    const store = new RunToolTokenStore();
    const token = store.mint(CLAIMS);
    expect(store.verify('not-a-real-token')).toEqual({ ok: false, reason: 'unknown' });
    expect(store.verify(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a valid token presented for a different run', () => {
    const store = new RunToolTokenStore();
    const tokenA = store.mint(CLAIMS);
    store.mint({ runId: 'run-2', userId: 'user-2', sessionId: 'session-2' });
    expect(store.verify(tokenA, 'run-2')).toEqual({ ok: false, reason: 'wrong_run' });
  });

  it('expires a token that has been idle for the TTL, and forgets it', () => {
    let now = 1_000;
    const store = new RunToolTokenStore({ ttlMs: 500, now: () => now });
    const token = store.mint(CLAIMS);
    now = 1_500;
    expect(store.verify(token)).toEqual({ ok: false, reason: 'expired' });
    expect(store.verify(token)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('keeps a token alive while it is in use: each successful verify extends it', () => {
    let now = 1_000;
    const store = new RunToolTokenStore({ ttlMs: 500, now: () => now });
    const token = store.mint(CLAIMS);
    now = 1_499;
    expect(store.verify(token).ok).toBe(true);
    now = 1_998;
    expect(store.verify(token).ok).toBe(true);
    now = 2_498;
    expect(store.verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('does not extend a token when it is presented for the wrong run', () => {
    let now = 1_000;
    const store = new RunToolTokenStore({ ttlMs: 500, now: () => now });
    const token = store.mint(CLAIMS);
    now = 1_400;
    expect(store.verify(token, 'run-2')).toEqual({ ok: false, reason: 'wrong_run' });
    now = 1_500;
    expect(store.verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token once its run is revoked', () => {
    const store = new RunToolTokenStore();
    const token = store.mint(CLAIMS);
    store.revokeRun('run-1');
    expect(store.verify(token)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('minting again for the same run kills the earlier token', () => {
    const store = new RunToolTokenStore();
    const first = store.mint(CLAIMS);
    const second = store.mint(CLAIMS);
    expect(first).not.toEqual(second);
    expect(store.verify(first)).toEqual({ ok: false, reason: 'unknown' });
    expect(store.verify(second).ok).toBe(true);
  });

  it('revoking one run leaves another run\'s token working', () => {
    const store = new RunToolTokenStore();
    const tokenA = store.mint(CLAIMS);
    const tokenB = store.mint({ runId: 'run-2', userId: 'user-2', sessionId: 'session-2' });
    store.revokeRun('run-1');
    expect(store.verify(tokenA).ok).toBe(false);
    expect(store.verify(tokenB).ok).toBe(true);
  });
});
