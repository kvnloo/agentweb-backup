/**
 * ENG-2840 (W2-8), the ENG-2988 rule for describe_image: an object of OUR bucket is read with the server's own credentials
 * (presigned), so describeImage first asks checkOurBucketKeyRead('describe_image', userId, key). 'refuse' and 'unavailable' answer
 * without presigning, downloading or calling the model; 'allow' proceeds as before. Non-bucket URLs and data: URIs are not checked.
 *
 * isS3Url / extractS3KeyFromUrl are the real URL parsing (only presignS3Url is stubbed); toolStorageAccess is real except
 * checkOurBucketKeyRead, so the refusal texts asserted below are the module's own.
 */
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  S3: jest.fn(() => ({ getSignedUrl: jest.fn(() => 'https://unused') })),
  SecretsManager: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));
jest.mock('../services/db', () => ({ userDb: {}, taskDb: {}, orgDb: {} }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/orgShareService', () => ({ canViewItem: jest.fn(), canEditItem: jest.fn() }));
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

jest.mock('../utils/s3Utils', () => ({
  ...jest.requireActual('../utils/s3Utils'),
  presignS3Url: jest.fn(),
}));

jest.mock('../emma/impl/toolStorageAccess', () => ({
  ...jest.requireActual('../emma/impl/toolStorageAccess'),
  checkOurBucketKeyRead: jest.fn(),
}));

const mockAxiosGet = jest.fn();
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const get = (...a: any[]) => mockAxiosGet(...a);
  return { __esModule: true, ...actual, get, default: Object.assign(actual.default.create(), { get }) };
});

const mockGuardedFetch = jest.fn();
jest.mock('../utils/ssrfGuard', () => ({
  ...jest.requireActual('../utils/ssrfGuard'),
  fetchBufferFollowingRedirects: (...a: any[]) => mockGuardedFetch(...a),
}));

import { describeImage } from '../emma/impl/mediaVideo';
import { presignS3Url } from '../utils/s3Utils';
import { checkOurBucketKeyRead } from '../emma/impl/toolStorageAccess';

const REFUSAL = 'File not found or you do not have access to it.';
const UNAVAILABLE = 'Could not check access to the file right now. Please try again in a moment.';

const BUCKET = process.env.AWS_S3_BUCKET || 'agentweb-user-files';
const KEY = 'users/u1/files/1700000000/logo.png';
const OUR_URLS: Array<[string, string]> = [
  ['virtual-hosted', `https://${BUCKET}.s3.amazonaws.com/${KEY}`],
  ['regional virtual-hosted', `https://${BUCKET}.s3.us-west-2.amazonaws.com/${KEY}`],
  ['path-style', `https://s3.us-west-2.amazonaws.com/${BUCKET}/${KEY}`],
];
const OUR_URL = OUR_URLS[1][1];

// A real 1x1 PNG, so the allow path's normalisation has real bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const mockCheck = checkOurBucketKeyRead as jest.Mock;
const mockPresign = presignS3Url as jest.Mock;
const callLLM = jest.fn();
const getVisionModel = jest.fn();

const CTX = { userId: 'u1', sessionId: 's1', feature: 'describe_image' };

function expectNothingRead() {
  expect(mockPresign).not.toHaveBeenCalled();
  expect(mockAxiosGet).not.toHaveBeenCalled();
  expect(mockGuardedFetch).not.toHaveBeenCalled();
  expect(callLLM).not.toHaveBeenCalled();
}

function sentImageUrl(): string {
  const messages = callLLM.mock.calls[0][1];
  return messages[1].content.find((b: any) => b.type === 'image_url').image_url.url;
}

beforeEach(() => {
  jest.resetAllMocks();
  callLLM.mockResolvedValue({ choices: [{ message: { content: 'A red square logo.' } }] });
  getVisionModel.mockResolvedValue('claude-vision-test');
  mockPresign.mockImplementation((u: string) => `${u}?X-Amz-Signature=presigned`);
  mockAxiosGet.mockResolvedValue({ data: PNG, headers: { 'content-type': 'image/png' } });
  mockGuardedFetch.mockResolvedValue({ buffer: PNG, contentType: 'image/png' });
});

