/**
 * ENG-1986 (ENG-885 rail 3): Meta connected-account expiry/reconnect handoff.
 * Acceptance: one actionable handoff naming customer + account; one next actor;
 * post-reconnect read-back; failed refresh becomes visible.
 */
jest.mock('../services/metaService', () => ({
  metaService: { getAdAccountCurrency: jest.fn() },
}));
jest.mock('../services/metaConnectionExpiredAlert', () => ({
  sendMetaConnectionExpiredAlert: jest.fn(),
}));

import { metaService } from '../services/metaService';
import { sendMetaConnectionExpiredAlert } from '../services/metaConnectionExpiredAlert';
import {
  decideMetaHandoff,
  raiseMetaConnectionHandoff,
  verifyMetaAdAccountReadBack,
} from '../services/metaConnectionHandoff';

const NOW = Date.parse('2026-10-13T00:00:00Z');
const account = (expiresAt?: number) => ({
  account_id: '123',
  account_name: 'Haven Ads',
  config: { account_type: 'ad_account', access_token: 't', token_expires_at: expiresAt } as any,
});

describe('decideMetaHandoff', () => {
  it('expired token -> Customer reconnect', () => {
    const d = decideMetaHandoff({ reason: 'refresh_failed', userId: 'u', account: account(NOW - 1), error: 'boom', now: NOW });
    expect(d).toMatchObject({ nextActor: 'Customer', expired: true });
  });
  it('OAuthException 190 while in date -> Customer', () => {
    const d = decideMetaHandoff({ reason: 'refresh_failed', userId: 'u', account: account(NOW + 1e9), error: 'Error validating access token (#190) OAuthException', now: NOW });
    expect(d.nextActor).toBe('Customer');
  });
  it('in-date token with non-auth failure -> Engineering', () => {
    const d = decideMetaHandoff({ reason: 'refresh_failed', userId: 'u', account: account(NOW + 1e9), error: 'ETIMEDOUT', now: NOW });
    expect(d).toMatchObject({ nextActor: 'Engineering', expired: false });
  });
  it('failed post-reconnect read-back -> Engineering, never asks customer to reconnect again', () => {
    const d = decideMetaHandoff({ reason: 'reconnect_readback_failed', userId: 'u', account: account(NOW + 1e9), error: 'OAuthException', now: NOW });
    expect(d.nextActor).toBe('Engineering');
  });
});

describe('raiseMetaConnectionHandoff', () => {
  beforeEach(() => jest.clearAllMocks());

  it('alerts once, facts only, when an existing connection expired', async () => {
    (sendMetaConnectionExpiredAlert as jest.Mock).mockResolvedValue(true);
    const ok = await raiseMetaConnectionHandoff({
      reason: 'refresh_failed', userId: 'u1', customerEmail: 'a@haven.com', account: account(NOW - 1), error: 'expired', now: NOW,
    });
    expect(ok).toBe(true);
    expect(sendMetaConnectionExpiredAlert).toHaveBeenCalledWith({
      accountId: '123', accountName: 'Haven Ads', customerEmail: 'a@haven.com', userId: 'u1',
      expiredAt: NOW - 1, error: 'expired', now: NOW,
    });
  });

  it('does not alert when the token is still in date and the error is not a dead token', async () => {
    const ok = await raiseMetaConnectionHandoff({
      reason: 'refresh_failed', userId: 'u1', account: account(NOW + 86400000), error: '(#4) rate limited', now: NOW,
    });
    expect(ok).toBe(false);
    expect(sendMetaConnectionExpiredAlert).not.toHaveBeenCalled();
  });

  it('does not alert on a reconnect read-back failure (the connection was not lost)', async () => {
    const ok = await raiseMetaConnectionHandoff({
      reason: 'reconnect_readback_failed', userId: 'u1', account: account(NOW + 86400000), error: '(#200) no permission', now: NOW,
    });
    expect(ok).toBe(false);
    expect(sendMetaConnectionExpiredAlert).not.toHaveBeenCalled();
  });

  it('never throws when the alert send fails', async () => {
    (sendMetaConnectionExpiredAlert as jest.Mock).mockRejectedValue(new Error('smtp down'));
    await expect(
      raiseMetaConnectionHandoff({ reason: 'refresh_failed', userId: 'u', account: account(NOW - 1), error: 'expired', now: NOW })
    ).resolves.toBe(false);
  });
});

describe('verifyMetaAdAccountReadBack', () => {
  it('ok when the Graph read succeeds', async () => {
    (metaService.getAdAccountCurrency as jest.Mock).mockResolvedValue('USD');
    await expect(verifyMetaAdAccountReadBack('123', 't')).resolves.toEqual({ ok: true });
    expect(metaService.getAdAccountCurrency).toHaveBeenCalledWith('123', 't');
  });
  it('reports the error instead of trusting the OAuth callback', async () => {
    (metaService.getAdAccountCurrency as jest.Mock).mockRejectedValue(new Error('(#200) no permission'));
    await expect(verifyMetaAdAccountReadBack('123', 't')).resolves.toEqual({ ok: false, error: '(#200) no permission' });
  });
});
