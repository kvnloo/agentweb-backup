#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { runZ0RouteShadow } from '../services/z0RouteShadow';

interface Fixture {
  schema: string;
  id: string;
  task: string;
  turn_ordinal: number;
  expected_route: string;
  expected_executed: boolean;
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
    throw new Error('usage: ts-node --transpile-only run-z0-route-shadow-study.ts <fixtures> <results>');
  }

  const fixtures = readJsonl<Fixture>(fixturePath);
  const rows: string[] = [];

  for (const fixture of fixtures) {
    const rawSession = `route-study-${fixture.id}-raw-secret`;
    const result: any = await runZ0RouteShadow({
      sessionId: rawSession,
      task: fixture.task,
      turnOrdinal: fixture.turn_ordinal,
      env: {
        ...process.env,
        Z0_ROUTE_SHADOW: 'shadow',
        Z0INT_ROUTE_SHADOW_ALLOW: '1',
      },
    });

    const serialized = JSON.stringify(result);
    rows.push(JSON.stringify({
      schema: 'z0eval.agentweb_route_shadow_result.v1',
      id: fixture.id,
      expected_route: fixture.expected_route,
      ok: result?.ok === true,
      route_kind: result?.route?.kind ?? null,
      route_reason: result?.route?.reason ?? null,
      executed: result?.executed === true || result?.route?.executed === true,
      reconcile_required: result?.reconcile_required === true,
      trace_id: result?.trace_id ?? null,
      parent_agent: result?.parent_agent ?? null,
      raw_session_leak: serialized.includes(rawSession),
    }));
  }

  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, rows.join('\n') + '\n');
  process.stderr.write(`wrote ${rows.length} route-shadow rows to ${resolved}\n`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
