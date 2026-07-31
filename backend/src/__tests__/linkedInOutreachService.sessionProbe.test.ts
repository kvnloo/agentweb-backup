/**
 * ENG-281 — session probe classification.
 *
 * `probeAccountSession` is the contract the mandatory outreach preflight blocks on,
 * so it MUST distinguish "the LinkedIn session is proven dead" from "the probe could
 * not tell". Collapsing the two (the original `isAccountConnected` boolean) means a
 * timeout or a 5xx suppresses a HEALTHY account behind a false reconnect prompt for
 * the probe's full 10-minute cache window — the regression Greptile flagged on
 * 4b933aeec.
 *
 * These tests fail against the pre-fix implementation, where every caught error
 * produced `connected = false`.
 */

jest.mock('unipile-node-sdk', () => ({
  UnipileClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('../utils/secretsManager', () => ({
  getUnipileCredentials: jest.fn().mockResolvedValue({ dsn: 'https://api.unipile.com', apiKey: 'test-key' }),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn().mockResolvedValue(null) },
}));

import { LinkedInOutreachService } from '../services/linkedInOutreachService';

/** A client whose account lookup rejects with `error`. */
function clientRejecting(error: any) {
  return {
    account: { getOne: jest.fn().mockRejectedValue(error) },
    request: { send: jest.fn() },
  } as any;
}

function makeService(client: any) {
  const svc = new LinkedInOutreachService();
  jest.spyOn(svc, 'getClient').mockResolvedValue(client);
  return svc;
}

describe('LinkedInOutreachService.probeAccountSession (ENG-281)', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('definitively disconnected — safe to block the action', () => {
    it("classifies Unipile's errors/disconnected_account as disconnected", async () => {
      const err: any = new Error('Disconnected account');
      err.structuredError = { code: 'errors/disconnected_account', status: 401, classification: 'AUTH_ERROR' };
      const svc = makeService(clientRejecting(err));

      await expect(svc.probeAccountSession('acct-1')).resolves.toBe('disconnected');
    });

    it('classifies a bare HTTP 401 as disconnected', async () => {
      const svc = makeService(clientRejecting({ body: { status: 401 } }));

      await expect(svc.probeAccountSession('acct-2')).resolves.toBe('disconnected');
    });

    it('classifies an AUTH_ERROR classification with no specific code as disconnected', async () => {
      const svc = makeService(clientRejecting({ body: { classification: 'AUTH_ERROR' } }));

      await expect(svc.probeAccountSession('acct-3')).resolves.toBe('disconnected');
    });
  });

  describe('indeterminate — must NOT be reported as a dead session', () => {
    it('classifies a probe timeout as unknown, not disconnected', async () => {
      const err: any = new Error('LinkedIn connectivity check timed out');
      err.isTimeout = true;
      const svc = makeService(clientRejecting(err));

      await expect(svc.probeAccountSession('acct-4')).resolves.toBe('unknown');
    });

    it('classifies an upstream 500 as unknown, not disconnected', async () => {
      const svc = makeService(clientRejecting({ body: { status: 500, code: 'errors/internal' } }));

      await expect(svc.probeAccountSession('acct-5')).resolves.toBe('unknown');
    });

    it('classifies a transport/network failure as unknown, not disconnected', async () => {
      const svc = makeService(clientRejecting(new Error('ECONNRESET')));

      await expect(svc.probeAccountSession('acct-6')).resolves.toBe('unknown');
    });
  });

  it('classifies a successful probe as connected', async () => {
    const svc = makeService({
      account: { getOne: jest.fn().mockResolvedValue({ connection_params: {} }) },
      request: { send: jest.fn() },
    } as any);

    await expect(svc.probeAccountSession('acct-7')).resolves.toBe('connected');
  });

  describe('isAccountConnected keeps its previous semantics for existing callers', () => {
    it('returns false for an indeterminate probe (unchanged from before ENG-281)', async () => {
      const err: any = new Error('timeout');
      err.isTimeout = true;
      const svc = makeService(clientRejecting(err));

      // Existing callers (resolveAccountId's fallback loop, admin status) still see
      // `false` and skip the account — only the blocking preflight reads the
      // tri-state and treats this case as "proceed".
      await expect(svc.isAccountConnected('acct-8')).resolves.toBe(false);
    });

    it('returns false for a definitively disconnected session', async () => {
      const svc = makeService(clientRejecting({ body: { status: 401 } }));

      await expect(svc.isAccountConnected('acct-9')).resolves.toBe(false);
    });

    it('returns true for a live session', async () => {
      const svc = makeService({
        account: { getOne: jest.fn().mockResolvedValue({ connection_params: {} }) },
        request: { send: jest.fn() },
      } as any);

      await expect(svc.isAccountConnected('acct-10')).resolves.toBe(true);
    });
  });
});
