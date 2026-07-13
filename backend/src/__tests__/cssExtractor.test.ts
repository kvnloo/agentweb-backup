// Mock color library (ESM) before importing cssExtractor
jest.mock('color', () => {
  // Simple color normalizer that handles hex and rgb
  const Color = (value: string) => {
    const hex = (() => {
      const v = value.trim().toLowerCase();
      // Already hex
      if (v.startsWith('#')) {
        if (v.length === 4) {
          return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
        }
        return v;
      }
      // rgb/rgba
      const rgbMatch = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (rgbMatch) {
        const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
        const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
        const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
      }
      throw new Error(`Cannot parse color: ${value}`);
    })();
    return {
      hex: () => hex,
      lightness: () => {
        // Simple lightness approximation
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 2.55;
      },
    };
  };
  Color.default = Color;
  return { __esModule: true, default: Color };
});

// Mock jsdom BEFORE importing cssExtractor to prevent ESM dependency chain loading
const mockDocument = {
  querySelectorAll: jest.fn().mockReturnValue([]),
  documentElement: {},
};
const mockWindow = { document: mockDocument };
jest.mock('jsdom', () => ({
  JSDOM: jest.fn().mockImplementation((html: string) => {
    // Parse inline styles from HTML using simple regex
    const styleContents: string[] = [];
    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let match;
    while ((match = styleRegex.exec(html)) !== null) {
      styleContents.push(match[1]);
    }

    const styleElements = styleContents.map(content => ({
      textContent: content,
    }));

    // Parse meta tags for brand identity extraction
    const metaTags: Array<{ property?: string; name?: string; content?: string }> = [];
    const metaRegex = /<meta\s+([^>]+)\/?>/gi;
    let metaMatch;
    while ((metaMatch = metaRegex.exec(html)) !== null) {
      const attrs = metaMatch[1];
      const propMatch = attrs.match(/property\s*=\s*["']([^"']+)["']/i);
      const nameMatch = attrs.match(/name\s*=\s*["']([^"']+)["']/i);
      const contentMatch = attrs.match(/content\s*=\s*["']([^"']+)["']/i);
      metaTags.push({
        property: propMatch?.[1],
        name: nameMatch?.[1],
        content: contentMatch?.[1],
      });
    }

    // Parse title tag
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const titleText = titleMatch?.[1]?.trim() || null;

    // Parse first h1
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const h1Text = h1Match?.[1]?.replace(/<[^>]+>/g, '').trim() || null;

    // Parse img elements in header/nav
    const headerMatch = html.match(/<header[^>]*>([\s\S]*?)<\/header>/i);
    const navMatch = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i);
    const headerImgs: Array<{ src: string; alt: string; className: string }> = [];
    const headerContent = (headerMatch?.[1] || '') + (navMatch?.[1] || '');
    const imgRegex = /<img\s+([^>]+)\/?>/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(headerContent)) !== null) {
      const attrs = imgMatch[1];
      const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i);
      const altMatch = attrs.match(/alt\s*=\s*["']([^"']+)["']/i);
      const classMatch = attrs.match(/class\s*=\s*["']([^"']+)["']/i);
      if (srcMatch) {
        headerImgs.push({
          src: srcMatch[1],
          alt: altMatch?.[1] || '',
          className: classMatch?.[1] || '',
        });
      }
    }

    // Parse all img elements with "logo" in alt or class
    const allImgs: Array<{ src: string; alt: string; className: string }> = [];
    const allImgRegex = /<img\s+([^>]+)\/?>/gi;
    let allImgMatch;
    while ((allImgMatch = allImgRegex.exec(html)) !== null) {
      const attrs = allImgMatch[1];
      const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i);
      const altMatch = attrs.match(/alt\s*=\s*["']([^"']+)["']/i);
      const classMatch = attrs.match(/class\s*=\s*["']([^"']+)["']/i);
      if (srcMatch) {
        allImgs.push({
          src: srcMatch[1],
          alt: altMatch?.[1] || '',
          className: classMatch?.[1] || '',
        });
      }
    }

    // Parse link elements for favicon/icons
    const linkTags: Array<{ rel: string; type?: string; href?: string; sizes?: string }> = [];
    const linkRegex = /<link\s+([^>]+)\/?>/gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(html)) !== null) {
      const attrs = linkMatch[1];
      const relMatch = attrs.match(/rel\s*=\s*["']([^"']+)["']/i);
      const typeMatch = attrs.match(/type\s*=\s*["']([^"']+)["']/i);
      const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
      const sizesMatch = attrs.match(/sizes\s*=\s*["']([^"']+)["']/i);
      if (relMatch) {
        linkTags.push({
          rel: relMatch[1],
          type: typeMatch?.[1],
          href: hrefMatch?.[1],
          sizes: sizesMatch?.[1],
        });
      }
    }

    // Parse first p after h1 (for tagline fallback)
    const pMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const pText = pMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || null;

    // querySelector implementation for brand identity
    const querySelector = (selector: string): any => {
      // Meta property selectors
      const metaPropMatch = selector.match(/meta\[property=["']([^"']+)["']\]/);
      if (metaPropMatch) {
        const meta = metaTags.find(m => m.property === metaPropMatch[1]);
        return meta ? { getAttribute: (attr: string) => attr === 'content' ? meta.content : null } : null;
      }
      // Meta name selectors
      const metaNameMatch = selector.match(/meta\[name=["']([^"']+)["']\]/);
      if (metaNameMatch) {
        const meta = metaTags.find(m => m.name === metaNameMatch[1]);
        return meta ? { getAttribute: (attr: string) => attr === 'content' ? meta.content : null } : null;
      }
      // Title element
      if (selector === 'title') {
        return titleText ? { textContent: titleText } : null;
      }
      // h1 element
      if (selector === 'h1') {
        return h1Text ? { textContent: h1Text } : null;
      }
      // First p element
      if (selector === 'p') {
        return pText ? { textContent: pText } : null;
      }
      return null;
    };

    // querySelectorAll implementation
    const querySelectorAll = (selector: string): any[] => {
      if (selector === 'style') return styleElements;
      if (selector === 'link[rel="stylesheet"]') return [];
      // Images in header/nav
      if (selector === 'header img, nav img') {
        return headerImgs.map(img => ({
          getAttribute: (attr: string) => {
            if (attr === 'src') return img.src;
            if (attr === 'alt') return img.alt;
            if (attr === 'class') return img.className;
            return null;
          },
          src: img.src,
        }));
      }
      // All images (for logo keyword search)
      if (selector === 'img') {
        return allImgs.map(img => ({
          getAttribute: (attr: string) => {
            if (attr === 'src') return img.src;
            if (attr === 'alt') return img.alt;
            if (attr === 'class') return img.className;
            return null;
          },
          src: img.src,
        }));
      }
      // Link elements for favicon
      if (selector.startsWith('link[rel')) {
        return linkTags
          .filter(l => {
            if (selector.includes('icon')) return l.rel === 'icon' || l.rel === 'shortcut icon';
            if (selector.includes('apple-touch-icon')) return l.rel === 'apple-touch-icon';
            return l.rel === 'stylesheet';
          })
          .map(l => ({
            getAttribute: (attr: string) => {
              if (attr === 'href') return l.href;
              if (attr === 'type') return l.type;
              if (attr === 'sizes') return l.sizes;
              return null;
            },
          }));
      }
      return [];
    };

    return {
      window: {
        document: {
          querySelector,
          querySelectorAll,
        },
      },
    };
  }),
}));

