// ENG-2184: every enrichment LLM call — including the web-search tier and the
// critic, which #3067 left on a hard-coded gpt-5-chat-2 — resolves through the
// caller's enrichment role, so one run uses one model and an org override covers
// the whole pipeline. The CRM_ENRICH_V3_* env overrides keep their precedence.
// Role resolution itself (org override, then default) is covered in modelRoles.test.ts.
import type { LeadRecord } from '../services/crmEnrichmentService';
import { buildIdentityDeps, buildOrchestratorDeps, extractFieldsViaLLMReal } from '../services/enrichmentV3RealDeps';
import { resolveModelForUser } from '../services/modelRoles';
import { createLLMService } from '../utils/llmService';

jest.mock('../services/modelRoles');
jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn() }));

const ROLE_MODEL = 'org-enrichment-model';
const BASE = { requireContent: true };
const NO_AZURE = { requireContent: true, providerIgnoreForWebSearch: ['Azure'] };
const LUNA = 'openrouter/openai/gpt-5.6-luna';
const ENV_KEYS = ['CRM_ENRICH_V3_EXTRACT_MODEL', 'CRM_ENRICH_V3_CRITIC_MODEL', 'CRM_ENRICH_V3_WEB_SEARCH_MODEL', 'CRM_ENRICH_V3_WEB_SEARCH_PARAMS'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

const lead = { leadId: 'l1', email: 'a@acme.com', company: 'Acme' } as LeadRecord;
const webExtractInput = {
  tier: 'web' as const,
  sourceContext: '',
  fields: ['funding_stage'],
  groupName: 'company_firmographic',
  lead,
  configFieldsByName: { funding_stage: {} },
};
const criticInput = {
  lead,
  fills: [{
    field: 'funding_stage',
    value: 'Seed',
    meta: {
      source: 'web_search' as const,
      provider: 'llm_web_search',
      enrichedAt: '2026-01-01T00:00:00Z',
      sourceUrl: 'https://x',
      sourceQuote: 'raised a seed round',
    },
  }],
};
const domainInput = { company: 'Acme', domain: 'acme.com' };

type Deps = {
  buildIdentityDeps: typeof buildIdentityDeps;
  buildOrchestratorDeps: typeof buildOrchestratorDeps;
  extractFieldsViaLLMReal: typeof extractFieldsViaLLMReal;
  createLLMService: typeof createLLMService;
  resolveModelForUser: typeof resolveModelForUser;
};

function stubLLM(create: typeof createLLMService): void {
  jest.mocked(create).mockReturnValue({
    generateJSONContent: jest.fn().mockResolvedValue({ funding_stage: 'supported' }),
    generateJSONContentWithWebSearch: jest.fn().mockResolvedValue({ website: 'https://acme.com', company: 'Acme' }),
  } as unknown as ReturnType<typeof createLLMService>);
}

// Env overrides were read once at module load before ENG-2184, so load a fresh
// copy after setting them; the precedence assertions hold on both versions.
async function loadWithEnv(env: Partial<Record<typeof ENV_KEYS[number], string>>): Promise<Deps> {
  Object.assign(process.env, env);
  let deps: Deps | undefined;
  await jest.isolateModulesAsync(async () => {
    const service = await import('../services/enrichmentV3RealDeps');
    const llm = await import('../utils/llmService');
    const roles = await import('../services/modelRoles');
    deps = { ...service, createLLMService: llm.createLLMService, resolveModelForUser: roles.resolveModelForUser };
  });
  if (!deps) throw new Error('module did not load');
  stubLLM(deps.createLLMService);
  jest.mocked(deps.resolveModelForUser).mockResolvedValue(ROLE_MODEL);
  return deps;
}

beforeEach(() => {
  jest.clearAllMocks();
  stubLLM(createLLMService);
  jest.mocked(resolveModelForUser).mockResolvedValue(ROLE_MODEL);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('CRM_ENRICH_V3_WEB_SEARCH_PARAMS reaches the enrichment LLM calls (ENG-2720)', () => {
  it('passes the parsed parameters as webSearchParameters on web-tier and identity calls', async () => {
    const deps = await loadWithEnv({ CRM_ENRICH_V3_WEB_SEARCH_PARAMS: '{"engine":"parallel","max_results":3,"bogus":1}' });
    await deps.extractFieldsViaLLMReal(webExtractInput, 'user-1');
    expect(deps.createLLMService).toHaveBeenLastCalledWith(ROLE_MODEL, 0.0, undefined, {
      ...BASE, webSearchParameters: { engine: 'parallel', max_results: 3 },
    });
    await deps.buildIdentityDeps('user-1').resolveCompanyDomainViaWebSearch(domainInput);
    expect(deps.createLLMService).toHaveBeenLastCalledWith(ROLE_MODEL, 0.2, undefined, {
      ...BASE, webSearchParameters: { engine: 'parallel', max_results: 3 },
    });
  });

  it('sends no webSearchParameters when the variable is unset or invalid (default unchanged)', async () => {
    delete process.env.CRM_ENRICH_V3_WEB_SEARCH_PARAMS;
    const unset = await loadWithEnv({});
    await unset.extractFieldsViaLLMReal(webExtractInput, 'user-1');
    expect(unset.createLLMService).toHaveBeenLastCalledWith(ROLE_MODEL, 0.0, undefined, BASE);

    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = await loadWithEnv({ CRM_ENRICH_V3_WEB_SEARCH_PARAMS: '{not json' });
    await bad.extractFieldsViaLLMReal(webExtractInput, 'user-1');
    expect(bad.createLLMService).toHaveBeenLastCalledWith(ROLE_MODEL, 0.0, undefined, BASE);
  });
});

describe('enrichment web tier and critic follow the enrichment role (ENG-2184)', () => {
  it('web-tier field extraction uses the role model for the caller', async () => {
    await extractFieldsViaLLMReal(webExtractInput, 'user-1');
    expect(resolveModelForUser).toHaveBeenCalledWith('user-1', 'enrichment');
    expect(createLLMService).toHaveBeenCalledWith(ROLE_MODEL, 0.0, undefined, BASE);
  });

  it('web-search company domain resolution uses the role model for the caller', async () => {
    await buildIdentityDeps('user-1').resolveCompanyDomainViaWebSearch(domainInput);
    expect(resolveModelForUser).toHaveBeenCalledWith('user-1', 'enrichment');
    expect(createLLMService).toHaveBeenCalledWith(ROLE_MODEL, 0.2, undefined, BASE);
  });

  it('the critic uses the role model for the caller', async () => {
    const result = await buildOrchestratorDeps('user-1').runCriticOverWebFills(criticInput);
    expect(result.verdicts).toEqual({ funding_stage: 'supported' });
    expect(resolveModelForUser).toHaveBeenCalledWith('user-1', 'enrichment');
    expect(createLLMService).toHaveBeenCalledWith(ROLE_MODEL, null, undefined, BASE);
  });

  it('only the default Luna model gets the gpt-5.5 fallback; other models do not (ENG-2720)', async () => {
    jest.mocked(resolveModelForUser).mockResolvedValue(LUNA);
    await extractFieldsViaLLMReal(webExtractInput, 'user-1');
    expect(createLLMService).toHaveBeenLastCalledWith(LUNA, 0.0, undefined, { ...NO_AZURE, fallbackModels: ['gpt-5.5'] });
    jest.mocked(resolveModelForUser).mockResolvedValue('gemini-3.8-flash');
    await extractFieldsViaLLMReal(webExtractInput, 'user-1');
    expect(createLLMService).toHaveBeenLastCalledWith('gemini-3.8-flash', 0.0, undefined, BASE);
  });

  it('skips Azure for OpenAI models only, and does not give gpt-5.5 a fallback to itself (ENG-2720)', async () => {
    jest.mocked(resolveModelForUser).mockResolvedValue('gpt-5.5');
    await extractFieldsViaLLMReal(webExtractInput, 'user-1');
    expect(createLLMService).toHaveBeenLastCalledWith('gpt-5.5', 0.0, undefined, NO_AZURE);
    jest.mocked(resolveModelForUser).mockResolvedValue('openrouter/deepseek/deepseek-v4-flash');
    await extractFieldsViaLLMReal(webExtractInput, 'user-1');
    expect(createLLMService).toHaveBeenLastCalledWith('openrouter/deepseek/deepseek-v4-flash', 0.0, undefined, BASE);
  });

  it('keeps the critic on the same model as the extraction role', async () => {
    jest.mocked(resolveModelForUser).mockResolvedValue(LUNA);
    await buildOrchestratorDeps('user-1').runCriticOverWebFills(criticInput);
    expect(createLLMService).toHaveBeenLastCalledWith(LUNA, null, undefined, { ...NO_AZURE, fallbackModels: ['gpt-5.5'] });
  });

  it('never calls an LLM with the retired gpt-5-chat-2 id', async () => {
    await extractFieldsViaLLMReal(webExtractInput, 'user-1');
    await buildIdentityDeps('user-1').resolveCompanyDomainViaWebSearch(domainInput);
    await buildOrchestratorDeps('user-1').runCriticOverWebFills(criticInput);
    expect(createLLMService).toHaveBeenCalledTimes(3);
    expect(jest.mocked(createLLMService).mock.calls.map(([model]) => model)).toEqual([ROLE_MODEL, ROLE_MODEL, ROLE_MODEL]);
  });
});

describe('CRM_ENRICH_V3_* env overrides keep their precedence', () => {
  it('CRM_ENRICH_V3_WEB_SEARCH_MODEL wins for the web tier', async () => {
    const deps = await loadWithEnv({ CRM_ENRICH_V3_WEB_SEARCH_MODEL: 'env-web', CRM_ENRICH_V3_EXTRACT_MODEL: 'env-extract' });
    await deps.extractFieldsViaLLMReal(webExtractInput, 'user-1');
    await deps.buildIdentityDeps('user-1').resolveCompanyDomainViaWebSearch(domainInput);
    expect(jest.mocked(deps.createLLMService).mock.calls.map(([model]) => model)).toEqual(['env-web', 'env-web']);
  });

  it('the web tier falls back to CRM_ENRICH_V3_EXTRACT_MODEL', async () => {
    const deps = await loadWithEnv({ CRM_ENRICH_V3_EXTRACT_MODEL: 'env-extract' });
    await deps.extractFieldsViaLLMReal(webExtractInput, 'user-1');
    expect(deps.createLLMService).toHaveBeenCalledWith('env-extract', 0.0, undefined, BASE);
  });

  it('CRM_ENRICH_V3_CRITIC_MODEL wins for the critic', async () => {
    const deps = await loadWithEnv({ CRM_ENRICH_V3_CRITIC_MODEL: 'env-critic' });
    await deps.buildOrchestratorDeps('user-1').runCriticOverWebFills(criticInput);
    expect(deps.createLLMService).toHaveBeenCalledWith('env-critic', null, undefined, BASE);
  });
});
