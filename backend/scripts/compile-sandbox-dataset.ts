#!/usr/bin/env node
/** Offline compiler. Usage: npx ts-node --transpile-only scripts/compile-sandbox-dataset.ts <packet> <case.yaml> [output-directory] */
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'fs';
import { resolve, dirname, sep } from 'path';
import { createHash } from 'crypto';
import { compileSandboxDataset, parseSandboxCase, SANDBOX_PLACEHOLDER_PNG } from '../src/services/sandbox/datasetCompiler';

export function main(args: string[]): void {
  const [packet, caseFile, output] = args;
  if (!packet || !caseFile || args.length > 3) throw new Error('Usage: compile-sandbox-dataset <packet> <case.yaml> [output-directory]');
  const dataset = compileSandboxDataset(packet, parseSandboxCase(readFileSync(caseFile, 'utf8')));
  const json = JSON.stringify(dataset, null, 2) + '\n';
  if (!output) { process.stdout.write(json); return; }
  const destination = resolve(output), packetRoot = realpathSync(packet);
  if (destination === packetRoot || destination.startsWith(packetRoot + sep)) throw new Error('Output must be outside the frozen packet');
  mkdirSync(destination, { recursive: true });
  for (const asset of dataset.assetsManifest ?? []) {
    const bytes = asset.sourcePath === 'generated/placeholder.png' ? SANDBOX_PLACEHOLDER_PNG : readFileSync(resolve(packetRoot, asset.sourcePath));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256 || bytes.length !== asset.bytes) throw new Error(`Asset changed after compilation: ${asset.sourcePath}`);
    const path = resolve(destination, asset.assetKey); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
  }
  writeFileSync(resolve(destination, 'dataset.json'), json);
  writeFileSync(resolve(destination, 'reconciliation.json'), JSON.stringify(dataset.reconciliation, null, 2) + '\n');
  process.stdout.write(`${dataset.meta.datasetId}@${dataset.meta.version}: ${dataset.insightsDaily.length} daily rows, ${dataset.assetsManifest?.length} assets; ${destination}/dataset.json\n`);
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