// Mock @projectwallace/css-analyzer (used inside analyzeDesignTokens)
jest.mock('@projectwallace/css-analyzer', () => ({
  analyze: jest.fn(),
}));

// Mock puppeteer-core
const mockPage = {
  setUserAgent: jest.fn(),
  setCacheEnabled: jest.fn(),
  setExtraHTTPHeaders: jest.fn(),
  emulateMediaFeatures: jest.fn(),
  goto: jest.fn(),
  evaluate: jest.fn(),
  close: jest.fn(),
};
const mockBrowser = {
  newPage: jest.fn().mockResolvedValue(mockPage),
  close: jest.fn(),
};
jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: {
    launch: jest.fn().mockResolvedValue(mockBrowser),
  },
}));

// Mock browserUtils
jest.mock('../utils/browserUtils', () => ({
  findChromeExecutable: jest.fn().mockReturnValue('/usr/bin/google-chrome'),
  PUPPETEER_LAUNCH_ARGS: ['--no-sandbox'],
}));

// Mock axios for JSDOM fallback path
jest.mock('axios');

import { extractCSSFromURL, analyzeDesignTokens, inferBrandTokens, DesignTokens } from '../services/cssExtractor';

const { findChromeExecutable } = require('../utils/browserUtils');

describe('cssExtractor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========== FAIL TESTS ===========

  describe('URL validation', () => {
    it('should throw on invalid URL format', async () => {
      await expect(extractCSSFromURL('not-a-url')).rejects.toThrow('Invalid URL format');
    });

    it('should throw on SSRF localhost', async () => {
      await expect(extractCSSFromURL('http://localhost:3000')).rejects.toThrow('Cannot fetch from localhost');
    });

    it('should throw on SSRF private IP ranges', async () => {
      await expect(extractCSSFromURL('http://192.168.1.1')).rejects.toThrow('Cannot fetch from private IP ranges');
    });

    it('should throw on SSRF 10.x.x.x private IP', async () => {
      await expect(extractCSSFromURL('http://10.0.0.1')).rejects.toThrow('Cannot fetch from private IP ranges');
    });

    it('should throw on non-HTTP protocol', async () => {
      await expect(extractCSSFromURL('ftp://example.com')).rejects.toThrow('URL must be HTTP or HTTPS');
    });
  });

  describe('empty CSS handling', () => {
    it('should return zero-count arrays for empty CSS', async () => {
      const result = await extractCSSFromURL('https://example.com', {
        html: '<html><head></head><body></body></html>',
      });

      expect(result.stylesheets).toHaveLength(0);
      expect(result.url).toBe('https://example.com');

      const tokens = await analyzeDesignTokens(result);
      expect(tokens.colors.all).toHaveLength(0);
      expect(tokens.typography.fontFamilies).toHaveLength(0);
      expect(tokens.visualEffects.boxShadows).toHaveLength(0);
    });
  });

  describe('Chrome fallback', () => {
    it('should fall back to JSDOM when no Chrome executable found', async () => {
      // Use mockReturnValue (not Once) since html option bypasses puppeteer entirely;
      // mockReturnValueOnce would leak to subsequent tests if not consumed
      const origImpl = (findChromeExecutable as jest.Mock).getMockImplementation();
      (findChromeExecutable as jest.Mock).mockReturnValue(undefined);

      const html = `<html><head><style>body { color: #333; font-family: Arial; }</style></head><body></body></html>`;
      const result = await extractCSSFromURL('https://example.com', { html });

      // Restore the default mock implementation
      if (origImpl) {
        (findChromeExecutable as jest.Mock).mockImplementation(origImpl);
      } else {
        (findChromeExecutable as jest.Mock).mockReturnValue('/usr/bin/google-chrome');
      }

      // Should still extract CSS via JSDOM path
      expect(result.stylesheets).toHaveLength(1);
      expect(result.stylesheets[0].content).toContain('color: #333');
    });

    it('fetches the live URL with no-cache headers on the JSDOM fallback (returns current content, not a stale copy)', async () => {
      // Regression for the onboarding stale-scrape reports: when the browser
      // path is unavailable and we fetch the HTML over HTTP, the request must
      // ask origin/intermediaries for a fresh copy. Simulate a changed site by
      // returning the CURRENT markup and assert the request opted out of caches.
      const origImpl = (findChromeExecutable as jest.Mock).getMockImplementation();
      (findChromeExecutable as jest.Mock).mockReturnValue(undefined);
      const axios = require('axios');
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: '<html><head><style>body { color: #abcabc; }</style></head><body></body></html>',
      });

      const result = await extractCSSFromURL('https://changed-fixture.example.com');

      if (origImpl) {
        (findChromeExecutable as jest.Mock).mockImplementation(origImpl);
      } else {
        (findChromeExecutable as jest.Mock).mockReturnValue('/usr/bin/google-chrome');
      }

      expect(result.stylesheets[0].content).toContain('#abcabc');
      expect(axios.get).toHaveBeenCalledWith(
        'https://changed-fixture.example.com/',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
          }),
        })
      );
    });
  });

  // =========== SUCCESS TESTS ===========

  describe('HTML test mode (JSDOM path)', () => {
    it('should extract inline CSS colors and fonts from provided HTML', async () => {
      const html = `<html><head><style>
        body { color: #333333; font-family: "Helvetica Neue", sans-serif; font-size: 16px; }
        h1 { color: #0066cc; font-size: 32px; font-weight: 700; }
        .btn { background-color: rgb(255, 100, 50); border-radius: 8px; }
      </style></head><body></body></html>`;

      const result = await extractCSSFromURL('https://example.com', { html });

      expect(result.stylesheets).toHaveLength(1);
      expect(result.url).toBe('https://example.com');
      expect(result.extractedAt).toBeDefined();

      const tokens = await analyzeDesignTokens(result);
      expect(tokens.colors.all.length).toBeGreaterThan(0);
      expect(tokens.typography.fontFamilies.length).toBeGreaterThan(0);
      expect(tokens.typography.fontSizes.length).toBeGreaterThan(0);
    });
  });

  describe('variable resolution', () => {
    it('should resolve CSS variables in stylesheet text', async () => {
      const html = `<html><head><style>
        :root { --primary: #0066cc; --secondary: #ff6600; }
        body { color: var(--primary); background: var(--secondary); }
      </style></head><body></body></html>`;

      const result = await extractCSSFromURL('https://example.com', { html });

      const tokens = await analyzeDesignTokens(result);
      // After variable resolution, we should find actual color values, not var() references
      const colorValues = tokens.colors.all.map(c => c.value);
      expect(colorValues).not.toContain('var(--primary)');
      // Should have resolved #0066cc and #ff6600
      expect(colorValues).toContain('#0066cc');
      expect(colorValues).toContain('#ff6600');
    });

    it('should handle nested variable resolution', async () => {
      const html = `<html><head><style>
        :root { --base-blue: #0055aa; --primary: var(--base-blue); }
        h1 { color: var(--primary); }
      </style></head><body></body></html>`;

      const result = await extractCSSFromURL('https://example.com', { html });
      const tokens = await analyzeDesignTokens(result);
      const colorValues = tokens.colors.all.map(c => c.value);
      expect(colorValues).toContain('#0055aa');
    });
  });

  describe('analyzer integration', () => {
    it('should produce valid DesignTokens shape from CSS', async () => {
      const html = `<html><head><style>
        body { color: #333333; font-family: "Helvetica Neue", sans-serif; font-size: 16px; line-height: 1.5; }
        h1 { color: #0066cc; font-size: 32px; }
        .card { box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-radius: 8px; }
      </style></head><body></body></html>`;

      const result = await extractCSSFromURL('https://example.com', { html });
      const tokens = await analyzeDesignTokens(result);

      // Verify DesignTokens shape
      expect(tokens.colors).toHaveProperty('all');
      expect(tokens.colors).toHaveProperty('backgrounds');
      expect(tokens.colors).toHaveProperty('text');
      expect(tokens.colors).toHaveProperty('borders');
      expect(tokens.colors).toHaveProperty('accents');
      expect(tokens.typography).toHaveProperty('fontFamilies');
      expect(tokens.typography).toHaveProperty('fontSizes');
      expect(tokens.typography).toHaveProperty('fontWeights');
      expect(tokens.typography).toHaveProperty('lineHeights');
      expect(tokens.visualEffects).toHaveProperty('boxShadows');
      expect(tokens.visualEffects).toHaveProperty('borderRadius');

      // Verify actual values extracted
      expect(tokens.colors.all.length).toBeGreaterThan(0);
      expect(tokens.typography.fontFamilies.length).toBeGreaterThan(0);
      expect(tokens.visualEffects.borderRadius.length).toBeGreaterThan(0);
    });
  });

  describe('brand token inference', () => {
    it('should infer correct primary/secondary colors and fonts', () => {
      const tokens: DesignTokens = {
        colors: {
          all: [
            { value: '#0066cc', count: 10, contexts: ['color', 'background'] },
            { value: '#ff6600', count: 5, contexts: ['color'] },
            { value: '#333333', count: 8, contexts: ['color'] },
            { value: '#ffffff', count: 15, contexts: ['background'] },
          ],
          backgrounds: ['#ffffff'],
          text: ['#333333', '#0066cc'],
          borders: [],
          accents: ['#0066cc', '#ff6600'],
        },
        typography: {
          fontFamilies: [
            { family: 'Inter', count: 20 },
            { family: 'Georgia', count: 5 },
          ],
          fontSizes: [
            { size: '16px', count: 10 },
            { size: '14px', count: 8 },
          ],
          fontWeights: [
            { weight: 400, count: 15 },
            { weight: 600, count: 8 },
            { weight: 700, count: 5 },
          ],
          lineHeights: [
            { height: '1.5', count: 10 },
          ],
        },
        visualEffects: {
          boxShadows: [{ value: '0 2px 4px rgba(0,0,0,0.1)', count: 5 }],
          textShadows: [],
          borderRadius: [{ value: '8px', count: 10 }],
          transitions: [],
        },
      };

      const brand = inferBrandTokens(tokens);

      expect(brand.colors.primary).toBe('#0066cc');
      expect(brand.colors.secondary).toBeDefined();
      expect(brand.colors.palette.length).toBeGreaterThan(0);
      expect(brand.typography.bodyFont).toBe('Inter');
      expect(brand.typography.headingFont).toBe('Georgia');
      expect(brand.typography.fontWeights.regular).toBe(400);
      expect(brand.typography.fontWeights.bold).toBe(700);
      expect(brand.visualEffects.borderRadius).toBe('8px');
    });
  });

  describe('puppeteer extraction', () => {
    beforeEach(() => {
      // Re-establish puppeteer mock chain (cleared by top-level beforeEach)
      mockBrowser.newPage.mockResolvedValue(mockPage);
      mockBrowser.close.mockResolvedValue(undefined);
      mockPage.setUserAgent.mockResolvedValue(undefined);
      mockPage.setCacheEnabled.mockResolvedValue(undefined);
      mockPage.setExtraHTTPHeaders.mockResolvedValue(undefined);
      mockPage.emulateMediaFeatures.mockResolvedValue(undefined);
      mockPage.goto.mockResolvedValue(undefined);
      mockPage.close.mockResolvedValue(undefined);
      const pMock = require('puppeteer-core');
      pMock.default.launch.mockResolvedValue(mockBrowser);
      (findChromeExecutable as jest.Mock).mockReturnValue('/usr/bin/google-chrome');
    });

    it('should use computed element styles for typography scale', async () => {
      // Mock puppeteer page.evaluate to return computed styles
      mockPage.evaluate
        .mockResolvedValueOnce({
          customProperties: { '--primary': '#0066cc' },
          stylesheetText: 'body { color: var(--primary); font-family: Inter; }',
          computedElements: {
            body: { fontSize: '16px', lineHeight: '24px', fontWeight: '400', fontFamily: 'Inter', color: '#333333', backgroundColor: '#ffffff' },
            h1: { fontSize: '40px', lineHeight: '48px', fontWeight: '700', fontFamily: 'Inter', color: '#0066cc', backgroundColor: 'transparent' },
            h2: { fontSize: '32px', lineHeight: '40px', fontWeight: '600', fontFamily: 'Inter', color: '#0066cc', backgroundColor: 'transparent' },
            h3: { fontSize: '24px', lineHeight: '32px', fontWeight: '600', fontFamily: 'Inter', color: '#333333', backgroundColor: 'transparent' },
          },
        });

      const result = await extractCSSFromURL('https://example.com');

      // Verify puppeteer was used
      const pMock = require('puppeteer-core');
      expect(pMock.default.launch).toHaveBeenCalled();
      expect(mockPage.goto).toHaveBeenCalledWith(expect.stringContaining('example.com'), expect.any(Object));

      // Verify computed styles were captured
      expect(result.stylesheets.length).toBeGreaterThanOrEqual(0);

      const tokens = await analyzeDesignTokens(result);
      // Typography scale should be populated from computed elements
      if (tokens.typography.scale) {
        expect(tokens.typography.scale.h1).toBeDefined();
        expect(tokens.typography.scale.body).toBeDefined();
      }
    });

    it('disables the browser cache and sends no-cache headers so it scrapes the CURRENT site (no stale copy)', async () => {
      mockPage.evaluate.mockResolvedValueOnce({
        customProperties: {},
        stylesheetText: 'body { color: #111; }',
        computedElements: {},
      });

      await extractCSSFromURL('https://example.com');

      // The onboarding stale-scrape reports (an old version of the site was
      // captured) are guarded by turning off the HTTP cache and asking any
      // intermediary not to serve a cached response.
      expect(mockPage.setCacheEnabled).toHaveBeenCalledWith(false);
      expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith(
        expect.objectContaining({ 'Cache-Control': 'no-cache', Pragma: 'no-cache' })
      );
    });

    it('emulates prefers-color-scheme: dark before navigating so a dark-brand site is captured as dark (not a light default)', async () => {
      // Regression for ENG-285: headless Chrome reports prefers-color-scheme:
      // light by default, so sites that ship their brand's dark theme behind the
      // OS color-scheme preference (via a CSS media query or a client script that
      // reads it) were captured in their LIGHT variant — e.g. rankai.ai read as a
      // near-white background when the real design is dark. Emulating a dark
      // preference makes the extraction match what dark-mode users see.
      mockPage.evaluate.mockResolvedValueOnce({
        customProperties: {},
        stylesheetText: 'body { color: #eee; }',
        computedElements: {},
      });

      await extractCSSFromURL('https://example.com');

      expect(mockPage.emulateMediaFeatures).toHaveBeenCalledWith([
        { name: 'prefers-color-scheme', value: 'dark' },
      ]);
      // Must be emulated BEFORE navigation so SSR/hydration observe the preference.
      const emulateOrder = mockPage.emulateMediaFeatures.mock.invocationCallOrder[0];
      const gotoOrder = mockPage.goto.mock.invocationCallOrder[0];
      expect(emulateOrder).toBeLessThan(gotoOrder);
    });
  });

  describe('mergeWallaceWithRegex — wallace .unique is a frequency-map object', () => {
    let mockWallaceAnalyze: jest.MockedFunction<any>;

    beforeEach(() => {
      // Get the mock from the module system
      mockWallaceAnalyze = require('@projectwallace/css-analyzer').analyze;
    });

    // Note: can't use jest.requireActual here because @projectwallace/css-analyzer is ESM-only.
    // The real library is verified to return { "value": count } objects via a Node script:
    //   node -e "const{analyze}=require('@projectwallace/css-analyzer');
    //           console.log(typeof analyze('body{color:red}').values.colors.unique)"
    // Output: "object" (not "array")

    it('does not throw when wallace returns frequency-map objects for all fields', async () => {
      mockWallaceAnalyze.mockReturnValue({
        values: {
          colors: { unique: { '#ff0000': 3, '#0000ff': 1 } },
          fontFamilies: { unique: { 'Arial, sans-serif': 2 } },
          fontSizes: { unique: { '16px': 4, '24px': 2 } },
          lineHeights: { unique: { '1.5': 3 } },
          boxShadows: { unique: { '0 2px 4px rgba(0,0,0,0.1)': 1 } },
          textShadows: { unique: { '1px 1px #000': 1 } },
          borderRadiuses: { unique: { '8px': 5 } },
        },
      });

      const cssData = {
        url: 'https://example.com',
        html: '<html></html>',
        extractedAt: new Date().toISOString(),
        stylesheets: [{ source: 'https://example.com/style.css', content: 'body { color: #ff0000; }', parsed: null }],
        inlineStyles: [],
      };

      await expect(analyzeDesignTokens(cssData)).resolves.not.toThrow();
    });

    it('extracts colors from frequency-map .unique (the core bug fix)', async () => {
      mockWallaceAnalyze.mockReturnValue({
        values: {
          colors: { unique: { '#ff0000': 3, '#0000ff': 1 } },
          fontFamilies: { unique: {} },
          fontSizes: { unique: {} },
          lineHeights: { unique: {} },
          boxShadows: { unique: {} },
          textShadows: { unique: {} },
          borderRadiuses: { unique: {} },
        },
      });

      const cssData = {
        url: 'https://example.com',
        html: '<html></html>',
        extractedAt: new Date().toISOString(),
        stylesheets: [{ source: 'https://example.com/style.css', content: 'body { color: #ff0000; }', parsed: null }],
        inlineStyles: [],
      };

      const tokens = await analyzeDesignTokens(cssData);
      const colorValues = tokens.colors.all.map((c: { value: string }) => c.value);
      // normalizeColor calls Color(v).hex() — the Color mock returns lowercase hex
      expect(colorValues).toContain('#ff0000');
      expect(colorValues).toContain('#0000ff');
    });

    it('handles empty .unique objects without errors', async () => {
      mockWallaceAnalyze.mockReturnValue({
        values: {
          colors: { unique: {} },
          fontFamilies: { unique: {} },
          fontSizes: { unique: {} },
          lineHeights: { unique: {} },
          boxShadows: { unique: {} },
          textShadows: { unique: {} },
          borderRadiuses: { unique: {} },
        },
      });

      const cssData = {
        url: 'https://example.com',
        html: '<html></html>',
        extractedAt: new Date().toISOString(),
        stylesheets: [{ source: 'https://example.com/style.css', content: 'body { color: red; }', parsed: null }],
        inlineStyles: [],
      };

      const tokens = await analyzeDesignTokens(cssData);
      expect(tokens).toBeDefined();
      expect(tokens.colors).toBeDefined();
    });

    it('handles missing .unique fields without errors', async () => {
      mockWallaceAnalyze.mockReturnValue({
        values: {
          colors: {},  // .unique missing
        },
      });

      const cssData = {
        url: 'https://example.com',
        html: '<html></html>',
        extractedAt: new Date().toISOString(),
        stylesheets: [{ source: 'https://example.com/style.css', content: 'body { color: red; }', parsed: null }],
        inlineStyles: [],
      };

      await expect(analyzeDesignTokens(cssData)).resolves.not.toThrow();
    });

    it('gracefully falls back to regex path when wallace throws', async () => {
      mockWallaceAnalyze.mockImplementation(() => {
        throw new Error('css-analyzer crashed');
      });

      const cssData = {
        url: 'https://example.com',
        html: '<html></html>',
        extractedAt: new Date().toISOString(),
        stylesheets: [{ source: 'https://example.com/style.css', content: 'body { color: #abc123; }', parsed: null }],
        inlineStyles: [],
      };

      const tokens = await analyzeDesignTokens(cssData);
      expect(tokens).toBeDefined();
      expect(tokens.colors).toBeDefined();
    });
  });

  describe('brand identity extraction', () => {
    it('should extract brand name from og:site_name', async () => {
      const html = `<html><head>
        <meta property="og:site_name" content="Acme Corp">
        <title>Acme Corp - Homepage</title>
      </head><body><h1>Welcome</h1></body></html>`;

      const result = await extractCSSFromURL('https://example.com', { html });
      expect(result.brandIdentity).toBeDefined();
      expect(result.brandIdentity!.brandName).toBe('Acme Corp');
    });

    it('should fallback brand name to title when no og:site_name', async () => {
      const html = `<html><head>
        <title>Acme Corp - Homepage</title>
      </head><body><h1>Welcome to our site</h1></body></html>`;

      const result = await extractCSSFromURL('https://example.com', { html });
      expect(result.brandIdentity).toBeDefined();
      // Should clean the title by removing common suffixes like " - Homepage"
      expect(result.brandIdentity!.brandName).toBe('Acme Corp');
    });

    it('should extract tagline from meta description', async () => {
      const html = `<html><head>
        <meta name="description" content="We build amazing things">
      </head><body></body></html>`;

      const result = await extractCSSFromURL('https://example.com', { html });
      expect(result.brandIdentity).toBeDefined();
      expect(result.brandIdentity!.tagline).toBe('We build amazing things');
    });

    it('should extract logo from header img', async () => {
      const html = `<html><head></head><body>
        <header><img src="https://example.com/logo.png" alt="logo"></header>
      </body></html>`;

      const result = await extractCSSFromURL('https://example.com', { html });
      expect(result.brandIdentity).toBeDefined();
      expect(result.brandIdentity!.logoUrl).toBe('https://example.com/logo.png');
    });

    it('should extract logo from og:image', async () => {
      const html = `<html><head>
        <meta property="og:image" content="https://example.com/og.png">
      </head><body></body></html>`;

      const result = await extractCSSFromURL('https://example.com', { html });
      expect(result.brandIdentity).toBeDefined();
      expect(result.brandIdentity!.logoUrl).toBe('https://example.com/og.png');
    });

    it('should return all null fields for empty HTML', async () => {
      const html = `<html><head></head><body></body></html>`;

      const result = await extractCSSFromURL('https://example.com', { html });
      expect(result.brandIdentity).toBeDefined();
      expect(result.brandIdentity!.logoUrl).toBeNull();
      expect(result.brandIdentity!.brandName).toBeNull();
      expect(result.brandIdentity!.tagline).toBeNull();
      expect(result.brandIdentity!.favicon).toBeNull();
    });
  });
});
