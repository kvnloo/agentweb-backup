/**
 * ENG-326 — services/agentMode/brandLogo unit tests.
 *
 * The module owns deterministic brand-logo handling:
 *   - getPersistedBrandLogoUrl: resolve the persisted logo off a
 *     brandGuidelines object (attachments `logo` asset wins → brandData
 *     .logoUrl → legacy brandAssets)
 *   - getPersistedBrandLogoUrlForUser: org-aware lookup by userId
 *   - promptRequestsLogo: does an image prompt ask for a logo (with a
 *     negation guard so "no logo" doesn't trigger)
 *   - missingBrandLogoToolResult: the AC-3 ask-the-user tool result
 *   - downloadBrandLogoToS3: the download + S3 persist block extracted from
 *     agentModeService.extractCSSFromURL (behavior-preserving)
 *   - ensureBrandLogoPersisted: the deterministic post-scrape onboarding
 *     step (AC-1)
 */

jest.mock('axios');
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3WithPath: jest.fn(),
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

import axios from 'axios';
import {
  MISSING_BRAND_LOGO_ERROR,
  classifyBrandLogoUrl,
  downloadBrandLogoToS3,
  ensureBrandLogoPersisted,
  getPersistedBrandLogoUrl,
  getPersistedBrandLogoUrlForUser,
  missingBrandLogoToolResult,
  promptCreatesLogo,
  promptRequestsLogo,
} from '../services/agentMode/brandLogo';

const s3Utils = require('../utils/s3Utils');
const { userDb, orgDb } = require('../services/db');

const mockedAxiosGet = axios.get as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getPersistedBrandLogoUrl', () => {
  it('returns brandData.logoUrl when present', () => {
    expect(
      getPersistedBrandLogoUrl({
        brandData: { logoUrl: 'https://s3.example.com/logo.png' },
      }),
    ).toBe('https://s3.example.com/logo.png');
  });

  it('prefers the uploaded attachments logo over a scraped brandData.logoUrl', () => {
    // An explicit brand-config upload lands only on attachments; a stale
    // scraped URL can linger on brandData.logoUrl. The upload must win —
    // generation composites the logo the user sees in brand config.
    expect(
      getPersistedBrandLogoUrl({
        brandData: { logoUrl: 'https://acme.com/stale-scraped.png' },
        attachments: [
          { type: 'logo', url: 'https://s3.example.com/uploaded.png' },
        ],
      }),
    ).toBe('https://s3.example.com/uploaded.png');
  });

  it('falls back to the attachments logo asset (the canonical asset store)', () => {
    expect(
      getPersistedBrandLogoUrl({
        brandData: { brandName: 'Acme' },
        attachments: [
          { type: 'brandGuide', url: 'https://x/guide.pdf' },
          { type: 'logo', url: 'https://s3.example.com/att-logo.png' },
        ],
      }),
    ).toBe('https://s3.example.com/att-logo.png');
  });

  it('falls back to the legacy brandAssets array', () => {
    expect(
      getPersistedBrandLogoUrl({
        brandAssets: [{ type: 'logo', url: 'https://s3.example.com/legacy.png' }],
      }),
    ).toBe('https://s3.example.com/legacy.png');
  });

  it('returns null for empty / missing / malformed inputs', () => {
    expect(getPersistedBrandLogoUrl(null)).toBeNull();
    expect(getPersistedBrandLogoUrl(undefined)).toBeNull();
    expect(getPersistedBrandLogoUrl({})).toBeNull();
    expect(getPersistedBrandLogoUrl({ brandData: { logoUrl: '   ' } })).toBeNull();
    expect(
      getPersistedBrandLogoUrl({
        attachments: [{ type: 'logo' }, { type: 'asset', url: 'https://x/a.png' }],
      }),
    ).toBeNull();
  });
});

