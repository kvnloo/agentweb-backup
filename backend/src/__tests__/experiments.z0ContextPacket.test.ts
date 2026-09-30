import {
  buildZ0ContextPacketRequest,
  runZ0ContextPacketShadow,
  type AgentWebKnowledgeSearchResult,
  type Z0ContextPacketOptions,
} from '../services/z0ContextPacket';
import type { Z0FetchLike } from '../emma/z0Adapter';

const search: AgentWebKnowledgeSearchResult = {
  success: true,
  query: 'brand positioning',
  results: [
    {
      content: 'Brand voice: practical and technical.',
      source: 'private-knowledge-base',
      fileName: 'Secret Strategy.docx',
    },
    {
      content: 'Market notes for agent teams.',
      source: 'google-drive/Private Folder/Market.md',
    },
  ],
  returnedResults: 2,
  hasMore: false,
};

function response(payload: unknown, status = 200): Z0FetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as Z0FetchLike;
}

describe('z0 context packet shadow', () => {
  it('hashes private source names before transport', () => {
    const request = buildZ0ContextPacketRequest(
      'brand positioning',
      search,
      'raw-user-id',
      {} as NodeJS.ProcessEnv,
    );
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('Secret Strategy.docx');
    expect(serialized).not.toContain('Private Folder');
    expect(serialized).not.toContain('raw-user-id');
    expect(request.parent_agent).toMatch(/^agentweb:[a-f0-9]{24}$/);
    expect(request.evidence).toHaveLength(2);
    expect(request.evidence[0].source_id).toMatch(/^agentweb-kb:[a-f0-9]{64}$/);
    expect(request.evidence[0].source_version).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(request.evidence[0].source_kind).toBe('private-knowledge-base');
    expect(request.evidence[1].source_kind).toBe('google-drive');
  });

  it('keeps content local when the boundary is not explicitly authorized', async () => {
    const fetchImpl = jest.fn() as unknown as Z0FetchLike;
    const result = await runZ0ContextPacketShadow(
      'brand positioning',
      search,
      {
        scopeId: 'raw-user-id',
        env: { Z0_CONTEXT_PACKET_SHADOW: 'shadow' } as NodeJS.ProcessEnv,
        fetchImpl,
      },
    );
    expect(result).toMatchObject({
      ok: false,
      applied: false,
      reason: 'context_boundary_not_authorized',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends only bounded preselected evidence to the z0 context compiler', async () => {
    const fetchImpl = response({
      ok: true,
      mode: 'shadow',
      applied: false,
      packet: {
        schema: 'z0int.context_resolve.v1',
        evidence: [{ source_id: 'agentweb-kb:' + 'a'.repeat(64) }],
        unresolved_gaps: [],
        measurements: {
          input_content_bytes: 64,
          packet_bytes: 800,
          compression_ratio: 0.5,
          network_model_calls: 0,
          private_text_persisted: false,
        },
      },
    });
    const result = await runZ0ContextPacketShadow(
      'brand positioning',
      search,
      {
        scopeId: 'raw-user-id',
        env: {
          Z0_CONTEXT_PACKET_SHADOW: 'shadow',
          Z0INT_CONTEXT_PACKET_ALLOW: '1',
          Z0INT_SERVICE_URL: 'http://z0.test',
          Z0INT_CONTEXT_PACKET_MAX_BYTES: '6000',
        } as NodeJS.ProcessEnv,
        fetchImpl,
      },
    );
    expect(result).toMatchObject({ ok: true, applied: false });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('http://z0.test/v1/context/pack');
    const body = JSON.parse(init.body);
    expect(body.max_packet_bytes).toBe(6000);
    expect(body.needs).toEqual([
      { id: 'q0', description: 'brand positioning', required: true },
    ]);
    expect(JSON.stringify(body)).not.toContain('Secret Strategy.docx');
    expect(JSON.stringify(body)).not.toContain('raw-user-id');
  });

  it('marks a capped or incomplete search as non-exhaustive', () => {
    const request = buildZ0ContextPacketRequest(
      'market',
      { ...search, hasMore: true },
      'scope',
    );
    expect(request.scan_incomplete).toBe(true);
  });

  it('skips failed KB searches without calling z0', async () => {
    const fetchImpl = jest.fn() as unknown as Z0FetchLike;
    const result = await runZ0ContextPacketShadow(
      'brand positioning',
      { success: false, results: [] },
      {
        scopeId: 'scope',
        env: {
          Z0_CONTEXT_PACKET_SHADOW: 'shadow',
          Z0INT_CONTEXT_PACKET_ALLOW: '1',
        } as NodeJS.ProcessEnv,
        fetchImpl,
      },
    );
    expect(result.reason).toBe('search_failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
