/** ENG-3026: the Artificial Analysis read moved endpoints (legacy path is HTTP 410) and misreported failures. */
import { detectFrontier, readArtificialAnalysis, withoutAaKeyAbsent } from '../frontierMonitor';
import { AA_MODELS_URL, fetchArtificialAnalysisModels, refreshModelCatalog, refreshScores } from '../modelCatalogRefresh';
import { classifyReport, evaluateAutoMerge } from '../catalogReview';
import { LLMModelConfig } from '../llmModelRegistry';
import documented from './fixtures/artificialAnalysisLanguageModelsFree.json';

const config: LLMModelConfig = { client: null, supportsTemperature: true, provider: 'zai' };
const registry = { 'openrouter/z-ai/glm-5.3': config };
const now = Date.parse('2026-11-15T00:00:00Z');
const catalog = { data: [{ id: 'z-ai/glm-5.3', created: now / 1000 - 86400 * 30,
  pricing: { prompt: '0.0000014', completion: '0.0000044' },
  supported_parameters: ['tools', 'temperature'], architecture: { output_modalities: ['text'] } }] };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const KEY_ABSENT = /ARTIFICIAL_ANALYSIS_API_KEY/;

describe('Artificial Analysis read (ENG-3026)', () => {
  it('AC1: requests the documented replacement path, never the retired /api/v2/data path', async () => {
    const request = jest.fn(async () => json({ data: [], pagination: { has_more: false } }));
    await fetchArtificialAnalysisModels('k', request as unknown as typeof fetch);
    expect(AA_MODELS_URL).toBe('https://artificialanalysis.ai/api/v2/language/models/free');
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${AA_MODELS_URL}?page=1`);
    expect(url).not.toContain('/api/v2/data/');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  it('AC2: reads every page of the paginated response into one payload', async () => {
    const second = { ...documented, pagination: { ...documented.pagination, page: 2, has_more: false },
      data: [{ ...documented.data[0], slug: 'glm-5-3-mini', name: 'GLM-5.3 Mini' }] };
    const request = jest.fn(async (url: string) => json(url.endsWith('page=1') ? documented : second));
    const payload = await fetchArtificialAnalysisModels('k', request as unknown as typeof fetch);
    expect(request).toHaveBeenCalledTimes(2);
    expect(payload.data.map(r => (r as { slug: string }).slug)).toEqual(['glm-5-3', 'glm-5-3-mini']);
  });

  it('AC2: fails instead of returning a partial list when pages never end or a page is malformed', async () => {
    const endless = jest.fn(async () => json(documented));
    await expect(fetchArtificialAnalysisModels('k', endless as unknown as typeof fetch)).rejects.toThrow(/pages/);
    const malformed = jest.fn(async () => json({ tier: 'free' }));
    await expect(fetchArtificialAnalysisModels('k', malformed as unknown as typeof fetch)).rejects.toThrow();
    // A page with rows but no pagination block is not proof the list ended.
    const noPagination = jest.fn(async () => json({ data: documented.data }));
    await expect(fetchArtificialAnalysisModels('k', noPagination as unknown as typeof fetch)).rejects.toThrow(/has_more/);
  });

  it('flags, as a review warning, a feed whose index major version differs from labelled registry scores', async () => {
    const last = { ...documented, pagination: { ...documented.pagination, has_more: false } };
    const payload = await fetchArtificialAnalysisModels('k', (async () => json(last)) as unknown as typeof fetch);
    expect(payload.intelligence_index_version).toBe(5);
    const v4 = { ...registry, 'openrouter/x-ai/grok-4.6': { ...config, provider: 'xai' as const,
      qualityScore: 45, qualityScoreSource: 'Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Grok 4.6, high' } };
    const line = refreshScores(v4, payload, '2026-11-15').reports.find(r => r.includes('AA INDEX VERSION'));
    expect(line).toContain('v5');
    expect(line).toContain('openrouter/x-ai/grok-4.6');
    expect(classifyReport(line!)).toBe('warning');
    const v5 = { ...registry, 'openrouter/x-ai/grok-4.6': { ...config, provider: 'xai' as const,
      qualityScoreSource: 'Artificial Analysis Intelligence Index v5.0, snapshot 2026-11-15, Grok 4.6' } };
    expect(refreshScores(v5, payload, '2026-11-15').reports.some(r => r.includes('AA INDEX VERSION'))).toBe(false);
    expect(refreshScores(v4, { data: documented.data }, '2026-11-15').reports.some(r => r.includes('AA INDEX VERSION'))).toBe(false);
  });

  it('AC2: scores a model from the documented row shape, where model_creator has a name but no slug', () => {
    const { changes, reports } = refreshScores(registry, { data: documented.data }, '2026-11-15');
    expect(changes['openrouter/z-ai/glm-5.3'].qualityScore).toBe(31.7);
    expect(reports).toEqual([]);
    // The retired shape (creator slug) still parses, so recorded payloads keep working.
    const legacy = { data: [{ slug: 'glm-5-3', model_creator: { slug: 'z-ai' }, evaluations: { artificial_analysis_intelligence_index: 40 } }] };
    expect(refreshScores(registry, legacy, '2026-11-15').changes['openrouter/z-ai/glm-5.3'].qualityScore).toBe(40);
  });

  it('AC2: a row with a null or nameless creator is skipped, not matched', () => {
    const rows = [{ ...documented.data[0], model_creator: null }, { ...documented.data[0], model_creator: { id: 'x' } }];
    expect(refreshScores(registry, { data: rows }, '2026-11-15').changes).toEqual({});
    expect(detectFrontier(catalog, { data: rows }, registry, now).additions).toEqual([]);
  });

  it('AC3: a failed fetch with the key present reports the HTTP failure only', async () => {
    const request = jest.fn(async () => json({ error: 'Gone' }, 410));
    const { aa, error } = await readArtificialAnalysis('k', request as unknown as typeof fetch);
    expect(aa).toBeUndefined();
    expect(error).toBe('Artificial Analysis failed: artificialanalysis.ai: HTTP 410');
    const detection = [...withoutAaKeyAbsent(detectFrontier(catalog, aa, registry, now).reports), error];
    const plan = withoutAaKeyAbsent((await refreshModelCatalog({ catalog, aa, aaApiKey: '', registry, additionIds: [] })).reports);
    expect(detection).toEqual([error]);
    expect([...detection, ...plan].some(line => KEY_ABSENT.test(line))).toBe(false);
    expect(classifyReport(error)).toBe('warning');
  });

  it('AC3: with the key absent no request is made and the "not set" line is reported', async () => {
    const request = jest.fn();
    const { aa, error } = await readArtificialAnalysis(undefined, request as unknown as typeof fetch);
    expect(request).not.toHaveBeenCalled();
    expect(error).toBe('');
    expect(detectFrontier(catalog, aa, registry, now).reports)
      .toEqual(['Artificial Analysis unavailable: ARTIFICIAL_ANALYSIS_API_KEY not set; top-N detection skipped.']);
  });

  it('AC4: a failed read is a non-empty error and a degraded observation blocks auto-merge', async () => {
    const { error } = await readArtificialAnalysis('k', (async () => { throw new Error('network down'); }) as unknown as typeof fetch);
    expect(error).toBe('Artificial Analysis failed: network down');
    const verdict = evaluateAutoMerge({ additions: [], reports: [], smoke: {}, existingChanges: { changed: 0, blockers: [] } as never, observationDegraded: !!error });
    expect(verdict.eligible).toBe(false);
  });
});

describe('Artificial Analysis first-page capture (ENG-3029)', () => {
  const fs = jest.requireActual('fs') as typeof import('fs');
  const os = jest.requireActual('os') as typeof import('os');
  const pathLib = jest.requireActual('path') as typeof import('path');
  const KEY = 'aa_test_key_0123456789';
  let dir: string;
  let file: string;
  const first = { ...documented, pagination: { ...documented.pagination, has_more: true } };
  const last = { ...documented, pagination: { ...documented.pagination, page: 2, has_more: false },
    data: [{ ...documented.data[0], slug: 'second-page-only' }] };
  const twoPages = () => jest.fn(async (url: string) => json(url.endsWith('page=1') ? first : last));

  beforeEach(() => {
    dir = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'aa-capture-'));
    file = pathLib.join(dir, 'first-page.json');
  });
  afterEach(() => {
    delete process.env.AA_FIRST_PAGE_CAPTURE_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('writes nothing unless the capture path is set', async () => {
    await fetchArtificialAnalysisModels(KEY, twoPages() as unknown as typeof fetch);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes the first page body only: no later page, no header name, no key', async () => {
    process.env.AA_FIRST_PAGE_CAPTURE_PATH = file;
    const payload = await fetchArtificialAnalysisModels(KEY, twoPages() as unknown as typeof fetch);
    expect(payload.data).toHaveLength(2);
    const text = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toEqual(first);
    expect(text).not.toContain('second-page-only');
    expect(text).not.toContain(KEY);
    expect(text.toLowerCase()).not.toContain('x-api-key');
  });

  it('does not write a body that echoes the key, and still returns the models', async () => {
    process.env.AA_FIRST_PAGE_CAPTURE_PATH = file;
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const echo = { ...documented, pagination: { ...documented.pagination, has_more: false }, debug: { key: KEY } };
    const payload = await fetchArtificialAnalysisModels(KEY, (async () => json(echo)) as unknown as typeof fetch);
    expect(payload.data).toHaveLength(documented.data.length);
    expect(fs.existsSync(file)).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('first page not captured'));
    expect(stderr.mock.calls.flat().join(' ')).not.toContain(KEY);
  });

  it('an unwritable capture path does not fail the read', async () => {
    process.env.AA_FIRST_PAGE_CAPTURE_PATH = pathLib.join(dir, 'missing-dir', 'first-page.json');
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const payload = await fetchArtificialAnalysisModels(KEY, twoPages() as unknown as typeof fetch);
    expect(payload.data).toHaveLength(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('first page not captured'));
  });
});
