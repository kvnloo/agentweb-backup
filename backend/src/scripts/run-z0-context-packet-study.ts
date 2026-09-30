#!/usr/bin/env ts-node
/**
 * Manual deterministic replay for z0evals' AgentWeb context-packet corpus.
 * No model call is involved; this exercises the real AgentWeb privacy mapper
 * and the real z0 context compiler.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runZ0ContextPacketShadow } from '../services/z0ContextPacket';

interface FixtureResult {
  content: string;
  source: string;
  fileName?: string;
}
interface Fixture {
  schema: string;
  id: string;
  query: string;
  results: FixtureResult[];
  required_terms: string[];
  max_packet_bytes: number;
  has_more?: boolean;
  scan_incomplete?: boolean;
  expect_gap: boolean;
  expect_compress: boolean;
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
      'usage: npm run study:z0-context-packet -- <fixtures.jsonl> <results.jsonl>',
    );
  }
  const fixtures = readJsonl<Fixture>(fixturePath);
  if (fixtures.length === 0) throw new Error('fixture corpus is empty');

  const rows: string[] = [];
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (seen.has(fixture.id)) throw new Error(`duplicate fixture id: ${fixture.id}`);
    seen.add(fixture.id);

    const env = {
      ...process.env,
      Z0_CONTEXT_PACKET_SHADOW: 'shadow',
      Z0INT_CONTEXT_PACKET_ALLOW: '1',
      Z0INT_CONTEXT_PACKET_MAX_BYTES: String(fixture.max_packet_bytes),
    };
    const search = {
      success: true,
      query: fixture.query,
      results: fixture.results,
      returnedResults: fixture.results.length,
      hasMore: fixture.has_more === true,
      scanIncomplete: fixture.scan_incomplete === true,
    };
    const result: any = await runZ0ContextPacketShadow(
      fixture.query,
      search,
      {
        scopeId: 'context_packet_v1_study',
        env,
      },
    );
    if (result?.applied === true) {
      throw new Error(`safety violation: context packet applied for ${fixture.id}`);
    }

    const packet = result?.packet ?? {};
    const evidenceText = JSON.stringify(packet.evidence ?? []);
    const requiredTermsPreserved = fixture.required_terms.every(term =>
      evidenceText.includes(term),
    );
    const sensitiveLabels = fixture.results.flatMap(item => {
      const labels: string[] = [];
      if (item.fileName) labels.push(item.fileName);
      if (item.source.includes('/')) labels.push(item.source);
      return labels;
    });
    const sourceLabelLeak = sensitiveLabels.some(label =>
      JSON.stringify(packet).includes(label),
    );
    const measurements = packet.measurements ?? {};

    rows.push(JSON.stringify({
      schema: 'z0eval.agentweb_context_packet_result.v1',
      sample_source: 'fixture',
      id: fixture.id,
      ok: result?.ok === true,
      applied: result?.applied === true,
      expect_gap: fixture.expect_gap,
      expect_compress: fixture.expect_compress,
      required_terms_preserved: requiredTermsPreserved,
      source_label_leak: sourceLabelLeak,
      input_source_count: fixture.results.length,
      retained_source_count: Array.isArray(packet.evidence)
        ? packet.evidence.length
        : 0,
      source_diversity_target: measurements.source_diversity_target ?? null,
      source_diversity_degraded_for_budget:
        measurements.source_diversity_degraded_for_budget === true,
      unresolved_gap_count: Array.isArray(packet.unresolved_gaps)
        ? packet.unresolved_gaps.length
        : 0,
      input_content_bytes: measurements.input_content_bytes ?? null,
      packet_bytes: measurements.packet_bytes ?? null,
      max_packet_bytes: fixture.max_packet_bytes,
      compression_ratio: measurements.compression_ratio ?? null,
      truncated_excerpts: measurements.truncated_excerpts ?? null,
      network_model_calls: measurements.network_model_calls ?? null,
      private_text_persisted: measurements.private_text_persisted ?? null,
      z0_reason: result?.reason ?? null,
    }));
    process.stderr.write(
      `${fixture.id}: ok=${result?.ok === true} ` +
      `terms=${requiredTermsPreserved} packet=${measurements.packet_bytes ?? 'n/a'}/${fixture.max_packet_bytes}\n`,
    );
  }

  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, rows.join('\n') + '\n');
  process.stderr.write(`wrote ${rows.length} context rows to ${resolved}\n`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
