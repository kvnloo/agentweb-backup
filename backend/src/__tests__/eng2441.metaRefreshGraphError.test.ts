jest.mock('../services/metaService', () => ({ metaService: { extendAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ updateAccountTokens: jest.fn() }));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn() }));

import { describeMetaRefreshError } from '../services/metaTokenRefresh';
import { decideMetaHandoff } from '../services/metaConnectionHandoff';

function axios400(graphError: any) {
  const e: any = new Error('Request failed with status code 400');
  e.response = { status: 400, data: { error: graphError } };
  return e;
}

describe('ENG-2441 Meta refresh error carries the Graph error body', () => {
  const invalidated = axios400({
    message: 'Error validating access token: The session has been invalidated because the user changed their password',
    type: 'OAuthException',
    code: 190,
    error_subcode: 460,
  });

  it('records Graph message, type, code and subcode', () => {
    const msg = describeMetaRefreshError(invalidated);
    expect(msg).toContain('session has been invalidated');
    expect(msg).toContain('OAuthException');
    expect(msg).toContain('code 190');
    expect(msg).toContain('subcode 460');
    expect(msg).toContain('Request failed with status code 400');
  });

  it('routes an in-date token with code 190 to Customer, not Engineering', () => {
    const now = Date.now();
    const decision = decideMetaHandoff({
      reason: 'refresh_failed',
      userId: 'u1',
      account: { account_id: '1030388036131162', account_name: 'Y', config: { token_expires_at: now + 14 * 86400000 } as any },
      error: describeMetaRefreshError(axios400({ message: 'Invalid OAuth access token data.', type: 'OAuthException', code: 190 })),
      now,
    });
    expect(decision.nextActor).toBe('Customer');
  });

  it('a non-token Graph error while in date stays Engineering', () => {
    const now = Date.now();
    const decision = decideMetaHandoff({
      reason: 'refresh_failed',
      userId: 'u1',
      account: { account_id: '1', account_name: 'A', config: { token_expires_at: now + 86400000 } as any },
      error: describeMetaRefreshError(axios400({ message: 'Please reduce the amount of data', type: 'GraphMethodException', code: 1 })),
      now,
    });
    expect(decision.nextActor).toBe('Engineering');
  });

  it('falls back to the plain message without a Graph body', () => {
    expect(describeMetaRefreshError(new Error('timeout of 15000ms exceeded'))).toBe('timeout of 15000ms exceeded');
    expect(describeMetaRefreshError('boom')).toBe('boom');
    const e: any = new Error('Request failed with status code 500');
    e.response = { status: 500, data: '<html>' };
    expect(describeMetaRefreshError(e)).toBe('Request failed with status code 500');
  });
});
