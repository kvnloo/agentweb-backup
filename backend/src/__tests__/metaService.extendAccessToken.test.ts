/**
 * Tests for metaService.extendAccessToken — the fb_exchange_token primitive
 * that re-exchanges a still-valid long-lived Meta token for a fresh one.
 */

jest.mock('facebook-nodejs-business-sdk', () => ({
  FacebookAdsApi: { init: jest.fn() },
  User: jest.fn(),
  AdAccount: jest.fn(),
  Campaign: jest.fn(),
  AdSet: jest.fn(),
  AdCreative: {},
  Ad: jest.fn(),
  CustomAudience: jest.fn(),
}));

jest.mock('axios');

jest.mock('../utils/secretsManager', () => ({
  getMetaCredentials: jest.fn().mockResolvedValue({ clientId: 'APP_ID', clientSecret: 'APP_SECRET' }),
}));

import axios from 'axios';
import { metaService } from '../services/metaService';
import { getMetaCredentials } from '../utils/secretsManager';

describe('metaService.extendAccessToken', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls fb_exchange_token with app credentials and the current token', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { access_token: 'FRESH', expires_in: 5184000 } });

    const result = await metaService.extendAccessToken('CURRENT');

    expect(getMetaCredentials).toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/oauth/access_token'),
      expect.objectContaining({
        params: expect.objectContaining({
          grant_type: 'fb_exchange_token',
          client_id: 'APP_ID',
          client_secret: 'APP_SECRET',
          fb_exchange_token: 'CURRENT',
        }),
      })
    );
    expect(result).toEqual({ access_token: 'FRESH', expires_in: 5184000 });
  });

  it('returns access_token with undefined expires_in when Meta omits it', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { access_token: 'FRESH' } });
    const result = await metaService.extendAccessToken('CURRENT');
    expect(result).toEqual({ access_token: 'FRESH', expires_in: undefined });
  });

  it('throws when the response has no access_token', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { error: { message: 'bad token' } } });
    await expect(metaService.extendAccessToken('CURRENT')).rejects.toThrow(/no access_token/i);
  });

  it('propagates an axios/network error (e.g. expired token)', async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error('Request failed with status code 400'));
    await expect(metaService.extendAccessToken('EXPIRED')).rejects.toThrow(/status code 400/);
  });
});
