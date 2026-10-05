/**
 * Tests for the describe_image tool registered in emmaToolRegistry.
 *
 * describe_image intentionally uses the configured agent_mode_default_model rather
 * than the chat's selected model. The handler must therefore call
 * emma/impl/mediaVideo.ts's describeImage with NO model argument (undefined), so
 * the model is resolved to the default inside describeImage. Forwarding the chat
 * model here is what previously routed every call to Vertex Opus 4.8.
 *
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A): this tool was
 * repointed from calling agentModeService.describeImage to calling
 * emma/impl/mediaVideo.ts's describeImage directly, binding
 * agentModeService.callLLM/getVisionModel straight off the singleton — the
 * same shape as emmaTools.createHtmlFromTemplate.test.ts. Also proves the two
 * injected LLM-gateway functions are genuinely live bindings, not stale/
 * disconnected closures, using the same discipline every prior injected-
 * resolver test in this series has used.
 */

jest.mock('../emma/impl/mediaVideo', () => ({
  describeImage: jest.fn(),
}));

const mockCallLLM = jest.fn();
const mockGetVisionModel = jest.fn();

// agentModeService.describeImage must NOT be called by this tool anymore —
// mocked as a throwing Proxy so a regression (a call site accidentally left
// pointed at the class) fails loudly instead of silently succeeding against
// the real service. callLLM/getVisionModel are the two real, public
// LLM-gateway methods this tool binds directly off the singleton (see
// emma/impl/mediaVideo.ts's own header for why they're injected rather than
// moved or reimplemented).
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {
      callLLM: mockCallLLM,
      getVisionModel: mockGetVisionModel,
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the describe_image tool after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as mediaVideoImpl from '../emma/impl/mediaVideo';

// Import tools.ts to ensure tools are registered
import '../emma/tools';

const mockMediaVideo = mediaVideoImpl as jest.Mocked<typeof mediaVideoImpl>;

describe('describe_image Emma tool', () => {
  const toolName = 'describe_image';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is registered in emmaToolRegistry', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe(toolName);
  });

  it('does not expose an llmModel input (uses the default model, not a caller-chosen one)', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    const props = (tool?.definition.inputSchema as any)?.properties || {};
    expect(props.llmModel).toBeUndefined();
    expect(props.image_url).toBeDefined();
  });

  it('calls describeImage with undefined model so the default model is used — NOT the chat model', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const mockResponse = { success: true, description: 'a logo' };
    mockMediaVideo.describeImage.mockResolvedValue(mockResponse);

    const args = { image_url: 'https://example.com/chart.png', prompt: 'describe it' };
    // The chat is on anthropic.claude-opus-4-8 — this must NOT be forwarded to describeImage.
    const context = { llmModel: 'anthropic.claude-opus-4-8', userId: 'user-123', sessionId: 'sess-1' };

    const result = await tool.execute(args, context);

    expect(mockMediaVideo.describeImage).toHaveBeenCalledTimes(1);
    const callArgs = mockMediaVideo.describeImage.mock.calls[0];
    expect(callArgs.slice(0, 4)).toEqual([
      undefined,
      'https://example.com/chart.png',
      'describe it',
      // ENG-1858: metered to the calling user, not "system".
      { userId: 'user-123', sessionId: 'sess-1', feature: 'describe_image' },
    ]);
    // Guard against regressing to forwarding the chat model
    expect(callArgs[0]).not.toBe('anthropic.claude-opus-4-8');

    const [, , , , injectedCallLLM, injectedGetVisionModel] = callArgs as any[];
    expect(typeof injectedCallLLM).toBe('function');
    expect(typeof injectedGetVisionModel).toBe('function');

    // Prove each is a LIVE binding, not a stale reference: invoking the
    // captured function must reach the real (mocked) instance method.
    mockCallLLM.mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] });
    await injectedCallLLM('gemini-3-flash-preview', [{ role: 'user', content: 'x' }], { max_completion_tokens: 2000 });
    expect(mockCallLLM).toHaveBeenCalledWith(
      'gemini-3-flash-preview',
      [{ role: 'user', content: 'x' }],
      { max_completion_tokens: 2000 }
    );

    mockGetVisionModel.mockResolvedValueOnce('gemini-3-flash-preview');
    await expect(injectedGetVisionModel()).resolves.toBe('gemini-3-flash-preview');
    expect(mockGetVisionModel).toHaveBeenCalledTimes(1);

    expect(result).toEqual(mockResponse);
  });

  it('passes through image_url with no prompt (prompt undefined)', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    mockMediaVideo.describeImage.mockResolvedValue({ success: true });

    await tool.execute({ image_url: 'https://example.com/a.png' }, { llmModel: 'gpt-5.5' });

    const callArgs = mockMediaVideo.describeImage.mock.calls[0];
    expect(callArgs.slice(0, 4)).toEqual([
      undefined,
      'https://example.com/a.png',
      undefined,
      // ENG-1858: no user in context → feature only, never an invented user.
      { feature: 'describe_image' },
    ]);
  });
});