describe('describeImage: an object of OUR bucket is checked before any read', () => {
  // undefined = the configured vision model (Emma's tool and the API default); the others cover the download models and a raw-URL one.
  const MODELS: Array<string | undefined> = [undefined, 'claude-sonnet-test', 'anthropic.claude-test', 'gemini-test', 'gpt-test'];

  it.each(MODELS)('refuse (model %p): the refusal message, no presign, no download, no model call', async (model) => {
    mockCheck.mockResolvedValueOnce('refuse');

    const result = await describeImage(model, OUR_URL, 'describe', CTX, callLLM, getVisionModel);

    expect(result).toMatchObject({ success: false, message: REFUSAL });
    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(mockCheck).toHaveBeenCalledWith('describe_image', 'u1', KEY);
    expectNothingRead();
  });

  it.each(MODELS)('unavailable (model %p): the "Could not check access" message, nothing read', async (model) => {
    mockCheck.mockResolvedValueOnce('unavailable');

    const result = await describeImage(model, OUR_URL, 'describe', CTX, callLLM, getVisionModel);

    expect(result).toMatchObject({ success: false, message: UNAVAILABLE });
    expect(result.message).toMatch(/^Could not check access/);
    expectNothingRead();
  });

  it.each(OUR_URLS)('every URL form of our bucket is checked (%s)', async (_label, url) => {
    mockCheck.mockResolvedValueOnce('refuse');

    const result = await describeImage('claude-sonnet-test', url, undefined, CTX, callLLM, getVisionModel);

    expect(result).toMatchObject({ success: false, message: REFUSAL });
    expect(mockCheck).toHaveBeenCalledWith('describe_image', 'u1', KEY);
    expectNothingRead();
  });

  it('allow (download model): checks first, then presigns, downloads and sends the image inline', async () => {
    mockCheck.mockResolvedValueOnce('allow');

    const result = await describeImage('claude-sonnet-test', OUR_URL, 'describe', CTX, callLLM, getVisionModel);

    expect(result).toMatchObject({ success: true, description: 'A red square logo.', model: 'claude-sonnet-test', imageUrl: OUR_URL });
    expect(mockCheck).toHaveBeenCalledWith('describe_image', 'u1', KEY);
    expect(mockPresign).toHaveBeenCalledWith(OUR_URL);
    expect(mockAxiosGet).toHaveBeenCalledWith(`${OUR_URL}?X-Amz-Signature=presigned`, expect.any(Object));
    expect(mockCheck.mock.invocationCallOrder[0]).toBeLessThan(mockPresign.mock.invocationCallOrder[0]);
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(sentImageUrl()).toMatch(/^data:image\/png;base64,/);
  });

  it('allow (no model given): the vision model runs, as before', async () => {
    mockCheck.mockResolvedValueOnce('allow');

    const result = await describeImage(undefined, OUR_URL, undefined, CTX, callLLM, getVisionModel);

    expect(getVisionModel).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, model: 'claude-vision-test' });
    expect(callLLM.mock.calls[0][0]).toBe('claude-vision-test');
  });

  it('allow (raw-URL model): the model gets the URL, as before', async () => {
    mockCheck.mockResolvedValueOnce('allow');

    const result = await describeImage('gpt-test', OUR_URL, undefined, CTX, callLLM, getVisionModel);

    expect(result.success).toBe(true);
    expect(sentImageUrl()).toBe(OUR_URL);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it.each([
    ['no usage context', undefined],
    ['a context without userId', { feature: 'describe_image' }],
    ['a blank userId', { userId: '   ', feature: 'describe_image' }],
  ])('a missing userId refuses (%s), nothing read', async (_label, usageContext) => {
    // The real decision for this case: no caller is never 'allow'.
    mockCheck.mockImplementationOnce((...a: any[]) =>
      jest.requireActual('../emma/impl/toolStorageAccess').checkOurBucketKeyRead(...a)
    );

    const result = await describeImage('claude-sonnet-test', OUR_URL, undefined, usageContext as any, callLLM, getVisionModel);

    expect(result).toMatchObject({ success: false, message: REFUSAL });
    expect(mockCheck).toHaveBeenCalledWith('describe_image', (usageContext as any)?.userId, KEY);
    expectNothingRead();
  });

  it('a check that throws is not a pass (the call fails, nothing is read)', async () => {
    mockCheck.mockRejectedValueOnce(new Error('policy blew up'));

    const result = await describeImage('claude-sonnet-test', OUR_URL, undefined, CTX, callLLM, getVisionModel);

    expect(result.success).toBe(false);
    expectNothingRead();
  });
});

describe('describeImage: URLs that are not our bucket are not checked (unchanged path)', () => {
  it('a public https image goes through the SSRF-guarded fetch, no check, no presign', async () => {
    const url = 'https://example.com/cover.png';

    const result = await describeImage('claude-sonnet-test', url, undefined, CTX, callLLM, getVisionModel);

    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockPresign).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledWith(url);
    expect(result.success).toBe(true);
  });

  it("another bucket's S3 URL is not ours: not checked, never presigned", async () => {
    const url = `https://someone-elses-bucket.s3.amazonaws.com/${KEY}`;

    const result = await describeImage('claude-sonnet-test', url, undefined, CTX, callLLM, getVisionModel);

    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockPresign).not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledWith(url);
    expect(result.success).toBe(true);
  });

  it('a data: URI is sent as it is: no check, no fetch', async () => {
    const dataUri = `data:image/png;base64,${PNG.toString('base64')}`;

    const result = await describeImage('claude-sonnet-test', dataUri, undefined, CTX, callLLM, getVisionModel);

    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockPresign).not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockGuardedFetch).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(sentImageUrl()).toBe(dataUri);
  });

  it('a data: URI with no userId still works (nothing of ours is read)', async () => {
    const dataUri = `data:image/png;base64,${PNG.toString('base64')}`;
    const result = await describeImage('gpt-test', dataUri, undefined, undefined, callLLM, getVisionModel);
    expect(mockCheck).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
