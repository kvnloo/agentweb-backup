/**
 * ENG-1205 — guard coverage over the REAL model registry, not a fixture.
 *
 * Every bug found in this detector after it shipped was a case my hand-written
 * fixtures did not contain:
 *
 *  - a negation in an unrelated sentence suppressed a genuine request
 *    (found by a production turn, PR #2707);
 *  - a dotted version split a sentence, so "What does it mean to use GPT 4.1?"
 *    was read as a request (found by CodeRabbit on that same PR — and it hit
 *    most of the catalog, because most model names carry a dotted version).
 *
 * Both classes are invisible to fixtures chosen by the person who wrote the
 * code. This sweeps every user-visible model through both failure classes, so a
 * new model, a renamed one, or a new punctuation shape is covered the day it
 * lands in `llmModels` rather than the day a customer hits it.
 *
 * Lives outside utils/__tests__ because it reads the live service registry
 * rather than a passed-in catalog.
 */
import { buildModelMentionIndex, findModelMention } from '../utils/modelMentionRequest';
import { agentModeService } from '../services/agentModeService';

const catalog = agentModeService.getModelMentionCatalog();
const index = buildModelMentionIndex(catalog);
const names = catalog.map((m) => m.name || m.id);

describe('model-mention guards, swept over the real registry', () => {
  it('has a non-trivial catalog to sweep', () => {
    // Guards the sweep itself: an empty catalog would make every case below
    // pass vacuously.
    expect(names.length).toBeGreaterThan(10);
  });

  it('never reads a question about a model as a request for it', () => {
    const falsePositives = names.flatMap((name) =>
      [
        `What does it mean to use ${name}?`,
        `What would it cost to use ${name}?`,
        `Why would I switch to ${name}?`,
      ].filter((text) => findModelMention(text, index) !== null),
    );
    expect(falsePositives).toEqual([]);
  });

  it('never reads a negated mention as a request', () => {
    const falsePositives = names.flatMap((name) =>
      [
        `don't use ${name}`,
        `please don't switch to ${name}`,
        `never use ${name} for this`,
      ].filter((text) => findModelMention(text, index) !== null),
    );
    expect(falsePositives).toEqual([]);
  });

  it('still recognises a plain request for every model', () => {
    const missed = names.flatMap((name) =>
      [
        `use ${name}`,
        `switch to ${name}`,
        // The clause-scoping case from PR #2707: an unrelated negation after
        // the mention must not veto it.
        `please use ${name} and don't use tables`,
      ].filter((text) => findModelMention(text, index) === null),
    );
    expect(missed).toEqual([]);
  });
});

it('ENG-2028 offered picker models obey the same permission policy as selection', async () => {
  jest.spyOn(agentModeService, 'getDefaultModel').mockResolvedValue('gemini-3.8-flash');
  for (const admin of [false, true]) {
    const offered = (await agentModeService.getSupportedModelsWithMetadata(admin)).map(m => m.id);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every(id => agentModeService.isModelSelectableBy(id, admin))).toBe(true);
  }
});

it('ENG-744/2028 permits public Opus models while preserving actual registry restrictions', () => {
  expect(agentModeService.isModelSelectableBy('anthropic.claude-opus-5', false)).toBe(true);
  expect(agentModeService.isModelSelectableBy('anthropic.claude-opus-4-8', false)).toBe(true);
  // main opened Opus 4.6 to every user after this test was written (bc8faa4ca, ENG-2028).
  expect(agentModeService.isModelSelectableBy('anthropic.claude-opus-4-6-v1', false)).toBe(true);
  expect(agentModeService.isModelSelectableBy('anthropic.claude-opus-4-6-v1', true)).toBe(true);
  expect(agentModeService.isModelSelectableBy('gemini-3.1-flash-live-preview', true)).toBe(false);
  expect(agentModeService.isModelSelectableBy('unknown-model', true)).toBe(false);
});
