#!/usr/bin/env node
/** Offline compiler. Usage: npx ts-node --transpile-only scripts/compile-sandbox-dataset.ts <packet> <case.yaml> [output-directory] */
import { realpathSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';
import { compileSandboxDataset, parseSandboxCase, SANDBOX_PLACEHOLDER_PNG } from '../src/services/sandbox/datasetCompiler';
import { readDatasetFile } from '../src/services/sandbox/datasetFiles';
import { withCompilerOutput } from '../src/services/sandbox/compilerOutput';

export function main(args: string[]): void {
  const [packet, caseFile, output] = args;
  if (!packet || !caseFile || args.length > 3) throw new Error('Usage: compile-sandbox-dataset <packet> <case.yaml> [output-directory]');
  const dataset = compileSandboxDataset(packet, parseSandboxCase(readDatasetFile(caseFile, 64 * 1024).toString('utf8')));
  const json = JSON.stringify(dataset, null, 2) + '\n';
  if (!output) { process.stdout.write(json); return; }
  const destination = resolve(output), packetRoot = realpathSync(packet);
  withCompilerOutput(destination, packetRoot, put => {
    for (const asset of dataset.assetsManifest ?? []) {
      const bytes = asset.sourcePath === 'generated/placeholder.png' ? SANDBOX_PLACEHOLDER_PNG : readDatasetFile(resolve(packetRoot, asset.sourcePath));
      if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256 || bytes.length !== asset.bytes) throw new Error(`Asset changed after compilation: ${asset.sourcePath}`);
      put(asset.assetKey, bytes);
    }
    put('dataset.json', json);
    put('reconciliation.json', JSON.stringify(dataset.reconciliation, null, 2) + '\n');
  });
  process.stdout.write(`${dataset.meta.datasetId}@${dataset.meta.version}: ${dataset.insightsDaily.length} daily rows, ${dataset.assetsManifest?.length} assets; ${destination}/dataset.json\n`);
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
