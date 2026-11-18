/**
 * ENG-1889 — perform_data_analysis generic runtime-error cluster. All data
 * sources are mocked (no customer data); fixtures are synthetic.
 */
import axios from 'axios';
import { getSecret } from '../utils/secretsManager';
import { getS3ObjectAsString } from '../utils/s3Utils';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { toolResultError } from '../utils/toolResultError';
import { classifyToolFailureType } from '../utils/toolFailureType';

// The download goes through utils/callerUrlFetch (guarded, covered in callerUrlFetch.test.ts); here it is handed to the axios mock below.
jest.mock('../utils/callerUrlFetch', () => require('./helpers/callerUrlFetchAxiosBridge').callerUrlFetchViaAxiosMock());
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({ success: true, url: 'https://example.com/u.png' }),
  getS3ObjectAsString: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn() }));
// Who may read which S3 key (ENG-2988 rule) is a boundary here, covered with the real policy in performDataAnalysis.storageAccess.test.ts.
// Without it the real policy would look the session up in the database, the file would never be read, and the empty-file test below
// (which needs the read to happen and come back empty) would fail on a refusal instead of testing what it claims.
jest.mock('../services/storageAccessPolicy', () => ({
  ...jest.requireActual('../services/storageAccessPolicy'),
  decideStorageAccess: jest.fn().mockResolvedValue({ allow: true }),
}));

import {
  performDataAnalysis,
  classifyDataAnalysisFailure,
  __resetDataAnalysisConsistencyCacheForTests,
} from '../emma/impl/searchResearch';

const get = axios.get as jest.Mock;
const post = axios.post as jest.Mock;
const secret = getSecret as jest.Mock;
const s3 = getS3ObjectAsString as jest.Mock;

/** What the run recorder would cluster this result as. */
const telemetryClass = (r: any) => classifyToolErrorClass(toolResultError(r));

describe('ENG-1889 perform_data_analysis structured failures', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    secret.mockResolvedValue('test-key');
    __resetDataAnalysisConsistencyCacheForTests();
  });

  it('empty dataset (empty tool-response file) -> structured not_found, not Error', async () => {
    s3.mockResolvedValueOnce('');
    const r = await performDataAnalysis(['tool-responses/123e4567-e89b-12d3-a456-426614174000/data.csv'], 'sum clicks', 'u1');
    expect(r.success).toBe(false);
    expect(r.errorClass).toBe('not_found');
    expect(telemetryClass(r)).toBe('not_found');
  });

  it('unfetchable file URL (network error) -> not_found with the URL named', async () => {
    get.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND example.com'));
    const r = await performDataAnalysis(['https://example.com/x.csv'], 'sum clicks', 'u1');
    expect(r.errorClass).toBe('not_found');
    expect(r.message).toContain('https://example.com/x.csv');
    expect(telemetryClass(r)).toBe('not_found');
  });

  // ENG-2993: a dead/expired caller URL (HTTP 4xx) is a bad argument, not an
  // account/config fault — it filed a phantom "resolve the account" cluster.
  it.each([
    ['axios response 404', Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } })],
    ['message-only 404', new Error('Request failed with status code 404')],
    ['presigned 403', Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } })],
  ])('dead file URL (%s) -> invalid_args, never config', async (_label, err) => {
    get.mockRejectedValueOnce(err);
    const r = await performDataAnalysis(['https://example.com/gone.csv'], 'sum clicks', 'u1');
    expect(r.success).toBe(false);
    expect(r.errorClass).toBe('invalid_args');
    expect(r.message).toContain('https://example.com/gone.csv');
    expect(r.message).toMatch(/re-run the tool that produced the data/);
    expect(telemetryClass(r)).toBe('invalid_args');
    expect(classifyToolFailureType(telemetryClass(r), r.message)).not.toBe('config');
  });

  it('rate-limited file host (429) is not reclassified as a bad argument', async () => {
    get.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } }));
    const r = await performDataAnalysis(['https://example.com/x.csv'], 'sum clicks', 'u1');
    expect(r.errorClass).not.toBe('invalid_args');
  });

  it('upstream execution failure (Gemini 500) -> upstream_5xx with actionable message', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('boom from sandbox'), { response: { status: 500 } }));
    const r = await performDataAnalysis([], 'compute the mean of 1,2,3', 'u1');
    expect(r.success).toBe(false);
    expect(r.errorClass).toBe('upstream_5xx');
    expect(r.message).toMatch(/retry once/i);
    expect(telemetryClass(r)).toBe('upstream_5xx');
  });

  it('unsupported/invalid request (Gemini 400) -> invalid_args', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('bad request'), { response: { status: 400 } }));
    const r = await performDataAnalysis([], 'do an unsupported analysis', 'u1');
    expect(r.errorClass).toBe('invalid_args');
    expect(telemetryClass(r)).toBe('invalid_args');
  });

  it('timeout -> timeout', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }));
    const r = await performDataAnalysis([], 'mean of 1,2,3', 'u1');
    expect(r.errorClass).toBe('timeout');
  });

  it('missing Gemini key -> tool_unavailable', async () => {
    secret.mockRejectedValueOnce(new Error('nope'));
    const r = await performDataAnalysis([], 'mean of 1,2,3', 'u1');
    expect(r.errorClass).toBe('tool_unavailable');
  });

  it('argument types follow the declared schema: non-array file_urls / non-string instruction -> invalid_args', async () => {
    const a = await performDataAnalysis('https://x/y.csv' as any, 'sum', 'u1');
    expect(a).toEqual(expect.objectContaining({ success: false, errorClass: 'invalid_args' }));
    const b = await performDataAnalysis([], { task: 'sum' } as any, 'u1');
    expect(b).toEqual(expect.objectContaining({ success: false, errorClass: 'invalid_args' }));
    const c = await performDataAnalysis([null] as any, 'sum', 'u1');
    expect(c).toEqual(expect.objectContaining({ success: false, errorClass: 'invalid_args' }));
    // No stricter handler-only constraints: an empty array is schema-valid.
    expect(get).not.toHaveBeenCalled();
  });

  it('every pre-existing failure message maps to a known class (never generic)', () => {
    expect(classifyDataAnalysisFailure({ message: 'Analysis instruction is required' })).toBe('invalid_args');
    expect(classifyDataAnalysisFailure({ message: 'Total file size (9 bytes) exceeds the 1 bytes limit.' })).toBe('invalid_args');
    expect(classifyDataAnalysisFailure({ message: 'The data analysis did not return any results — x' })).toBe('empty_result');
    expect(classifyDataAnalysisFailure({ message: 'x', error: 'execution_failed' })).toBe('invalid_output');
    expect(classifyDataAnalysisFailure({ message: 'something unexpected' })).toBe('upstream_5xx');
    expect(classifyDataAnalysisFailure({ message: 'Gemini API key is empty' })).toBe('tool_unavailable');
    expect(classifyDataAnalysisFailure({ message: 'x', error: 'inconsistent_result' })).toBe('invalid_output');
  });

  it('control: a valid analysis keeps its existing success shape with no errorClass', async () => {
    post.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'The mean is 2.' }] } }] },
    });
    const r = await performDataAnalysis([], 'compute the mean of 1,2,3', 'u1');
    expect(r).toEqual(expect.objectContaining({ success: true, message: 'Data analysis completed successfully' }));
    expect(r.errorClass).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(['analysis', 'codeExecuted', 'fileUrls', 'formattedContent', 'message', 'success'].sort());
  });
});
