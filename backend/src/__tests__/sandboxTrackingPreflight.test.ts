import { detectMetaPixels } from '../services/metaTrackingPreflight';

/**
 * ENG-1909: `buildSandboxFetchHtml` answers the launch gate's destination check from the
 * sandbox account's own frozen dataset instead of a real outbound fetch. The synthetic HTML
 * it returns must be readable by the REAL `detectMetaPixels` — this test exercises the two
 * together rather than asserting on the HTML string's shape, so a change to either side that
 * breaks the other is caught here rather than by two suites separately agreeing on nothing.
 */
const requireActiveEvaluation = jest.fn();
jest.mock('../services/evaluationPolicy', () => ({
  ...jest.requireActual('../services/evaluationPolicy'),
  requireActiveEvaluation: (...args: unknown[]) => requireActiveEvaluation(...args),
}));

const loadDataset = jest.fn();
jest.mock('../services/sandbox/sandboxDatasetStore', () => ({
  getSandboxDatasetStore: () => ({ loadDataset }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildSandboxFetchHtml } = require('../services/sandboxTrackingPreflight');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EvaluationDenied } = require('../services/evaluationPolicy');

const REAL_USER = 'user-123';
const SANDBOX_USER = 'eval_test-user';

beforeEach(() => { jest.clearAllMocks(); });

describe('buildSandboxFetchHtml', () => {
  it('returns undefined for a real (non-sandbox) userId, without ever touching the evaluation store', async () => {
    const fetchHtml = await buildSandboxFetchHtml(REAL_USER);
    expect(fetchHtml).toBeUndefined();
    expect(requireActiveEvaluation).not.toHaveBeenCalled();
  });

  it('a denied/expired/unknown sandbox policy blocks (no-pixel synthetic HTML), never falls back to a real fetch', async () => {
    requireActiveEvaluation.mockRejectedValue(new EvaluationDenied());
    const fetchHtml = await buildSandboxFetchHtml(SANDBOX_USER);
    expect(fetchHtml).toBeDefined();
    expect(detectMetaPixels(await fetchHtml!('https://landing.example.invalid/anything'))).toEqual([]);
  });

  it('an active record with no dataset pinned (legacy row) blocks, never falls back to a real fetch', async () => {
    requireActiveEvaluation.mockResolvedValue({ userId: SANDBOX_USER, status: 'active', datasetId: null, datasetVersion: null });
    const fetchHtml = await buildSandboxFetchHtml(SANDBOX_USER);
    expect(fetchHtml).toBeDefined();
    expect(detectMetaPixels(await fetchHtml!('https://landing.example.invalid/anything'))).toEqual([]);
  });

  it('a declared lander with a real pixel id is detected exactly like a genuine install', async () => {
    requireActiveEvaluation.mockResolvedValue({ userId: SANDBOX_USER, status: 'active', datasetId: 'agentweb-2026q2', datasetVersion: 1 });
    loadDataset.mockResolvedValue({ landers: [{ url: 'https://landing.example.invalid/demo', pixelIds: ['1207000000000001'] }] });
    const fetchHtml = await buildSandboxFetchHtml(SANDBOX_USER);
    expect(fetchHtml).toBeDefined();
    const html = await fetchHtml!('https://landing.example.invalid/demo');
    expect(detectMetaPixels(html)).toEqual(['PIXEL:1207000000000001']);
  });

  it('an undeclared destination gets HTML with no pixel — the gate must still block it', async () => {
    requireActiveEvaluation.mockResolvedValue({ userId: SANDBOX_USER, status: 'active', datasetId: 'agentweb-2026q2', datasetVersion: 1 });
    loadDataset.mockResolvedValue({ landers: [{ url: 'https://landing.example.invalid/demo', pixelIds: ['1207000000000001'] }] });
    const fetchHtml = await buildSandboxFetchHtml(SANDBOX_USER);
    const html = await fetchHtml!('https://landing.example.invalid/unmeasured');
    expect(detectMetaPixels(html)).toEqual([]);
  });

  it('never makes this an "always pass" — a lander declared with zero pixel ids also detects nothing', async () => {
    requireActiveEvaluation.mockResolvedValue({ userId: SANDBOX_USER, status: 'active', datasetId: 'agentweb-2026q2', datasetVersion: 1 });
    loadDataset.mockResolvedValue({ landers: [{ url: 'https://landing.example.invalid/bare', pixelIds: [] }] });
    const fetchHtml = await buildSandboxFetchHtml(SANDBOX_USER);
    const html = await fetchHtml!('https://landing.example.invalid/bare');
    expect(detectMetaPixels(html)).toEqual([]);
  });

  it('blocks (no-pixel synthetic HTML), never throws and never falls back to a real fetch, when the dataset fails to load', async () => {
    requireActiveEvaluation.mockResolvedValue({ userId: SANDBOX_USER, status: 'active', datasetId: 'agentweb-2026q2', datasetVersion: 1 });
    loadDataset.mockRejectedValue(new Error('dataset not found'));
    const fetchHtml = await buildSandboxFetchHtml(SANDBOX_USER);
    expect(fetchHtml).toBeDefined();
    expect(detectMetaPixels(await fetchHtml!('https://landing.example.invalid/anything'))).toEqual([]);
  });
});
