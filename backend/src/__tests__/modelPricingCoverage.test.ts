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
 * by reading the registry from source rather than importing agentModeService,
 * which drags in most of the backend.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getModelPrice } from '../utils/llmPricing';

const AGENT_MODE_SERVICE = path.join(__dirname, '..', 'services', 'agentModeService.ts');

/** Pull the keys of the `llmModels` registry literal straight out of the source. */
function readRegisteredModels(): string[] {
  const src = fs.readFileSync(AGENT_MODE_SERVICE, 'utf8');
  const start = src.indexOf('private llmModels: Record<string, LLMModelConfig> = {');
  expect(start).toBeGreaterThan(-1);

  // Walk braces from the opening `{` so the block ends exactly where the literal
  // does — a line-count heuristic would silently drift as models are added.
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const block = src.slice(open, end);
  const models: string[] = [];
  // Keys are quoted at the start of a line: `'model-id': { client: null, ... }`
  for (const m of block.matchAll(/^\s*'([^']+)'\s*:\s*\{/gm)) models.push(m[1]);
  return models;
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
