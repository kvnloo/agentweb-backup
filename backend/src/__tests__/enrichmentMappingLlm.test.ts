// ENG-2720: the enrichment helper LLM calls (alias inference, smart-field classification, sibling
// field mapping) used to default to the retired "gpt-5-chat-2" id, which callLLM rewrites to gpt-5.5.
// They must resolve the same "enrichment" role as the extraction calls.
const mockGenerate = jest.fn();
jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(() => ({ generateJSONContent: mockGenerate })),
}));
jest.mock('../services/modelRoles', () => ({ resolveModelForUser: jest.fn() }));
jest.mock('../services/db', () => ({ crmDb: {} }));
jest.mock('../services/enrichmentPrompts', () => ({
  ...jest.requireActual('../services/enrichmentPrompts'),
  buildSmartFieldClassificationSystemPrompt: jest.fn().mockReturnValue('sys'),
  buildSmartFieldClassificationUserPrompt: jest.fn().mockReturnValue('usr'),
}));

import { createLLMService } from '../utils/llmService';
import { resolveModelForUser } from '../services/modelRoles';
import { createEnrichmentHelperLLM, CHEAP_DEFAULT_MODEL, FALLBACK_MODEL } from '../services/enrichmentMappingLlm';
import { buildConfigServiceDeps } from '../services/enrichmentConfigDeps';
import { buildLLMFieldMapping } from '../services/enrichmentSiblingConfigFields';

const mkLLM = createLLMService as jest.Mock;
const resolve = resolveModelForUser as jest.Mock;
const ENV = ['CRM_ENRICH_V3_ALIAS_MODEL', 'CRM_ENRICH_V3_CLASSIFY_MODEL', 'CRM_ENRICH_V3_EXTRACT_MODEL'] as const;

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV) delete process.env[k];
  resolve.mockResolvedValue(CHEAP_DEFAULT_MODEL);
  mockGenerate.mockResolvedValue({});
});
afterAll(() => { for (const k of ENV) delete process.env[k]; });

const modelOfLastCall = () => mkLLM.mock.calls[mkLLM.mock.calls.length - 1][0];
const optionsOfLastCall = () => mkLLM.mock.calls[mkLLM.mock.calls.length - 1][3];
const HELPER_OPTIONS = { requireContent: true, fallbackModels: [FALLBACK_MODEL] };

describe('createEnrichmentHelperLLM', () => {
  it('uses the user\'s enrichment role, retries empty answers and falls back to gpt-5.5 for the cheap default', async () => {
    await createEnrichmentHelperLLM('user-1');
    expect(resolve).toHaveBeenCalledWith('user-1', 'enrichment');
    expect(mkLLM).toHaveBeenCalledWith(CHEAP_DEFAULT_MODEL, 0, undefined, {
      requireContent: true,
      fallbackModels: [FALLBACK_MODEL],
    });
  });

  it('keeps an org\'s own model and adds no fallback to it', async () => {
    resolve.mockResolvedValue('gemini-3.8-flash');
    await createEnrichmentHelperLLM('user-1');
    expect(mkLLM).toHaveBeenCalledWith('gemini-3.8-flash', 0, undefined, { requireContent: true });
  });

  it('lets an explicit env model win without resolving the role', async () => {
    await createEnrichmentHelperLLM('user-1', 'env-model');
    expect(resolve).not.toHaveBeenCalled();
    expect(modelOfLastCall()).toBe('env-model');
  });
});

