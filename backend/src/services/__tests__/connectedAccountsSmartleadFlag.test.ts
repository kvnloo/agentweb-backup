import { isTokenValid } from '../connectedAccountsDb';
import { NON_EXPIRING_TOKEN_TIMESTAMP } from '../../utils/tokenUtils';

jest.mock('../db', () => ({ userDb: {} }));
jest.mock('../metaPixelsCache', () => ({ invalidateCachedPixels: jest.fn() }));
jest.mock('../serverSignalEmitter', () => ({ emitAppSignal: jest.fn() }));

const account = (extra: Record<string, any> = {}) =>
  ({
    platform: 'smartlead',
    account_id: 'smartlead-u1',
    account_name: 'Smartlead',
    config: { account_type: 'api_key', access_token: 'x', token_expires_at: NON_EXPIRING_TOKEN_TIMESTAMP, mailbox_count: 3, ...extra },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }) as any;

describe('isTokenValid for a Smartlead key (ENG-673)', () => {
  it('is valid while the key has not been rejected', async () => {
    await expect(isTokenValid(account())).resolves.toBe(true);
  });

  it('is not valid once the key is flagged needs_reconnect, so Emma and Settings agree it is broken', async () => {
    await expect(isTokenValid(account({ needs_reconnect: true }))).resolves.toBe(false);
  });
});
