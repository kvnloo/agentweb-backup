jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn() },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

import { AgentModeService } from '../services/agentModeService';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { appendRetryabilityGuidance } from '../services/agentMode/core/errorRetryability';

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
  getS3ObjectAsString: jest.fn(),
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(),
}));

/**
 * ENG-1844: Emma told a real customer the landing-page generation "capability
 * is currently unavailable right now... the underlying tool service is
 * temporarily unreachable" and offered to file a product issue, for a real,
 * immediate, non-flaky 422 from the correctly-working ENG-326 brand-logo gate.
 *
 * Reproduces the FULL model-visible pipeline exactly as toolDispatch.ts builds
 * it — httpClient's thrown Error (now carrying .code) through
 * classifyToolErrorClass + formatToolError + appendRetryabilityGuidance — and
 * pins that the final string forbids the outage/product-issue framing and
 * states the real, actionable fix.
 */
describe('generate_landing_page brand-logo 422 — not reported as an outage (ENG-1844)', () => {
  let svc: AgentModeService;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new AgentModeService();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  // Exactly what httpClient.ts's self-call throw now produces for this route's 422.
  const brandLogoError = Object.assign(
    new Error(
      'API error (422): No brand logo is saved in Brand Guidelines. Upload your logo in brand config (Brand Guidelines), then generate again — landing pages are never generated with an invented or approximate logo.'
    ),
    { code: 'missing_brand_logo' }
  );

  it('produces a model-visible message with no outage/unreachable framing', () => {
    const errorClass = classifyToolErrorClass(brandLogoError);
    const formatted = (svc as any).formatToolError('generate_landing_page', brandLogoError.message);
    const finalContent = appendRetryabilityGuidance(formatted, errorClass);

    expect(errorClass).toBe('missing_brand_logo');
    // The guidance legitimately USES the words "unreachable"/"unavailable" to forbid
    // asserting them — checking for the word's bare absence would false-positive on
    // the very sentence that bans it. Check instead that Emma's actual observed wrong
    // wording (verbatim from the live incident) does not appear.
    expect(finalContent).not.toContain('currently unavailable right now');
    expect(finalContent).not.toContain('temporarily unreachable');
    expect(finalContent).not.toMatch(/file a product issue tracking/i);
  });

  it('tells the model the real, actionable fix and forbids retrying as-is', () => {
    const errorClass = classifyToolErrorClass(brandLogoError);
    const formatted = (svc as any).formatToolError('generate_landing_page', brandLogoError.message);
    const finalContent = appendRetryabilityGuidance(formatted, errorClass);

    expect(finalContent).toMatch(/upload a logo/i);
    expect(finalContent).toMatch(/Brand Guidelines/);
    expect(finalContent).toMatch(/Retryable: no/);
    expect(finalContent).toMatch(/correctly-working/i);
  });

  it('does not regress an ordinary 422 with no brand-logo marker', () => {
    const ordinary422 = Object.assign(new Error('API error (422): "prompt" is required'), { status: 422 });
    const errorClass = classifyToolErrorClass(ordinary422);
    expect(errorClass).toBe('invalid_args');
    expect(errorClass).not.toBe('missing_brand_logo');
  });
});