describe('getPersistedBrandLogoUrlForUser (org-aware)', () => {
  it('reads the solo user record', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      brandGuidelines: { brandData: { logoUrl: 'https://s3/logo.png' } },
    });

    await expect(getPersistedBrandLogoUrlForUser('u1')).resolves.toBe(
      'https://s3/logo.png',
    );
    expect(orgDb.getOrgById).not.toHaveBeenCalled();
  });

  it('prefers the org brandGuidelines for org members', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      orgId: 'org1',
      brandGuidelines: { brandData: { logoUrl: 'https://s3/stale-user.png' } },
    });
    orgDb.getOrgById.mockResolvedValue({
      brandGuidelines: { brandData: { logoUrl: 'https://s3/org-logo.png' } },
    });

    await expect(getPersistedBrandLogoUrlForUser('u1')).resolves.toBe(
      'https://s3/org-logo.png',
    );
  });

  it('returns null when the user does not exist', async () => {
    userDb.getUserById.mockResolvedValue(null);
    await expect(getPersistedBrandLogoUrlForUser('ghost')).resolves.toBeNull();
  });
});

describe('promptRequestsLogo', () => {
  it('detects prompts asking for a logo', () => {
    expect(promptRequestsLogo('Launch banner with our logo top-left')).toBe(true);
    expect(promptRequestsLogo('Place the company Logo on the cover')).toBe(true);
    expect(promptRequestsLogo('Event cover with brand logos of both partners')).toBe(true);
  });

  it('ignores prompts that do not mention a logo', () => {
    expect(promptRequestsLogo('A clean product launch graphic')).toBe(false);
    expect(promptRequestsLogo('')).toBe(false);
    expect(promptRequestsLogo(undefined as any)).toBe(false);
  });

  it('ignores negated logo mentions', () => {
    expect(promptRequestsLogo('Minimal poster, no logo')).toBe(false);
    expect(promptRequestsLogo('Hero image without any logos')).toBe(false);
    expect(promptRequestsLogo('Abstract background — omit the logo entirely')).toBe(false);
    expect(promptRequestsLogo('without a company logo')).toBe(false);
    expect(promptRequestsLogo('do not include the logo')).toBe(false);
    expect(promptRequestsLogo("don't show our logo")).toBe(false);
  });

  it('does NOT swallow positive logo asks that merely have a negation nearby', () => {
    // Reviewer cases (finding #4): each of these asks FOR the logo — the
    // negation modifies something else. A false negative here means the model
    // is free to invent a logo again (AC-2/AC-3 violated).
    expect(promptRequestsLogo('no text, just our logo front and center')).toBe(true);
    expect(promptRequestsLogo('Do not crop the logo')).toBe(true);
    expect(promptRequestsLogo('skip the border, add the logo')).toBe(true);
  });
});

describe('promptCreatesLogo (ENG-393 — logo CREATION vs COMPOSITING)', () => {
  it('detects prompts asking to CREATE a brand-new logo from scratch', () => {
    // These are first-logo asks: the account has no logo yet and legitimately
    // wants generate_image to design one. They must NOT hit the missing-logo
    // gate (which exists to stop the model inventing a copy of a logo the
    // brand already owns — not to block designing a first logo).
    expect(promptCreatesLogo('Create a logo for AgentCapX, a modern fintech brand')).toBe(true);
    expect(promptCreatesLogo('Design a minimalist logo for my startup')).toBe(true);
    expect(promptCreatesLogo('Make me a clean logo, blue and white')).toBe(true);
    expect(promptCreatesLogo('Generate a new logo, modern and bold')).toBe(true);
    expect(promptCreatesLogo('I need a logo for our coffee shop')).toBe(true);
    expect(promptCreatesLogo('come up with a logo concept')).toBe(true);
  });

  it('detects logo-noun creation phrases (logo for / logo design / logo concept)', () => {
    expect(promptCreatesLogo('a logo for AgentCapX')).toBe(true);
    expect(promptCreatesLogo('logo design for a coffee shop')).toBe(true);
    expect(promptCreatesLogo('sketch some logo options')).toBe(true);
    expect(promptCreatesLogo('logo concepts from scratch')).toBe(true);
  });

  it('does NOT treat compositing an EXISTING brand logo as creation (still gates)', () => {
    // These place/feature the account's real logo on a larger design — the
    // ENG-326 gate must still fire for them. A false-positive here would let
    // the model invent a fake copy of the brand's real logo (AC-2/AC-3 hole).
    expect(promptCreatesLogo('Launch banner with our logo top-left')).toBe(false);
    expect(promptCreatesLogo('Event cover featuring the company logo')).toBe(false);
    expect(promptCreatesLogo('Place the company logo on the cover')).toBe(false);
    expect(promptCreatesLogo('Add our brand logo to this launch banner')).toBe(false);
    expect(promptCreatesLogo('Social banner with the brand logo')).toBe(false);
    // "generate an image WITH our logo" is compositing, not logo creation.
    expect(promptCreatesLogo('generate an image with our logo in the corner')).toBe(false);
  });

  it('ignores prompts that do not mention a logo, and empty/nullish input', () => {
    expect(promptCreatesLogo('Create a product launch graphic')).toBe(false);
    expect(promptCreatesLogo('A clean poster, no logo')).toBe(false);
    expect(promptCreatesLogo('')).toBe(false);
    expect(promptCreatesLogo(undefined as any)).toBe(false);
  });
});

