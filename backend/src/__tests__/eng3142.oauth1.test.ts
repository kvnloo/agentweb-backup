/**
 * ENG-3142 — OAuth 1.0a HMAC-SHA1 signing for the X Ads API, pinned to X's own published
 * reference example ("Creating a signature", developer.x.com) so the util is checked against an
 * independent implementation, not against itself.
 */
import { buildOAuth1Header, hmacSha1Signature, percentEncode, signatureBaseString } from '../utils/oauth1';
import { xAccessToken, xAdsRequest, xAuthorizeUrl, XAdsApiError, xRequestToken } from '../services/xAdsClient';

const X_EXAMPLE = {
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
  consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
  token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
};
const URL_ = 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true';
const NONCE = 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg';
const TS = 1318622958;
const BODY = { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' };

const parseHeader = (h: string) => Object.fromEntries(
  h.replace(/^OAuth /, '').split(', ').map((kv) => {
    const [k, v] = kv.split('=');
    return [decodeURIComponent(k), decodeURIComponent(v.slice(1, -1))];
  }),
);

describe('ENG-3142 OAuth 1.0a signing', () => {
  it('percent-encodes per RFC 3986 (reserved !*\'() escaped, unreserved kept)', () => {
    expect(percentEncode("Ladies + Gentlemen!*'()")).toBe('Ladies%20%2B%20Gentlemen%21%2A%27%28%29');
    expect(percentEncode('a-b._~')).toBe('a-b._~');
    expect(percentEncode('☃')).toBe('%E2%98%83');
  });

  it('reproduces X\'s published signature for the reference request', () => {
    const header = buildOAuth1Header({ method: 'POST', url: URL_, credentials: X_EXAMPLE, bodyParams: BODY, nonce: NONCE, timestamp: TS });
    expect(parseHeader(header).oauth_signature).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });

  it('builds X\'s published signature base string (query + body + oauth params, sorted)', () => {
    const base = signatureBaseString('post', URL_, {
      ...BODY,
      oauth_consumer_key: X_EXAMPLE.consumerKey,
      oauth_nonce: NONCE,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: String(TS),
      oauth_token: X_EXAMPLE.token,
      oauth_version: '1.0',
    });
    expect(base.startsWith('POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key')).toBe(true);
    expect(base).toContain('status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521');
  });

  it('a different secret, nonce or param changes the signature', () => {
    const sign = (over: any = {}) => parseHeader(buildOAuth1Header({ method: 'GET', url: 'https://ads-api.x.com/12/accounts', credentials: X_EXAMPLE, nonce: NONCE, timestamp: TS, ...over })).oauth_signature;
    const base = sign();
    expect(sign({ credentials: { ...X_EXAMPLE, tokenSecret: 'other' } })).not.toBe(base);
    expect(sign({ nonce: 'n2' })).not.toBe(base);
    expect(sign({ url: 'https://ads-api.x.com/12/accounts?count=5' })).not.toBe(base);
  });

  it('request_token signs without a token and includes oauth_callback; header has no token', () => {
    const header = parseHeader(buildOAuth1Header({ method: 'POST', url: 'https://api.x.com/oauth/request_token', credentials: { consumerKey: 'ck', consumerSecret: 'cs' }, extraOAuthParams: { oauth_callback: 'https://api.agentweb.pro/api/oauth/x-ads/callback' } }));
    expect(header.oauth_token).toBeUndefined();
    expect(header.oauth_callback).toBe('https://api.agentweb.pro/api/oauth/x-ads/callback');
    const { oauth_signature: signature, ...signed } = header;
    expect(signature).toBe(hmacSha1Signature(signatureBaseString('POST', 'https://api.x.com/oauth/request_token', signed), 'cs'));
  });
});

describe('ENG-3142 X Ads client', () => {
  const app = { consumerKey: 'ck', consumerSecret: 'cs' };
  const res = (status: number, text: string) => ({ status, text: async () => text });

  it('3-legged flow: request token (callback confirmed) → authorize URL → access token', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(res(200, 'oauth_token=rt&oauth_token_secret=rts&oauth_callback_confirmed=true'))
      .mockResolvedValueOnce(res(200, 'oauth_token=at&oauth_token_secret=ats&user_id=42&screen_name=acme'));
    const rt = await xRequestToken(app, 'https://cb', fetchImpl);
    expect(rt).toEqual({ token: 'rt', tokenSecret: 'rts' });
    expect(xAuthorizeUrl('rt')).toBe('https://api.x.com/oauth/authorize?oauth_token=rt');
    const at = await xAccessToken(app, rt, 'ver', fetchImpl);
    expect(at).toEqual({ token: 'at', tokenSecret: 'ats', userId: '42', screenName: 'acme' });
    const accessHeader = parseHeader(fetchImpl.mock.calls[1][1].headers.Authorization);
    expect(accessHeader).toMatchObject({ oauth_token: 'rt', oauth_verifier: 'ver' });
  });

  it('an unconfirmed callback is refused (callback URL not registered on the app)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(200, 'oauth_token=rt&oauth_token_secret=rts&oauth_callback_confirmed=false'));
    await expect(xRequestToken(app, 'https://cb', fetchImpl)).rejects.toThrow(/callback URL/);
  });

  it('xAdsRequest signs the query, sends JSON unsigned, and maps X errors (status + code)', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(res(200, '{"data":{"id":"c1"}}'))
      .mockResolvedValueOnce(res(400, '{"errors":[{"code":"INVALID_PARAMETER","message":"bad budget"}]}'))
      .mockRejectedValueOnce(new Error('socket hang up'));
    const credentials = { ...app, token: 't', tokenSecret: 'ts' };
    await expect(xAdsRequest({ method: 'POST', path: '/batch/x', query: { a: 'b' }, json: [{ x: 1 }], credentials, fetchImpl })).resolves.toEqual({ data: { id: 'c1' } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ads-api.x.com/12/batch/x?a=b');
    expect(init.body).toBe('[{"x":1}]');
    expect(init.headers.Authorization).toMatch(/^OAuth .*oauth_signature="/);
    await expect(xAdsRequest({ path: '/y', credentials, fetchImpl })).rejects.toMatchObject({ status: 400, code: 'INVALID_PARAMETER' });
    const lost = await xAdsRequest({ path: '/z', credentials, fetchImpl }).catch((e) => e);
    expect(lost).toBeInstanceOf(XAdsApiError);
    expect(lost.status).toBe(0);
  });
});
