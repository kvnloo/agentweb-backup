/**
 * Pricing-coverage guard — an unpriced model is a free model.
 *
 * `computeCostMicroUsd` returns 0 when `getModelPrice` misses. Tokens still get
 * counted, so nothing looks broken: the ledger shows traffic, the dollar column
 * shows nothing, and the model is effectively free until a human notices the
 * shape of a chart. That is precisely how ENG-207's stale prices survived.
 *
 * It matters more now than it did: ENG-1116 makes cost the ENFORCED quota, so a
 * model missing from the price book does not merely mis-report — it lets a user
 * spend without ever drawing down their allowance.
 *
 * Adding a model to the registry is a documented four-file ritual (see CLAUDE.md).
 * This test makes the pricing step of that ritual fail loudly instead of silently,
 * by importing the registry module (agentMode/llmModelRegistry.ts, ENG-1831)
 * rather than agentModeService, which drags in most of the backend.
 */

import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { getModelPrice } from '../utils/llmPricing';

/** The keys of the LLM model registry. */
function readRegisteredModels(): string[] {
  return Object.keys(LLM_MODEL_REGISTRY);
}

describe('every registered chat model has a price', () => {
  const models = readRegisteredModels();

  it('finds the registry (guard against the parser silently matching nothing)', () => {
    // Without this, a rename would make the suite pass by testing zero models.
    expect(models.length).toBeGreaterThan(5);
  });

  it.each(models)('%s is priced in llmPricing', (model) => {
    const price = getModelPrice(model);

    expect(price).not.toBeNull();
    expect(price?.inPerM).toBeGreaterThan(0);
    expect(price?.outPerM).toBeGreaterThan(0);
  });
});
