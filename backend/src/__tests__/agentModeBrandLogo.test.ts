/**
 * ENG-326 — services/agentMode/brandLogo unit tests.
 *
 * The module owns deterministic brand-logo handling:
 *   - getPersistedBrandLogoUrl: resolve the persisted logo off a
 *     brandGuidelines object (brandData.logoUrl → attachments → legacy
 *     brandAssets)
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
  downloadBrandLogoToS3,
  ensureBrandLogoPersisted,
  getPersistedBrandLogoUrl,
  getPersistedBrandLogoUrlForUser,
  missingBrandLogoToolResult,
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

describe('downloadBrandLogoToS3 (extracted from extractCSSFromURL — behavior-preserving)', () => {
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
    ).resolves.toBe('https://s3.example.com/users/u1/brand/logo/logo.png');

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

  it('skips SVG logos and returns null (no upload)', async () => {
    mockedAxiosGet.mockResolvedValue({
      headers: { 'content-type': 'image/svg+xml' },
      data: new ArrayBuffer(8),
    });

    await expect(
      downloadBrandLogoToS3('https://acme.com/logo.svg', 'u1'),
    ).resolves.toBeNull();
    expect(s3Utils.uploadFileToS3WithPath).not.toHaveBeenCalled();
  });

  it('returns null on download failure without throwing', async () => {
    mockedAxiosGet.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(
      downloadBrandLogoToS3('https://acme.com/logo.png', 'u1'),
    ).resolves.toBeNull();
  });

  it('returns null when the S3 upload reports failure', async () => {
    mockedAxiosGet.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      data: new ArrayBuffer(8),
    });
    s3Utils.uploadFileToS3WithPath.mockResolvedValue({ success: false });
    await expect(
      downloadBrandLogoToS3('https://acme.com/logo.png', 'u1'),
    ).resolves.toBeNull();
  });
});

describe('ensureBrandLogoPersisted (deterministic onboarding step — AC-1)', () => {
  const baseDeps = () => ({
    resolveBrand: jest.fn().mockResolvedValue(null),
    discoverLogoUrl: jest.fn().mockResolvedValue('https://acme.com/logo.png'),
    download: jest.fn().mockResolvedValue('https://s3/brand/logo.png'),
    persist: jest.fn().mockResolvedValue({ success: true }),
  });

  it('skips when a logo is already persisted (Emma did her job)', async () => {
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
    expect(deps.discoverLogoUrl).not.toHaveBeenCalled();
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

  it('persists the raw discovered URL when the S3 persist path fails on a raster logo', async () => {
    const deps = baseDeps();
    deps.download.mockResolvedValue(null);

    const out = await ensureBrandLogoPersisted('u1', 'https://acme.com', deps);

    expect(deps.persist).toHaveBeenCalledWith(
      'u1',
      'https://acme.com/logo.png',
      'logo.png',
    );
    expect(out.persisted).toBe(true);
  });

  it('does not persist when only an SVG was discovered and S3 skipped it', async () => {
    const deps = baseDeps();
    deps.discoverLogoUrl.mockResolvedValue('https://acme.com/logo.svg');
    deps.download.mockResolvedValue(null);

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
