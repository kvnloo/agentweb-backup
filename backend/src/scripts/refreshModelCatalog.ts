/** Dry-run by default; --write applies the returned code-only plan for PR review. */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createHash } from 'crypto';
import { refreshModelCatalog } from '../services/agentMode/modelCatalogRefresh';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { MODEL_PRICING, IMAGE_GENERATION_PRICING_USD, VIDEO_GENERATION_PRICING_USD_PER_CLIP, LIVE_MODALITY_PRICES } from '../utils/llmPricing';

/** Replace only changed object members; keep surrounding comments and unrelated entries. */
export function patchObject(source: string, name: string, changes: Record<string, unknown>): string {
  const file = ts.createSourceFile('catalog.ts', source, ts.ScriptTarget.Latest, true);
  let target: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer && ts.isObjectLiteralExpression(node.initializer)) target = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!target) throw new Error(`Missing object ${name}`);
  const pending = new Map(Object.entries(changes));
  const edits: { start: number; end: number; text: string }[] = [];
  for (const member of target.properties) {
    if (!ts.isPropertyAssignment(member) || !ts.isStringLiteral(member.name)) continue;
    if (!pending.has(member.name.text)) continue;
    edits.push({ start: member.initializer.getStart(file), end: member.initializer.end, text: JSON.stringify(pending.get(member.name.text)) });
    pending.delete(member.name.text);
  }
  if (pending.size) edits.push({ start: target.getStart(file) + 1, end: target.getStart(file) + 1,
    text: '\n' + [...pending].map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`).join('\n') + '\n' });
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

/**
 * Union `additions` into an inline `const <name> = new Set([...])` string literal,
 * preserving existing entries regardless of whether they're single- or
 * double-quoted — a quote-only extractor would silently DROP every existing
 * entry (not error) the first time this line is reformatted to double quotes,
 * since there is no quote-style lint rule guarding it (ENG-2293).
 */
export function mergeSetLiteral(source: string, name: string, additions: readonly string[]): string {
  const pattern = new RegExp(`(const ${name} = new Set\\(\\[)([^\\]]*)(\\]\\))`);
  return source.replace(pattern, (_match, pre, body, post) => {
    const existing = [...(body as string).matchAll(/['"]([^'"]*)['"]/g)].map(m => m[1]);
    const merged = [...new Set([...existing, ...additions])];
    return `${pre}${merged.map(id => `'${id}'`).join(', ')}${post}`;
  });
}

async function main() {
  const plan = await refreshModelCatalog();
  console.log(JSON.stringify(plan, null, 2));
  if (!process.argv.includes('--write')) return;
  writeCatalogPlan(plan);
}

export function writeCatalogPlan(plan: Awaited<ReturnType<typeof refreshModelCatalog>>) {
  const registryPath = path.resolve(__dirname, '../services/agentMode/llmModelRegistry.ts');
  const pricePath = path.resolve(__dirname, '../utils/llmPricing.ts');
  const pinPath = path.resolve(__dirname, '../__tests__/llmPricing.test.ts');
  const registry = patchObject(fs.readFileSync(registryPath, 'utf8'), 'LLM_MODEL_REGISTRY',
    Object.fromEntries(Object.entries(plan.registryChanges).map(([id, patch]) => [id, { ...LLM_MODEL_REGISTRY[id], ...patch }])));
  let pricing = patchObject(fs.readFileSync(pricePath, 'utf8'), 'MODEL_PRICING', plan.pricingChanges);
  let pin = fs.readFileSync(pinPath, 'utf8');
  if (Object.keys(plan.pricingChanges).length) {
    pricing = pricing.replace(/export const LLM_PRICE_BOOK_VERSION = "[^"]+";/, `export const LLM_PRICE_BOOK_VERSION = "${plan.date}";`);
    const canonical = (value: any): string => value && typeof value === 'object'
      ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
    const fingerprint = createHash('sha256').update(canonical({
      // ENG-2957: the same tables llmPricing.test.ts fingerprints, voice rates included, or the pin it writes fails CI.
      MODEL_PRICING: { ...MODEL_PRICING, ...plan.pricingChanges }, IMAGE_GENERATION_PRICING_USD, VIDEO_GENERATION_PRICING_USD_PER_CLIP, LIVE_MODALITY_PRICES,
    })).digest('hex').slice(0, 16);
    pin = pin.replace(/version: '\d{4}-\d{2}-\d{2}',/, `version: '${plan.date}',`)
      .replace(/fingerprint: '[a-f0-9]+',[^\n]*/, `fingerprint: '${fingerprint}', // Catalog refresh price-book pin.`);
  }
  // Every addition is priced from a live quote, never a derived guess, so it belongs
  // in the convention allowlist regardless of whether its rate happens to diverge
  // today. Register it here, at add time — not by sniffing the registry's
  // human-editable `description` field later, which the draft-PR review step
  // explicitly tells reviewers to rewrite (ENG-2293).
  if (plan.additions.length) pin = mergeSetLiteral(pin, 'explicitCacheOverrides', plan.additions);
  // Prepare every edit before writing; failed upstream requests leave the worktree untouched.
  fs.writeFileSync(registryPath, registry);
  fs.writeFileSync(pricePath, pricing);
  fs.writeFileSync(pinPath, pin);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
