/**
 * ENG-2103 F2 design-decision-list follow-up (Pattern A) — proves
 * emma/tools.ts's create_html_from_template tool calls
 * emma/impl/htmlCreation.ts's createHtmlFromTemplate directly, NOT
 * agentModeService.createHtmlFromTemplate (that class method still exists,
 * but only as a delegating wrapper for OTHER real callers — routes/
 * emmaApi.ts and createHtmlFromTemplate.test.ts — not for this tool; see
 * emmaTools.htmlCreation.test.ts for the sibling createHtmlFile/
 * createHtmlTemplate cluster this file deliberately excludes).
 *
 * Also proves the three injected LLM-gateway functions (callLLM/
 * getDefaultModel/resolveGenerationModel) this tool binds straight off the
 * agentModeService singleton are genuinely live bindings, not stale/
 * disconnected closures — the same discipline every prior injected-resolver
 * test in this series (AccountResolver/EmployerSizeFilterResolver/
 * WorkPlanModelRegistry) has used: invoke the captured function and assert
 * the underlying real method observed the call.
 */

jest.mock('../emma/impl/htmlCreation', () => ({
  createHtmlFromTemplate: jest.fn(),
}));

const mockCallLLM = jest.fn();
const mockGetDefaultModel = jest.fn();
const mockResolveGenerationModel = jest.fn();

// agentModeService.createHtmlFromTemplate must NOT be called by this tool
// anymore — mocked as a throwing Proxy so a regression (a call site
// accidentally left pointed at the class) fails loudly instead of silently
// succeeding against the real service. callLLM/getDefaultModel/
// resolveGenerationModel are the three real, public LLM-gateway methods this
// tool binds directly off the singleton (see emma/impl/htmlCreation.ts's own
// header for why they're injected rather than moved or reimplemented).
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {
      callLLM: mockCallLLM,
      getDefaultModel: mockGetDefaultModel,
      resolveGenerationModel: mockResolveGenerationModel,
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the create_html_from_template tool after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as htmlCreationImpl from '../emma/impl/htmlCreation';
import '../emma/tools';

const mockHtmlCreation = htmlCreationImpl as jest.Mocked<typeof htmlCreationImpl>;

describe('create_html_from_template tool delegates to emma/impl/htmlCreation.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards args and the 3 injected LLM-gateway functions, each genuinely bound to the agentModeService singleton', async () => {
    const expected = { success: true, s3_url: 'https://s3/x.html' };
    mockHtmlCreation.createHtmlFromTemplate.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_html_from_template')!;
    const result = await tool.execute(
      { template_id: 'tpl_1', variable_values_json: '{"title":"Hi"}', array_variable_values_json: '{"items":[]}' },
      { llmModel: 'gpt-5.5', userId: 'u1', sessionId: 's1' }
    );

    expect(result).toBe(expected);
    expect(mockHtmlCreation.createHtmlFromTemplate).toHaveBeenCalledTimes(1);

    const callArgs = mockHtmlCreation.createHtmlFromTemplate.mock.calls[0];
    expect(callArgs.slice(0, 6)).toEqual([
      'gpt-5.5', 'tpl_1', { title: 'Hi' }, { items: [] }, 'u1', 's1',
    ]);
    expect(callArgs).toHaveLength(9);

    const [, , , , , , injectedCallLLM, injectedGetDefaultModel, injectedResolveGenerationModel] = callArgs as any[];
    expect(typeof injectedCallLLM).toBe('function');
    expect(typeof injectedGetDefaultModel).toBe('function');
    expect(typeof injectedResolveGenerationModel).toBe('function');

    // Prove each is a LIVE binding, not a stale reference: invoking the
    // captured function must reach the real (mocked) instance method.
    mockCallLLM.mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
    await injectedCallLLM('gpt-5.5', [{ role: 'user', content: 'x' }], {
      temperature: 0.1,
      response_format: { type: 'json_object' },
      max_completion_tokens: 32768,
      taskClass: 'content_generation',
      usageContext: { userId: 'u1', sessionId: 's1', feature: 'html_template' },
    });
    expect(mockCallLLM).toHaveBeenCalledWith(
      'gpt-5.5',
      [{ role: 'user', content: 'x' }],
      expect.objectContaining({ temperature: 0.1 })
    );

    mockGetDefaultModel.mockResolvedValueOnce('gpt-5.5');
    await expect(injectedGetDefaultModel()).resolves.toBe('gpt-5.5');
    expect(mockGetDefaultModel).toHaveBeenCalledTimes(1);

    mockResolveGenerationModel.mockReturnValueOnce({ model: 'gpt-5.5', fellBack: false, requestedModel: 'gpt-5.5' });
    expect(injectedResolveGenerationModel('gpt-5.5')).toEqual({ model: 'gpt-5.5', fellBack: false, requestedModel: 'gpt-5.5' });
    expect(mockResolveGenerationModel).toHaveBeenCalledWith('gpt-5.5');
  });

  it('returns an error for invalid JSON in variable_values_json without calling the module', async () => {
    const tool = emmaToolRegistry.getTool('create_html_from_template')!;
    const result: any = await tool.execute(
      { template_id: 'tpl_1', variable_values_json: 'not-json', array_variable_values_json: '{}' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Invalid JSON in variable_values_json');
    expect(mockHtmlCreation.createHtmlFromTemplate).not.toHaveBeenCalled();
  });

  it('returns an error for invalid JSON in array_variable_values_json without calling the module', async () => {
    const tool = emmaToolRegistry.getTool('create_html_from_template')!;
    const result: any = await tool.execute(
      { template_id: 'tpl_1', variable_values_json: '{}', array_variable_values_json: 'not-json' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Invalid JSON in array_variable_values_json');
    expect(mockHtmlCreation.createHtmlFromTemplate).not.toHaveBeenCalled();
  });
});
