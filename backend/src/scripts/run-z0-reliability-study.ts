#!/usr/bin/env ts-node
/**
 * Cross-repo reliability observation campaign.
 * Exercises AgentWeb's real privacy projection/exporter against a live local z0 service.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildReliabilityEvent,
  type ReliabilityOutcome,
} from '../services/reliabilityEvent';
import { projectReliabilityEventToZ0 } from '../services/z0ReliabilityProjection';
import { exportReliabilityEventToZ0Safe } from '../services/z0ReliabilityExporter';

interface Fixture {
  schema: string;
  id: string;
  tool: string;
  outcome: ReliabilityOutcome;
  latency_ms: number;
  raw_session_id: string;
  raw_user_id: string;
  error_summary: string;
  platform: string;
  at: string;
  expected_execution_completed: boolean;
  expected_tool_ok: boolean;
  expected_success?: boolean;
  expected_user_refused?: boolean;
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
      'usage: npm run study:z0-reliability -- <fixtures.jsonl> <results.jsonl>',
    );
  }
  const fixtures = readJsonl<Fixture>(fixturePath);
  if (fixtures.length === 0) throw new Error('fixture corpus is empty');

  const env = {
    ...process.env,
    Z0INT_AGENTWEB_OBSERVE: 'shadow',
  } as NodeJS.ProcessEnv;
  const rows: string[] = [];
  const seen = new Set<string>();

  for (const fixture of fixtures) {
    if (seen.has(fixture.id)) throw new Error(`duplicate fixture id: ${fixture.id}`);
    seen.add(fixture.id);

    const event = buildReliabilityEvent({
      tool: fixture.tool,
      outcome: fixture.outcome,
      latencyMs: fixture.latency_ms,
      sessionId: fixture.raw_session_id,
      userId: fixture.raw_user_id,
      errorSummary: fixture.error_summary,
      platform: fixture.platform,
      at: fixture.at,
    });
    const projection: any = projectReliabilityEventToZ0(event);
    const serialized = JSON.stringify(projection);
    const privacyOk =
      !serialized.includes(fixture.raw_session_id) &&
      !serialized.includes(fixture.raw_user_id) &&
      !serialized.includes(fixture.error_summary) &&
      /^agentweb:[a-f0-9]{24}$/.test(projection.session_id ?? '') &&
      projection.outcome?.verified_success === undefined &&
      projection.outcome?.verification_source === undefined;

    const first = await exportReliabilityEventToZ0Safe(event, { env });
    const second = await exportReliabilityEventToZ0Safe(event, { env });

    const expected: Record<string, boolean> = {
      execution_completed: fixture.expected_execution_completed,
      tool_ok: fixture.expected_tool_ok,
    };
    if (fixture.expected_success !== undefined) {
      expected.success = fixture.expected_success;
    }
    if (fixture.expected_user_refused !== undefined) {
      expected.user_refused = fixture.expected_user_refused;
    }

    rows.push(JSON.stringify({
      schema: 'z0eval.agentweb_reliability_result.v1',
      id: fixture.id,
      trace_id: projection.trace_id,
      outcome: fixture.outcome,
      first_exported: first.exported,
      first_reason: first.reason,
      second_exported: second.exported,
      second_reason: second.reason,
      second_replayed: second.replayed === true,
      projection_privacy_ok: privacyOk,
      expected,
    }));

    process.stderr.write(
      `${fixture.id}: first=${first.reason} second=${second.reason} privacy=${privacyOk}\n`,
    );
  }

  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, rows.join('\n') + '\n');
  process.stderr.write(`wrote ${rows.length} reliability rows to ${resolved}\n`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
