/**
 * ENG-2747 — every tool the Zoma toolkit advertises (Meta, Zoma onboarding, Google Ads) carries MCP
 * annotations, and the labels never understate what a call can do. Deny-by-default: only tools
 * named in READ_ONLY_TOOLKIT_TOOLS are read-only; anything unclassified is a destructive write.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

const mockAuthenticate = jest.fn();
class MockAuthError extends Error {
  status = 401;
}
jest.mock('../mcp/metaToolkitGateway', () => ({
  authenticateMetaToolkitCaller: (...a: unknown[]) => mockAuthenticate(...a),
  handleMetaToolkitCall: jest.fn(),
  MetaToolkitAuthError: MockAuthError,
}));

import router from '../routes/metaToolkit';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { getGoogleToolkitManifest } from '../mcp/googleToolkitManifest';
import { getXAdsToolkitManifest } from '../mcp/xAdsToolkitManifest';
import {
  annotateToolkitTools,
  getToolkitToolAnnotations,
  READ_ONLY_TOOLKIT_TOOLS,
  type ToolkitToolAnnotations,
} from '../mcp/toolkitToolAnnotations';

type Advertised = { name: string; annotations: ToolkitToolAnnotations };

const CONSERVATIVE: ToolkitToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

// Tools that read and write behind one name: a client must gate every call to them.
const MIXED = ['call_meta_marketing_api', 'zoma_custom_audiences', 'call_google_ads_api'];
// Not read-only, but narrower than the conservative default.
const NON_DESTRUCTIVE_WRITES = ['zoma_status', 'zoma_prepare_upload'];
// Read-only but not in the shared read set (no outside call).
const LOCAL_READS = ['ads_get_errors', 'ads_get_help_article', 'zoma_usage'];

function allAdvertised(): Advertised[] {
  return annotateToolkitTools([...getMetaToolkitManifest(), ...getGoogleToolkitManifest(), ...getXAdsToolkitManifest()]) as Advertised[];
}

describe('ENG-2747 Zoma toolkit tool annotations', () => {
  const prevGoogle = process.env.ZOMA_GOOGLE_ENABLED;
  afterAll(() => {
    if (prevGoogle === undefined) delete process.env.ZOMA_GOOGLE_ENABLED;
    else process.env.ZOMA_GOOGLE_ENABLED = prevGoogle;
  });

  it('gives every advertised tool all four boolean hints', () => {
    const tools = allAdvertised();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        expect(typeof t.annotations[k]).toBe('boolean');
      }
    }
  });

  it('labels exactly the classified reads as read-only, and nothing else', () => {
    const tools = allAdvertised();
    const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual([...READ_ONLY_TOOLKIT_TOOLS, ...LOCAL_READS].sort());
    for (const t of tools) {
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint).toBe(false);
    }
  });

  it('every name in the read-only set is actually advertised (no stale entries)', () => {
    const names = new Set(allAdvertised().map((t) => t.name));
    for (const n of READ_ONLY_TOOLKIT_TOOLS) expect(names.has(n)).toBe(true);
  });

  it('labels mixed read/write tools and every unclassified write as destructive', () => {
    const tools = allAdvertised();
    for (const name of MIXED) {
      expect(tools.find((t) => t.name === name)?.annotations).toEqual(CONSERVATIVE);
    }
    const classified = new Set([...READ_ONLY_TOOLKIT_TOOLS, ...LOCAL_READS, ...NON_DESTRUCTIVE_WRITES]);
    for (const t of tools.filter((x) => !classified.has(x.name))) {
      expect(t.annotations).toEqual(CONSERVATIVE);
    }
  });

  it('keeps the onboarding tools that mint links non-read-only but non-destructive', () => {
    for (const name of NON_DESTRUCTIVE_WRITES) {
      const a = getToolkitToolAnnotations(name);
      expect(a.readOnlyHint).toBe(false);
      expect(a.destructiveHint).toBe(false);
    }
  });

  it('defaults an unknown or new tool to the conservative label and never throws', () => {
    expect(getToolkitToolAnnotations('zoma_brand_new_write_tool')).toEqual(CONSERVATIVE);
    for (const inherited of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(getToolkitToolAnnotations(inherited)).toEqual(CONSERVATIVE);
    }
  });

  it('ignores annotations a definition declares inline', () => {
    const [t] = annotateToolkitTools([
      { name: 'meta_delete_product', annotations: { readOnlyHint: true, destructiveHint: false } },
    ]);
    expect(t.annotations).toEqual(CONSERVATIVE);
  });

  it('returns a fresh annotations object per call', () => {
    const a = getToolkitToolAnnotations('list_meta_ads_campaigns');
    a.readOnlyHint = false;
    expect(getToolkitToolAnnotations('list_meta_ads_campaigns').readOnlyHint).toBe(true);
  });

  it.each([
    ['without Google', 'false'],
    ['with Google', 'true'],
  ])('GET /tools and MCP tools/list both advertise annotations (%s)', async (_label, google) => {
    process.env.ZOMA_GOOGLE_ENABLED = google;
    mockAuthenticate.mockResolvedValue({ userId: 'u1', authMethod: 'api_key' });
    const app = express();
    app.use(express.json());
    app.use('/api/meta-toolkit', router);

    const rest = await request(app).get('/api/meta-toolkit/tools').set('Authorization', 'Bearer aw_x').expect(200);
    const rpc = await request(app)
      .post('/api/meta-toolkit/mcp')
      .set('Authorization', 'Bearer aw_x')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);

    for (const tools of [rest.body.tools, rpc.body.result.tools] as Advertised[][]) {
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean')).toBe(true);
      expect(tools.find((t) => t.name === 'call_meta_marketing_api')?.annotations).toEqual(CONSERVATIVE);
      expect(tools.find((t) => t.name === 'list_meta_ads_campaigns')?.annotations.readOnlyHint).toBe(true);
      expect(tools.find((t) => t.name === 'zoma_status')?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(tools.find((t) => t.name === 'zoma_usage')?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tools.some((t) => t.name === 'call_google_ads_api')).toBe(google === 'true');
    }
  });
});
