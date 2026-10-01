import {
  exportEvidenceContextPackToZ0Safe,
  projectEvidenceContextPackToZ0,
  projectEvidenceSourceToZ0,
  validateLocalEvidenceMetadata,
  type Z0EvidenceFetchLike,
} from '../services/z0EvidenceProvenance';

const source = {
  rawSourceId: 'drive-file-123',
  rawLocator: 'https://drive.google.com/file/d/drive-file-123?token=SECRET',
  sourceKind: 'google-drive' as const,
  retrievedAt: '2026-10-01T17:00:00Z',
  content: 'Brand strategy says speed and technical credibility matter.',
  needIds: ['brand'],
  metadata: {
    title: 'Strategy',
    mimeType: 'text/plain',
  },
};

const pack = {
  traceId: 'ctx-trace-1',
  parentAgent: `agentweb:${'a'.repeat(24)}`,
  taskId: 'ctx-task-1',
  needs: [
    { id: 'brand', description: 'brand strategy', required: true },
  ],
  evidence: [source],
  scanIncomplete: false,
  maxPacketBytes: 6000,
};

function response(payload: unknown, status = 200): Z0EvidenceFetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as Z0EvidenceFetchLike;
}

describe('z0 evidence provenance projection', () => {
  it('projects pseudonymous source identity and exact content digest', () => {
    const projected = projectEvidenceSourceToZ0(source);
    const serialized = JSON.stringify(projected);

    expect(projected.source_id).toMatch(/^agentweb-kb:[a-f0-9]{64}$/);
    expect(projected.locator).toMatch(/^agentweb-kb:\/\/[a-f0-9]{64}$/);
    expect(projected.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(projected.source_version).toBe(`sha256:${projected.content_sha256}`);
    expect(projected.retrieved_at).toBe(source.retrievedAt);

    expect(serialized).not.toContain('drive-file-123');
    expect(serialized).not.toContain('drive.google.com');
    expect(serialized).not.toContain('SECRET');
  });

  it('keeps source identity stable while changed content gets a new version', () => {
    const first = projectEvidenceSourceToZ0(source);
    const changed = projectEvidenceSourceToZ0({
      ...source,
      content: source.content + ' Updated.',
    });

    expect(changed.source_id).toBe(first.source_id);
    expect(changed.locator).toBe(first.locator);
    expect(changed.content_sha256).not.toBe(first.content_sha256);
    expect(changed.source_version).not.toBe(first.source_version);
  });

  it('rejects credential/raw identity shaped local metadata before transport', () => {
    expect(validateLocalEvidenceMetadata({
      nested: {
        authorization: 'Bearer secret',
        sessionId: 'raw-session',
      },
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('authorization'),
      expect.stringContaining('sessionId'),
    ]));

    expect(() => projectEvidenceSourceToZ0({
      ...source,
      metadata: {
        nested: {
          apiKey: 'secret',
        },
      },
    })).toThrow(/metadata isolation failed/);
  });

  it('allows prose content that discusses credentials', () => {
    expect(() => projectEvidenceSourceToZ0({
      ...source,
      content: 'Docs explain that an Authorization header can contain an API key.',
    })).not.toThrow();
  });

  it('builds a context request with no raw connector identity or generic metadata', () => {
    const projected = projectEvidenceContextPackToZ0(pack);
    const serialized = JSON.stringify(projected);

    expect(projected.harness).toBe('agentweb');
    expect(projected.evidence).toHaveLength(1);
    expect(projected.evidence[0].retrieved_at).toBe(source.retrievedAt);
    expect(serialized).not.toContain('drive-file-123');
    expect(serialized).not.toContain('drive.google.com');
    expect(serialized).not.toContain('"metadata"');
  });

  it('is default-off and makes no request', async () => {
    const fetchImpl = jest.fn() as unknown as Z0EvidenceFetchLike;
    const result = await exportEvidenceContextPackToZ0Safe(pack, {
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(result).toEqual({ exported: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exports the projected provenance contract to the context pack endpoint', async () => {
    const fetchImpl = response({
      ok: true,
      mode: 'shadow',
      applied: false,
      packet: {
        schema: 'z0int.context_resolve.v1',
        evidence: [],
      },
    });
    const result = await exportEvidenceContextPackToZ0Safe(pack, {
      env: {
        Z0INT_AGENTWEB_CONTEXT_PACK: 'shadow',
        Z0INT_SERVICE_URL: 'http://z0.test/',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result.exported).toBe(true);
    expect(result.reason).toBe('packed');
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('http://z0.test/v1/context/pack');
    const body = JSON.parse(String(init.body));
    expect(body.evidence[0].retrieved_at).toBe(source.retrievedAt);
    expect(body.evidence[0].content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain('drive-file-123');
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });
});
