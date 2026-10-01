#!/usr/bin/env ts-node
import * as fs from 'fs';
import {
  exportEvidenceContextPackToZ0Safe,
  projectEvidenceContextPackToZ0,
} from '../services/z0EvidenceProvenance';

const input = {
  traceId: 'ctx-provenance-1',
  parentAgent: `agentweb:${'a'.repeat(24)}`,
  taskId: 'task-provenance-1',
  needs: [
    { id: 'brand', description: 'brand strategy positioning', required: true },
  ],
  evidence: [
    {
      rawSourceId: 'drive-file-123',
      rawLocator: 'https://drive.google.com/file/d/drive-file-123?access_token=RAW-SECRET-TOKEN',
      sourceKind: 'google-drive' as const,
      retrievedAt: '2026-10-01T11:30:00-05:00',
      content: 'Brand strategy: emphasize speed, technical credibility, and practical outcomes.',
      needIds: ['brand'],
      metadata: {
        title: 'Brand Strategy',
        mimeType: 'text/plain',
      },
    },
  ],
  scanIncomplete: false,
  maxPacketBytes: 6000,
};

async function main() {
  const output = process.argv[2] ?? '/tmp/z0-evidence-provenance-study.json';
  const baseUrl = process.env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501';
  const env = {
    ...process.env,
    Z0INT_AGENTWEB_CONTEXT_PACK: 'shadow',
    Z0INT_SERVICE_URL: baseUrl,
  } as NodeJS.ProcessEnv;

  const projected = projectEvidenceContextPackToZ0(input);
  const projectedText = JSON.stringify(projected);
  for (const forbidden of [
    'drive-file-123',
    'drive.google.com',
    'RAW-SECRET-TOKEN',
    'access_token',
  ]) {
    if (projectedText.includes(forbidden)) {
      throw new Error(`raw connector material leaked: ${forbidden}`);
    }
  }

  const firstSource = projected.evidence[0];
  const packed = await exportEvidenceContextPackToZ0Safe(input, { env });
  if (!packed.exported || packed.reason !== 'packed') {
    throw new Error(`context pack failed: ${JSON.stringify(packed)}`);
  }

  const packet = packed.packet as any;
  const evidence = packet?.evidence?.[0];
  const aodl = packet?.aodl_projection?.contextEvidence?.[0];

  if (!evidence) throw new Error('packed evidence missing');
  if (evidence.observed_at !== input.evidence[0].retrievedAt) {
    throw new Error('retrieval timestamp was not preserved');
  }
  if (evidence.source_version !== firstSource.source_version) {
    throw new Error('source version changed across pack');
  }
  if (!String(evidence.note ?? '').includes(`content_sha256=${firstSource.content_sha256}`)) {
    throw new Error('content digest missing from structural provenance');
  }
  if (!aodl || aodl.observed_at !== evidence.observed_at || aodl.note !== evidence.note) {
    throw new Error('AODL structural provenance mismatch');
  }
  if ('excerpt' in aodl) {
    throw new Error('AODL projection duplicated private excerpt text');
  }
  if (packet.measurements?.provenance_verified_count !== 1) {
    throw new Error('provenance verification measurement missing');
  }
  if (packet.measurements?.network_model_calls !== 0) {
    throw new Error('context packing unexpectedly used a model');
  }
  if (packet.measurements?.private_text_persisted !== false) {
    throw new Error('context pack persistence invariant changed');
  }

  const changedProjected = projectEvidenceContextPackToZ0({
    ...input,
    evidence: [
      {
        ...input.evidence[0],
        content: input.evidence[0].content + ' Updated source version.',
      },
    ],
  });
  if (changedProjected.evidence[0].source_id !== firstSource.source_id) {
    throw new Error('source identity changed when only content changed');
  }
  if (changedProjected.evidence[0].source_version === firstSource.source_version) {
    throw new Error('changed content did not produce a new source version');
  }

  const tampered = JSON.parse(JSON.stringify(projected));
  tampered.evidence[0].content_sha256 = '0'.repeat(64);
  const tamperedResponse = await fetch(`${baseUrl}/v1/context/pack`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(tampered),
  });
  if (tamperedResponse.status !== 400) {
    throw new Error(`tampered digest was not rejected: HTTP ${tamperedResponse.status}`);
  }

  const result = {
    schema: 'z0eval.agentweb_evidence_provenance_e2e.v1',
    projected: {
      source_id: firstSource.source_id,
      source_version: firstSource.source_version,
      locator: firstSource.locator,
      retrieved_at: firstSource.retrieved_at,
      content_sha256: firstSource.content_sha256,
    },
    packet: {
      source_id: evidence.source_id,
      source_version: evidence.source_version,
      locator: evidence.locator,
      observed_at: evidence.observed_at,
      note: evidence.note,
      aodl_excerpt_present: Boolean(aodl && 'excerpt' in aodl),
      packet_bytes: packet.measurements.packet_bytes,
      provenance_verified_count: packet.measurements.provenance_verified_count,
      network_model_calls: packet.measurements.network_model_calls,
      private_text_persisted: packet.measurements.private_text_persisted,
    },
    changed_source_version: changedProjected.evidence[0].source_version,
    tampered_status: tamperedResponse.status,
  };

  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  process.stderr.write('z0 evidence provenance study passed\n');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