describe('missingBrandLogoToolResult', () => {
  it('is a non-generating ask-the-user result pointing at brand config (AC-3)', () => {
    const result = missingBrandLogoToolResult();
    expect(result.success).toBe(false);
    expect(result.error).toBe(MISSING_BRAND_LOGO_ERROR);
    expect(result.askUser).toBe(true);
    expect(result.message).toMatch(/brand guidelines/i);
    expect(result.message).toMatch(/do not generate/i);
    expect(result.message).toMatch(/ask the user/i);
  });
});

describe('downloadBrandLogoToS3 (extracted from extractCSSFromURL — discriminated outcome)', () => {
  it('downloads a raster logo and uploads it under users/{userId}/brand/logo', async () => {
    mockedAxiosGet.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      data: new ArrayBuffer(8),
    });
    s3Utils.uploadFileToS3WithPath.mockResolvedValue({
      success: true,
      url: 'https://s3.example.com/users/u1/brand/logo/logo.png',
    });

    await expect(
      downloadBrandLogoToS3('https://acme.com/logo.png', 'u1'),
    ).resolves.toEqual({
      status: 'uploaded',
      url: 'https://s3.example.com/users/u1/brand/logo/logo.png',
    });

    expect(mockedAxiosGet).toHaveBeenCalledWith('https://acme.com/logo.png', {
      responseType: 'arraybuffer',
      timeout: 15000,
    });
    expect(s3Utils.uploadFileToS3WithPath).toHaveBeenCalledWith(
      expect.any(Buffer),
      'logo.png',
      'image/png',
      'users/u1/brand/logo',
    );
  });

  it('maps gif/jpeg content types to the right filename extension', async () => {
    mockedAxiosGet.mockResolvedValue({
      headers: { 'content-type': 'image/gif' },
      data: new ArrayBuffer(4),
    });
    s3Utils.uploadFileToS3WithPath.mockResolvedValue({
      success: true,
      url: 'https://s3/logo.gif',
    });

    await downloadBrandLogoToS3('https://acme.com/logo.gif', 'u1');
    expect(s3Utils.uploadFileToS3WithPath).toHaveBeenCalledWith(
      expect.any(Buffer),
      'logo.gif',
      'image/gif',
      'users/u1/brand/logo',
    );
  });

  it('reports svg for SVG logos (no upload) — even from an extensionless URL', async () => {
    mockedAxiosGet.mockResolvedValue({
      headers: { 'content-type': 'image/svg+xml' },
      data: new ArrayBuffer(8),
    });

    await expect(
      downloadBrandLogoToS3('https://acme.com/logo.svg', 'u1'),
    ).resolves.toEqual({ status: 'svg' });
    // An SVG served from an extensionless URL is still an SVG — the
    // content-type is the truth, not the extension.
    await expect(
      downloadBrandLogoToS3('https://acme.com/logo', 'u1'),
    ).resolves.toEqual({ status: 'svg' });
    expect(s3Utils.uploadFileToS3WithPath).not.toHaveBeenCalled();
  });

  it('reports download-failed (with detail) on download failure without throwing', async () => {
    mockedAxiosGet.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(
      downloadBrandLogoToS3('https://acme.com/logo.png', 'u1'),
    ).resolves.toEqual({ status: 'download-failed', detail: 'ETIMEDOUT' });
    expect(s3Utils.uploadFileToS3WithPath).not.toHaveBeenCalled();
  });

  it('reports upload-failed when the S3 upload reports failure', async () => {
    mockedAxiosGet.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      data: new ArrayBuffer(8),
    });
    s3Utils.uploadFileToS3WithPath.mockResolvedValue({
      success: false,
      error: 'AccessDenied',
    });
    await expect(
      downloadBrandLogoToS3('https://acme.com/logo.png', 'u1'),
    ).resolves.toEqual({ status: 'upload-failed', detail: 'AccessDenied' });
  });

  it('reports upload-failed when the S3 upload throws', async () => {
    mockedAxiosGet.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      data: new ArrayBuffer(8),
    });
    s3Utils.uploadFileToS3WithPath.mockRejectedValue(new Error('socket hang up'));
    await expect(
      downloadBrandLogoToS3('https://acme.com/logo.png', 'u1'),
    ).resolves.toEqual({ status: 'upload-failed', detail: 'socket hang up' });
  });
});

