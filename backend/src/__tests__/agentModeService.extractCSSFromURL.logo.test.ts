/**
 * ENG-326 — Behavior-preserving proof (characterization tests).
 *
 * Pins agentModeService.extractCSSFromURL's OBSERVABLE logo behavior:
 *   - discovered logo is downloaded (arraybuffer, 15s timeout) and uploaded
 *     to S3 under `users/{userId}/brand/logo`
 *   - SVG logos are skipped (no S3 upload), raw URL is surfaced instead
 *   - download/upload failures degrade to the raw discovered URL
 *   - no discovered logo → logoUrl null
 *   - the surfaced logoUrl appears in both suggestedBrandTokens and
 *     formattedContent
 *
 * Written BEFORE extracting the download/persist block out of the monolith
 * into services/agentMode/brandLogo.ts, and passing UNCHANGED after — the
 * observable contract must not move.
 */

jest.mock('axios');
jest.mock('../services/cssExtractor', () => ({
  extractCSSFromURL: jest.fn(),
  analyzeDesignTokens: jest.fn(),
  inferBrandTokens: jest.fn(),
}));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3WithPath: jest.fn(),
}));

import axios from 'axios';
import { AgentModeService } from '../services/agentModeService';

const cssExtractor = require('../services/cssExtractor');
const s3Utils = require('../utils/s3Utils');

const mockedAxiosGet = axios.get as jest.Mock;

const detailedTokens = {
  colors: { all: [], backgrounds: [], text: [] },
  typography: { fontFamilies: [], fontSizes: [] },
  visualEffects: { boxShadows: [], borderRadius: [] },
};

const suggestedBrandTokens = {
  colors: { primary: '#111111', secondary: '#222222', palette: ['#111111'] },
  typography: {
    headingFont: 'Inter',
    bodyFont: 'Inter',
    fontWeights: { regular: 400, semibold: 600, bold: 700 },
  },
  visualEffects: { primaryShadow: 'none', borderRadius: '8px' },
};

function mockExtraction(logoUrl: string | null): void {
  cssExtractor.extractCSSFromURL.mockResolvedValue({
    stylesheets: [{ source: 'inline', content: '' }],
    extractedAt: '2026-07-15T00:00:00.000Z',
    brandIdentity: {
      logoUrl,
      brandName: 'Acme',
      tagline: 'Rockets, delivered',
      favicon: null,
    },
  });
  cssExtractor.analyzeDesignTokens.mockResolvedValue(detailedTokens);
  cssExtractor.inferBrandTokens.mockReturnValue({ ...suggestedBrandTokens });
}

describe('AgentModeService.extractCSSFromURL — logo download + S3 persist (characterization)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
  });

  it('downloads a discovered raster logo and surfaces the S3 URL', async () => {
    mockExtraction('https://acme.com/logo.png');
    mockedAxiosGet.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      data: new ArrayBuffer(8),
    });
    s3Utils.uploadFileToS3WithPath.mockResolvedValue({
      success: true,
      url: 'https://s3.example.com/users/u1/brand/logo/logo.png',
    });

    const result = await service.extractCSSFromURL(
      { url: 'https://acme.com' },
      'u1',
    );

    expect(result.success).toBe(true);
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
    expect(result.suggestedBrandTokens.logoUrl).toBe(
      'https://s3.example.com/users/u1/brand/logo/logo.png',
    );
    expect(result.formattedContent).toContain(
      'https://s3.example.com/users/u1/brand/logo/logo.png',
    );
  });

  it('skips SVG logos (no S3 upload) and surfaces the raw discovered URL', async () => {
    mockExtraction('https://acme.com/logo.svg');
    mockedAxiosGet.mockResolvedValue({
      headers: { 'content-type': 'image/svg+xml' },
      data: new ArrayBuffer(8),
    });

    const result = await service.extractCSSFromURL(
      { url: 'https://acme.com' },
      'u1',
    );

    expect(result.success).toBe(true);
    expect(s3Utils.uploadFileToS3WithPath).not.toHaveBeenCalled();
    expect(result.suggestedBrandTokens.logoUrl).toBe('https://acme.com/logo.svg');
  });

  it('degrades to the raw discovered URL when the download fails', async () => {
    mockExtraction('https://acme.com/logo.png');
    mockedAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.extractCSSFromURL(
      { url: 'https://acme.com' },
      'u1',
    );

    expect(result.success).toBe(true);
    expect(s3Utils.uploadFileToS3WithPath).not.toHaveBeenCalled();
    expect(result.suggestedBrandTokens.logoUrl).toBe('https://acme.com/logo.png');
  });

  it('degrades to the raw discovered URL when the S3 upload reports failure', async () => {
    mockExtraction('https://acme.com/logo.png');
    mockedAxiosGet.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      data: new ArrayBuffer(8),
    });
    s3Utils.uploadFileToS3WithPath.mockResolvedValue({
      success: false,
      error: 'AccessDenied',
    });

    const result = await service.extractCSSFromURL(
      { url: 'https://acme.com' },
      'u1',
    );

    expect(result.success).toBe(true);
    expect(result.suggestedBrandTokens.logoUrl).toBe('https://acme.com/logo.png');
  });

  it('surfaces logoUrl null when no logo was discovered', async () => {
    mockExtraction(null);

    const result = await service.extractCSSFromURL(
      { url: 'https://acme.com' },
      'u1',
    );

    expect(result.success).toBe(true);
    expect(mockedAxiosGet).not.toHaveBeenCalled();
    expect(s3Utils.uploadFileToS3WithPath).not.toHaveBeenCalled();
    expect(result.suggestedBrandTokens.logoUrl).toBeNull();
    expect(result.formattedContent).toContain('**Logo:** Not detected');
  });
});
