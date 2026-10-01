import { getModelPrice, ModelPrice } from '../../utils/llmPricing';
import { LLM_MODEL_REGISTRY, LLMModelConfig, ModelTier } from './llmModelRegistry';
import { resolveOpenRouterUpstreamModelId } from '../../utils/openRouterGatewayContract';

export const blendedPrice = (price: ModelPrice): number => 0.75 * price.inPerM + 0.25 * price.outPerM;

/** Preserve product-line qualifiers (pro/flash, opus/sonnet, sol/luna, live, etc.). */
export function inferFamily(id: string, config: { family?: string } = {}): string {
  if (config.family) return config.family;
  let upstream = id.replace(/^openrouter\//, '');
  try { upstream = resolveOpenRouterUpstreamModelId(id); } catch { /* Pure inference also accepts upstream ids. */ }
  const line = upstream.split('/').pop()!.toLowerCase()
    .replace(/-\d{8}(?=-|$)/g, '').replace(/-v?\d+(?:[.-]\d+)*(?=-|:|$)/g, '')
    .replace(/(?<=[a-z])\d+(?:\.\d+)*(?=-|:|$)/g, '');
  // Existing explicit families bridge the renamed GPT lightweight/balanced lines.
  if (line === 'gpt-luna' || line === 'gpt-nano') return 'gpt5-nano';
  if (line === 'gpt-terra' || line === 'gpt') return 'gpt5-chat';
  return line;
}

function providerKey(id: string): string {
  try { return resolveOpenRouterUpstreamModelId(id).split('/')[0]; } catch {
    return id.includes('/') ? id.replace(/^openrouter\//, '').split('/')[0] : '';
  }
}

export interface DominanceCandidate {
  id: string;
  family?: string;
  tier?: ModelTier; // Compatibility only; never used for comparison.
  qualityScore?: number;
  legacy?: boolean;
  cost?: number;
}

/** Raw Pareto dominance, with tied dimensions unable to establish strict improvement.
 * No price/quality regression is accepted, even inside the noise band. This also
 * keeps the relation acyclic, so every legacy chain ends at a usable successor.
 */
export function supersession(candidates: readonly DominanceCandidate[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const cost = (m: DominanceCandidate) => {
    if (m.cost !== undefined) return m.cost;
    const price = getModelPrice(m.id);
    return price ? blendedPrice(price) : NaN;
  };
  for (const a of candidates) {
    const ac = cost(a), aq = a.qualityScore;
    if (!Number.isFinite(ac) || ac < 0 || typeof aq !== 'number' || !Number.isFinite(aq)) continue;
    const successors = candidates.filter(b => {
      const bc = cost(b), bq = b.qualityScore;
      return b.id !== a.id && !b.legacy && providerKey(a.id) === providerKey(b.id) && inferFamily(a.id, a) === inferFamily(b.id, b)
        && Number.isFinite(bc) && bc >= 0 && typeof bq === 'number' && Number.isFinite(bq)
        && bc <= ac && bq >= aq
        && (ac - bc > ac * 0.05 + 1e-10 || bq - aq > 1 + 1e-10);
    }).map(b => b.id);
    if (successors.length) result.set(a.id, successors);
  }
  return result;
}

export function deriveDominanceLegacyIds(candidates: readonly DominanceCandidate[]): Set<string> {
  return new Set(supersession(candidates).keys());
}

/** Recommendations only; never rewrites a saved session/schedule or entitlements. */
export function scheduleBackupModels(
  optimized: readonly string[], supported: readonly string[],
  registry: Readonly<Record<string, Readonly<LLMModelConfig>>> = LLM_MODEL_REGISTRY,
): string[] {
  const candidates = supported.filter(id => registry[id] && !registry[id].isLive && !registry[id].internalOnly)
    .map(id => ({ id, ...registry[id] }));
  const replacements = supersession(candidates);
  const wanted = new Set(optimized);
  for (const id of optimized) for (const successor of replacements.get(id) ?? []) wanted.add(successor);
  return candidates.filter(m => wanted.has(m.id) && !m.legacy && !replacements.has(m.id)).map(m => m.id);
}