describe('ensureBrandLogoPersisted (deterministic onboarding step — AC-1)', () => {
  const baseDeps = () => ({
    resolveBrand: jest.fn().mockResolvedValue(null),
    discoverLogoUrl: jest.fn().mockResolvedValue('https://acme.com/logo.png'),
    download: jest
      .fn()
      .mockResolvedValue({ status: 'uploaded', url: 'https://s3/brand/logo.png' }),
    persist: jest.fn().mockResolvedValue({ success: true }),
    // Injected so the existing-logo probe (ENG-792) stays hermetic — without
    // it these cases would make a real network call for the fixture URL.
    classifyExisting: jest.fn().mockResolvedValue('usable' as const),
  });

  it('skips when a logo is already persisted AND still loads (Emma did her job)', async () => {
    const deps = baseDeps();
    deps.resolveBrand.mockResolvedValue({
      brandData: { logoUrl: 'https://s3/already.png' },
    });

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    expect(out).toEqual({
      persisted: false,
      logoUrl: 'https://s3/already.png',
      reason: 'already-present',
    });
    expect(deps.classifyExisting).toHaveBeenCalledWith('https://s3/already.png');
    expect(deps.discoverLogoUrl).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('rediscovers when the persisted logo is definitively broken (ENG-792)', async () => {
    // The reported account: Emma wrote a google.com/s2/favicons URL for a site
    // whose logo is inline SVG, and it 404s. Structurally "present", so this
    // step used to short-circuit and every ad-image run then died on it.
    const deps = baseDeps();
    deps.resolveBrand.mockResolvedValue({
      brandData: {
        logoUrl: 'https://www.google.com/s2/favicons?domain=dramabreak.ai&sz=128',
      },
    });
    deps.classifyExisting.mockResolvedValue('broken' as const);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    warnSpy.mockRestore();
    expect(deps.discoverLogoUrl).toHaveBeenCalledWith('https://acme.com');
    expect(out.persisted).toBe(true);
    expect(out.logoUrl).toBe('https://s3/brand/logo.png');
    expect(out.reason).toBe('persisted');
  });

  it('KEEPS a persisted logo when the probe is inconclusive (no transient overwrite)', async () => {
    // A timeout/5xx must never cost an account its real logo.
    const deps = baseDeps();
    deps.resolveBrand.mockResolvedValue({
      brandData: { logoUrl: 'https://s3/real-uploaded-logo.png' },
    });
    deps.classifyExisting.mockResolvedValue('unknown' as const);

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    expect(out.reason).toBe('already-present');
    expect(out.logoUrl).toBe('https://s3/real-uploaded-logo.png');
    expect(deps.discoverLogoUrl).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('leaves a broken persisted logo alone when rediscovery finds nothing', async () => {
    // Falling through must not make things worse: if there is no replacement,
    // we report no-logo-found and never persist a second broken value. The
    // ad-image preflight is what surfaces this to the user.
    const deps = baseDeps();
    deps.resolveBrand.mockResolvedValue({
      brandData: { logoUrl: 'https://dead/logo.png' },
    });
    deps.classifyExisting.mockResolvedValue('broken' as const);
    deps.discoverLogoUrl.mockResolvedValue(null);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    warnSpy.mockRestore();
    expect(out.reason).toBe('no-logo-found');
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('discovers, downloads, and persists the logo when Emma left none', async () => {
    const deps = baseDeps();

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    expect(deps.discoverLogoUrl).toHaveBeenCalledWith('https://acme.com');
    expect(deps.download).toHaveBeenCalledWith('https://acme.com/logo.png', 'u1');
    expect(deps.persist).toHaveBeenCalledWith(
      'u1',
      'https://s3/brand/logo.png',
      'logo.png',
    );
    expect(out.persisted).toBe(true);
    expect(out.logoUrl).toBe('https://s3/brand/logo.png');
    expect(out.reason).toBe('persisted');
  });

  it('persists the raw discovered URL only when the download proved raster bytes and just the S3 pin failed', async () => {
    const deps = baseDeps();
    deps.download.mockResolvedValue({ status: 'upload-failed', detail: 'AccessDenied' });

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    expect(deps.persist).toHaveBeenCalledWith(
      'u1',
      'https://acme.com/logo.png',
      'logo.png',
    );
    expect(out.persisted).toBe(true);
  });

  it('does NOT persist an unverified URL when the download itself failed (dead/hotlink-protected link)', async () => {
    const deps = baseDeps();
    deps.download.mockResolvedValue({ status: 'download-failed', detail: 'Request failed with status code 403' });

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    expect(deps.persist).not.toHaveBeenCalled();
    expect(out).toEqual({
      persisted: false,
      logoUrl: null,
      reason: 'download-failed',
      detail: 'Request failed with status code 403',
    });
  });

  it('does not persist when the discovered logo is an SVG (extension irrelevant — content-type decides)', async () => {
    const deps = baseDeps();
    // Extensionless URL that served image/svg+xml: must never become the
    // canonical brand asset (brand guidelines + image models reject SVG).
    deps.discoverLogoUrl.mockResolvedValue('https://acme.com/logo');
    deps.download.mockResolvedValue({ status: 'svg' });

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    expect(deps.persist).not.toHaveBeenCalled();
    expect(out).toEqual({ persisted: false, logoUrl: null, reason: 'svg-only' });
  });

  it('reports no-logo-found when discovery comes back empty', async () => {
    const deps = baseDeps();
    deps.discoverLogoUrl.mockResolvedValue(null);

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    expect(deps.persist).not.toHaveBeenCalled();
    expect(out).toEqual({ persisted: false, logoUrl: null, reason: 'no-logo-found' });
  });

  it('reports persist-failed when the brand-guidelines write is rejected', async () => {
    const deps = baseDeps();
    deps.persist.mockResolvedValue({ success: false, error: 'Permission denied' });

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    expect(out.persisted).toBe(false);
    expect(out.reason).toBe('persist-failed');
    expect(out.detail).toBe('Permission denied');
  });

  it('never throws — discovery errors fold into an error outcome', async () => {
    const deps = baseDeps();
    deps.discoverLogoUrl.mockRejectedValue(new Error('Puppeteer crashed'));

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    expect(out.persisted).toBe(false);
    expect(out.reason).toBe('error');
    expect(out.detail).toMatch(/Puppeteer crashed/);
  });
});

describe('classifyBrandLogoUrl (ENG-792 shared usability probe)', () => {
  const png = { 'content-type': 'image/png' };

  it('is usable for a 2xx image response with bytes', async () => {
    const out = await classifyBrandLogoUrl('https://s3/logo.png', {
      httpGet: async () => ({
        status: 200,
        headers: png,
        data: Buffer.from([137, 80, 78, 71]),
      }),
    });
    expect(out).toBe('usable');
  });

  it('is usable for generic-binary and absent content-types', async () => {
    // S3 objects with no ContentType metadata serve real bytes as
    // octet-stream and generate fine downstream (getImageMimeType sniffs the
    // extension), so these must not be classified broken.
    for (const ct of ['application/octet-stream', 'binary/octet-stream']) {
      expect(
        await classifyBrandLogoUrl('https://s3/logo.png', {
          httpGet: async () => ({
            status: 200,
            headers: { 'content-type': ct },
            data: Buffer.from([1, 2, 3]),
          }),
        }),
      ).toBe('usable');
    }
    expect(
      await classifyBrandLogoUrl('https://s3/logo.png', {
        httpGet: async () => ({ status: 200, headers: {}, data: Buffer.from([1]) }),
      }),
    ).toBe('usable');
  });

  it('is broken for a rejected 4xx carrying an axios response (the favicon case)', async () => {
    const out = await classifyBrandLogoUrl(
      'https://www.google.com/s2/favicons?domain=dramabreak.ai&sz=128',
      {
        httpGet: async () => {
          const err: any = new Error('Request failed with status code 404');
          err.response = { status: 404, headers: png };
          throw err;
        },
      },
    );
    expect(out).toBe('broken');
  });

  it('is broken for a non-2xx 4xx surfaced by a non-throwing fetcher', async () => {
    const out = await classifyBrandLogoUrl('https://cdn/gone.png', {
      httpGet: async () => ({ status: 404, headers: png, data: Buffer.from([1]) }),
    });
    expect(out).toBe('broken');
  });

  it('is broken for an empty body or a textual error body served with 200', async () => {
    expect(
      await classifyBrandLogoUrl('https://s3/logo.png', {
        httpGet: async () => ({ status: 200, headers: png, data: Buffer.alloc(0) }),
      }),
    ).toBe('broken');
    for (const ct of ['text/html; charset=utf-8', 'application/json']) {
      expect(
        await classifyBrandLogoUrl('https://cdn/error', {
          httpGet: async () => ({
            status: 200,
            headers: { 'content-type': ct },
            data: Buffer.from('<!doctype html>'),
          }),
        }),
      ).toBe('broken');
    }
  });

  it('is broken for an empty or non-string URL, without fetching', async () => {
    let called = false;
    const httpGet = async () => {
      called = true;
      return { status: 200, headers: png, data: Buffer.from([1]) };
    };
    expect(await classifyBrandLogoUrl('', { httpGet })).toBe('broken');
    expect(await classifyBrandLogoUrl('   ', { httpGet })).toBe('broken');
    expect(await classifyBrandLogoUrl(undefined as any, { httpGet })).toBe('broken');
    expect(called).toBe(false);
  });

  it('is UNKNOWN — never broken — for timeouts, DNS errors and 5xx', async () => {
    // This is what protects a real logo from being replaced on a blip.
    const bare = await classifyBrandLogoUrl('https://slow/logo.png', {
      httpGet: async () => {
        throw new Error('timeout of 15000ms exceeded');
      },
    });
    expect(bare).toBe('unknown');

    const server = await classifyBrandLogoUrl('https://flaky/logo.png', {
      httpGet: async () => {
        const err: any = new Error('Request failed with status code 503');
        err.response = { status: 503, headers: png };
        throw err;
      },
    });
    expect(server).toBe('unknown');

    const surfaced = await classifyBrandLogoUrl('https://flaky/logo.png', {
      httpGet: async () => ({ status: 503, headers: png, data: Buffer.from([1]) }),
    });
    expect(surfaced).toBe('unknown');
  });
});
