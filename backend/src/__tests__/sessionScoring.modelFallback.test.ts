/**
 * ENG-744 — a retired model id must not silently kill session scoring.
 *
 * Scoring takes its model from persisted config (the `default-scoring-model`
 * setting, or a scoring judge's `llmModel`). Those values are written with no
 * registry validation, so when a model is retired the stale id survives in the
 * DB. Both scoring paths handed it straight to `callLLM`, which throws
 * `Invalid model '<id>'` — and because admin.ts wraps per-session scoring in
 * Promise.allSettled, the visible symptom is "sessions quietly stop being
 * scored", not an error anyone sees.
 *
 * The chat path already solved this (ENG-46 `resolveGenerationModel`). These
 * assertions hold scoring to the same contract, but falling back to the
 * scoring-specific default rather than the chat default — routing scoring to
 * the expensive prod chat default would be its own incident.
 */

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {},
}));

const mockResolveGenerationModel = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    resolveGenerationModel: (m: string) => mockResolveGenerationModel(m),
  },
}));

import { resolveScoringModel, SCORING_MODEL } from '../services/sessionScoringService';

describe('ENG-744 — resolveScoringModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes a served model through untouched', async () => {
    mockResolveGenerationModel.mockReturnValue({
      model: 'gemini-3.1-flash-lite',
      fellBack: false,
      requestedModel: 'gemini-3.1-flash-lite',
    });
    await expect(resolveScoringModel('gemini-3.1-flash-lite')).resolves.toBe('gemini-3.1-flash-lite');
  });

  it('applies legacy aliasing rather than treating an alias as retired', async () => {
    // resolveGenerationModel normalizes legacy ids forward; a caller pinned to
    // the pre-alias id must keep working, not silently drop to the default.
    mockResolveGenerationModel.mockReturnValue({
      model: 'anthropic.claude-opus-4-8',
      fellBack: false,
      requestedModel: 'claude-opus-4-8',
    });
    await expect(resolveScoringModel('claude-opus-4-8')).resolves.toBe('anthropic.claude-opus-4-8');
  });

  it('falls back to the SCORING default when the persisted id was retired', async () => {
    // The ENG-744 case: gemini-3-pro-preview was removed from the registry.
    mockResolveGenerationModel.mockImplementation((m: string) =>
      m === SCORING_MODEL
        ? { model: SCORING_MODEL, fellBack: false, requestedModel: m }
        : { model: 'gpt-5.5', fellBack: true, requestedModel: m }
    );
    await expect(resolveScoringModel('gemini-3-pro-preview')).resolves.toBe(SCORING_MODEL);
  });

  it('does NOT fall back to the chat default — scoring must not inherit chat routing', async () => {
    mockResolveGenerationModel.mockImplementation((m: string) =>
      m === SCORING_MODEL
        ? { model: SCORING_MODEL, fellBack: false, requestedModel: m }
        : { model: 'anthropic.claude-opus-4-8', fellBack: true, requestedModel: m }
    );
    const result = await resolveScoringModel('gemini-3-pro-preview');
    expect(result).not.toBe('anthropic.claude-opus-4-8');
    expect(result).toBe(SCORING_MODEL);
  });

  it('warns loudly rather than swallowing the retired id', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockResolveGenerationModel.mockImplementation((m: string) =>
      m === SCORING_MODEL
        ? { model: SCORING_MODEL, fellBack: false, requestedModel: m }
        : { model: 'gpt-5.5', fellBack: true, requestedModel: m }
    );
    await resolveScoringModel('gemini-3-pro-preview');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gemini-3-pro-preview'));
  });

  it('handles an undefined/empty persisted value by using the scoring default', async () => {
    mockResolveGenerationModel.mockImplementation((m: string) =>
      m === SCORING_MODEL
        ? { model: SCORING_MODEL, fellBack: false, requestedModel: m }
        : { model: 'gpt-5.5', fellBack: true, requestedModel: m }
    );
    await expect(resolveScoringModel(undefined)).resolves.toBe(SCORING_MODEL);
    await expect(resolveScoringModel('')).resolves.toBe(SCORING_MODEL);
  });

  it('last-resorts to the chat fallback if the scoring default itself is unserved', async () => {
    // Guard against the failure this fix could otherwise introduce: if
    // SCORING_MODEL is ever retired too, returning it would just move the
    // "Invalid model" throw rather than remove it.
    mockResolveGenerationModel.mockReturnValue({
      model: 'gpt-5.5',
      fellBack: true,
      requestedModel: 'anything',
    });
    await expect(resolveScoringModel('gemini-3-pro-preview')).resolves.toBe('gpt-5.5');
  });
});
