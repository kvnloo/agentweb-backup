/**
 * ENG-2430 — CLI for the Ads Auto Publisher demo (dry-run only).
 *   npx ts-node src/adsPublisherDemo/cli.ts src/adsPublisherDemo/samples/ecommerce-sales.json
 * Exit 0 = valid plan printed, 2 = validation errors, 1 = usage/read error.
 */
import fs from 'fs';
import { planPublish } from './planner';

export function runCli(argv: string[], out: (s: string) => void = console.log): number {
  const file = argv[0];
  if (!file) {
    out('usage: ads-publisher-demo <spec.json>');
    return 1;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    out(`cannot read ${file}: ${(e as Error).message}`);
    return 1;
  }
  let spec: unknown;
  try {
    spec = JSON.parse(raw);
  } catch {
    out(`${file} is not valid JSON`);
    return 1;
  }
  const result = planPublish(spec);
  out(JSON.stringify(result, null, 2));
  return result.valid ? 0 : 2;
}

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}
