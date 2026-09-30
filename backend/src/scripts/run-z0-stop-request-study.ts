#!/usr/bin/env ts-node
/**
 * Manual paired replay for z0evals' stop_request_v1 adversarial corpus.
 *
 * This performs the exact incumbent Gemini judge + z0 Noul shadow call.
 * The z0 result is never applied.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runStopRequestStudyCase } from '../services/z0StopRequestShadow';

interface Fixture {
  schema: string;
  id: string;
  expected_stop: boolean;
  message: string;
  difficulty: 'clear' | 'edge';
}

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

async function main() {
  const fixturePath = process.argv[2];
  const outputPath = process.argv[3];
  if (!fixturePath || !outputPath) {
    throw new Error(
      'usage: npm run study:z0-stop-request -- <fixtures.jsonl> <results.jsonl>',
    );
  }
  if (
    (process.env.Z0INT_AGENTWEB_MODE ?? '').toLowerCase() === 'off'
    || !process.env.Z0INT_AGENTWEB_MODE
  ) {
    throw new Error('Z0INT_AGENTWEB_MODE must be shadow or active for the study');
  }
  if (process.env.Z0INT_STOP_REQUEST_ALLOW_REMOTE !== '1') {
    throw new Error(
      'Z0INT_STOP_REQUEST_ALLOW_REMOTE=1 is required for this explicit study',
    );
  }

  const fixtures = readJsonl<Fixture>(fixturePath);
  if (fixtures.length === 0) throw new Error('fixture corpus is empty');
  const seen = new Set<string>();
  const out: string[] = [];

  for (const fixture of fixtures) {
    if (seen.has(fixture.id)) {
      throw new Error(`duplicate fixture id: ${fixture.id}`);
    }
    seen.add(fixture.id);

    const result = await runStopRequestStudyCase(fixture.message, {
      scopeId: 'stop_request_v1_study',
    });
    if (result.applied) {
      throw new Error(
        `safety violation: z0 stop result applied for ${fixture.id}`,
      );
    }

    out.push(JSON.stringify({
      schema: 'z0eval.agentweb_stop_request_result.v1',
      id: fixture.id,
      expected_stop: fixture.expected_stop,
      difficulty: fixture.difficulty,
      ...result,
    }));
    process.stderr.write(
      `${fixture.id}: expected=${fixture.expected_stop} ` +
      `incumbent=${result.incumbent_stop} p_stop=${result.p_stop ?? 'none'} ` +
      `receipt=${result.dispatch_receipt_id ?? 'none'}\n`,
    );
  }

  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, out.join('\n') + '\n');
  process.stderr.write(`wrote ${out.length} paired rows to ${resolved}\n`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