describe('call sites never name the retired gpt-5-chat-2', () => {
  it('alias inference resolves the saving user\'s enrichment role', async () => {
    await buildConfigServiceDeps().llmInferAliases([{ name: 'stage', instruction: 'funding stage' }], 'user-2');
    expect(resolve).toHaveBeenCalledWith('user-2', 'enrichment');
    expect(modelOfLastCall()).toBe(CHEAP_DEFAULT_MODEL);
    expect(optionsOfLastCall()).toEqual(HELPER_OPTIONS);
  });

  it('smart-field classification resolves the saving user\'s enrichment role', async () => {
    await buildConfigServiceDeps().llmClassifySmartFields([{ name: 'is_hiring', instruction: 'hiring engineers' }], 'user-3');
    expect(resolve).toHaveBeenCalledWith('user-3', 'enrichment');
    expect(modelOfLastCall()).toBe(CHEAP_DEFAULT_MODEL);
    expect(optionsOfLastCall()).toEqual(HELPER_OPTIONS);
  });

  it('sibling field mapping resolves the run user\'s enrichment role', async () => {
    await buildLLMFieldMapping(
      [{ name: 'stage', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' }],
      { userId: 'user-4', feature: 'crm_enrichment_field_mapping' },
    );
    expect(resolve).toHaveBeenCalledWith('user-4', 'enrichment');
    expect(modelOfLastCall()).toBe(CHEAP_DEFAULT_MODEL);
    expect(optionsOfLastCall()).toEqual(HELPER_OPTIONS);
  });

  it('the CRM_ENRICH_V3_* env overrides keep their precedence', async () => {
    process.env.CRM_ENRICH_V3_CLASSIFY_MODEL = 'classify-only-env';
    await buildConfigServiceDeps().llmInferAliases([{ name: 'a', instruction: '' }], 'u'); // alias never reads the classify env
    expect(modelOfLastCall()).toBe(CHEAP_DEFAULT_MODEL);
    delete process.env.CRM_ENRICH_V3_CLASSIFY_MODEL;
    process.env.CRM_ENRICH_V3_ALIAS_MODEL = 'alias-env';
    await buildConfigServiceDeps().llmInferAliases([{ name: 'a', instruction: '' }], 'u');
    expect(modelOfLastCall()).toBe('alias-env');
    await buildConfigServiceDeps().llmClassifySmartFields([{ name: 'a', instruction: '' }], 'u'); // falls back to the alias env
    expect(modelOfLastCall()).toBe('alias-env');
    process.env.CRM_ENRICH_V3_CLASSIFY_MODEL = 'classify-env';
    await buildConfigServiceDeps().llmClassifySmartFields([{ name: 'a', instruction: '' }], 'u');
    expect(modelOfLastCall()).toBe('classify-env');
    process.env.CRM_ENRICH_V3_EXTRACT_MODEL = 'extract-env';
    await buildLLMFieldMapping([{ name: 'a', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' }]);
    expect(modelOfLastCall()).toBe('extract-env');
  });
});

describe('fail soft', () => {
  const sibling = [{ name: 'stage', type: 'string' as const, instruction: '', include: true, overwritePolicy: 'fill_if_empty' as const }];

  it('a role lookup that rejects degrades exactly like an LLM failure at every site', async () => {
    resolve.mockRejectedValue(new Error('role lookup down'));
    expect(await buildConfigServiceDeps().llmInferAliases([{ name: 'a', instruction: '' }], 'u')).toEqual({});
    expect(await buildConfigServiceDeps().llmClassifySmartFields([{ name: 'a', instruction: 'x' }], 'u')).toEqual({});
    const mapping = await buildLLMFieldMapping(sibling, { userId: 'u', feature: 'crm_enrichment_field_mapping' });
    expect(mapping.get('stage')).toEqual(['stage']);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

describe('constants stay in step with the role default', () => {
  it('CHEAP_DEFAULT_MODEL is the enrichment role default, so the gpt-5.5 fallback keeps applying to it', async () => {
    delete process.env.CRM_ENRICH_V3_DEFAULT_MODEL;
    const { getRoleDefault } = jest.requireActual('../services/modelRoles');
    expect(await getRoleDefault('enrichment')).toBe(CHEAP_DEFAULT_MODEL);
  });
});

describe('sibling mapping metering', () => {
  it('records the call under feature "enrichment" when the caller passes no usage context', async () => {
    await buildLLMFieldMapping([{ name: 'a', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' }]);
    expect(mockGenerate.mock.calls[0][4]).toEqual({ feature: 'enrichment' });
  });
});
