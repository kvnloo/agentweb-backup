import { JSDOM } from 'jsdom';
import Color from 'color';
import axios from 'axios';
import { findChromeExecutable, PUPPETEER_LAUNCH_ARGS } from '../utils/browserUtils';

// Type definitions
export interface BrandIdentity {
  logoUrl: string | null;       // Best candidate logo URL (absolute)
  brandName: string | null;     // From og:site_name, title tag, or prominent h1
  tagline: string | null;       // From og:description, meta description, or subtitle
  favicon: string | null;       // Favicon URL (fallback if no logo found)
}

export interface ExtractedCSS {
  url: string;
  html: string;
  stylesheets: Array<{
    source: string; // 'inline' or URL
    content: string;
    parsed: null; // For compatibility
  }>;
  extractedAt: string;
  computedElements?: ComputedElementStyles;
  brandIdentity?: BrandIdentity;
}

export interface ComputedElementStyles {
  [selector: string]: {
    fontSize: string;
    lineHeight: string;
    fontWeight: string;
    fontFamily: string;
    color: string;
    backgroundColor: string;
    borderColor?: string;
    boxShadow?: string;
    borderRadius?: string;
  };
}

export interface DesignTokens {
  colors: {
    all: Array<{ value: string; count: number; contexts: string[] }>;
    backgrounds: string[];
    text: string[];
    borders: string[];
    accents: string[];
  };
  typography: {
    fontFamilies: Array<{ family: string; count: number }>;
    fontSizes: Array<{ size: string; count: number }>;
    fontWeights: Array<{ weight: number; count: number }>;
    lineHeights: Array<{ height: string; count: number }>;
    scale?: {
      h1?: { fontSize: string; lineHeight: string; fontWeight: number };
      h2?: { fontSize: string; lineHeight: string; fontWeight: number };
      h3?: { fontSize: string; lineHeight: string; fontWeight: number };
      body?: { fontSize: string; lineHeight: string; fontWeight: number };
      small?: { fontSize: string; lineHeight: string; fontWeight: number };
    };
  };
  visualEffects: {
    boxShadows: Array<{ value: string; count: number }>;
    textShadows: Array<{ value: string; count: number }>;
    borderRadius: Array<{ value: string; count: number }>;
    transitions: Array<{ value: string; count: number }>;
  };
}

export interface BrandTokens {
  colors: {
    primary: string;
    primaryEnd?: string;
    secondary: string;
    palette: string[];
  };
  typography: {
    headingFont: string;
    bodyFont: string;
    fontWeights: { regular: number; semibold: number; bold: number };
  };
  visualEffects: {
    primaryShadow: string;
    borderRadius: string;
  };
}

interface ExtractionOptions {
  html?: string; // For testing
  maxStylesheets?: number;
  includeExternalStylesheets?: boolean;
}

// Security: URL validation
function validateURL(urlString: string): URL {
  let url: URL;

  try {
    url = new URL(urlString);
  } catch (error) {
    throw new Error('Invalid URL format');
  }

  // Only allow HTTP and HTTPS
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must be HTTP or HTTPS');
  }

  // Prevent SSRF: Block localhost
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0') {
    throw new Error('Cannot fetch from localhost');
  }

  // Prevent SSRF: Block private IP ranges
  const privateIPRegex = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/;
  if (privateIPRegex.test(url.hostname)) {
    throw new Error('Cannot fetch from private IP ranges');
  }

  return url;
}

// Normalize color to hex format
function normalizeColor(colorValue: string): string | null {
  try {
    const color = Color(colorValue);
    return color.hex().toLowerCase();
  } catch (error) {
    return null;
  }
}

// Resolve CSS variables in stylesheet text
function resolveVariables(css: string, varMap: Record<string, string>): string {
  let resolved = css;
  // Iterative resolution for nested variables (max 10 iterations)
  for (let i = 0; i < 10; i++) {
    const before = resolved;
    resolved = resolved.replace(
      /var\(\s*(--[a-zA-Z0-9_-]+)(?:\s*,\s*([^)]+))?\s*\)/g,
      (_match, varName: string, fallback?: string) => {
        const value = varMap[varName];
        if (value !== undefined) return value;
        if (fallback !== undefined) return fallback.trim();
        return _match; // Keep unresolved
      }
    );
    if (resolved === before) break; // No more substitutions
  }
  return resolved;
}

// Extract CSS custom property declarations from CSS text
function extractCustomProperties(css: string): Record<string, string> {
  const varMap: Record<string, string> = {};
  const varDeclRegex = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+)/g;
  let match;
  while ((match = varDeclRegex.exec(css)) !== null) {
    varMap[match[1]] = match[2].trim();
  }
  // Resolve any variable references within variable values
  for (let i = 0; i < 10; i++) {
    let changed = false;
    for (const [key, value] of Object.entries(varMap)) {
      const resolved = value.replace(
        /var\(\s*(--[a-zA-Z0-9_-]+)(?:\s*,\s*([^)]+))?\s*\)/g,
        (_match, varName: string, fallback?: string) => {
          const v = varMap[varName];
          if (v !== undefined) { changed = true; return v; }
          if (fallback !== undefined) { changed = true; return fallback.trim(); }
          return _match;
        }
      );
      varMap[key] = resolved;
    }
    if (!changed) break;
  }
  return varMap;
}

// Clean a page title to extract just the brand name
// Removes common suffixes like " - Homepage", " | Home", " – Welcome"
function cleanTitleForBrandName(title: string): string {
  return title
    .split(/\s*[|\-–—:]\s*/)[0]
    .trim();
}

// Extract brand identity from a JSDOM document
function extractBrandIdentityFromDocument(
  doc: { querySelector: (s: string) => any; querySelectorAll: (s: string) => ArrayLike<any> },
  baseUrl: string
): BrandIdentity {
  // Helper to resolve relative URLs to absolute
  const toAbsolute = (href: string | null | undefined): string | null => {
    if (!href) return null;
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return href; // Already absolute or invalid
    }
  };

  // --- Brand Name ---
  const ogSiteName = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || null;
  const titleEl = doc.querySelector('title');
  const titleText = titleEl?.textContent?.trim() || null;
  const h1El = doc.querySelector('h1');
  const h1Text = h1El?.textContent?.trim() || null;

  let brandName: string | null = null;
  if (ogSiteName) {
    brandName = ogSiteName;
  } else if (titleText) {
    brandName = cleanTitleForBrandName(titleText);
  } else if (h1Text) {
    brandName = h1Text;
  }

  // --- Tagline ---
  const ogDescription = doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || null;
  const metaDescription = doc.querySelector('meta[name="description"]')?.getAttribute('content') || null;

  let tagline: string | null = null;
  if (ogDescription) {
    tagline = ogDescription;
  } else if (metaDescription) {
    tagline = metaDescription;
  }

  // --- Favicon ---
  const appleIcon = doc.querySelectorAll('link[rel="apple-touch-icon"]');
  const icons = doc.querySelectorAll('link[rel="icon"]');
  let favicon: string | null = null;
  if (appleIcon.length > 0) {
    favicon = toAbsolute(appleIcon[0].getAttribute('href'));
  } else if (icons.length > 0) {
    favicon = toAbsolute(icons[0].getAttribute('href'));
  }

  // --- Logo URL ---
  let logoUrl: string | null = null;

  // Priority 1: High-res favicon (apple-touch-icon or PNG icon)
  if (appleIcon.length > 0) {
    logoUrl = toAbsolute(appleIcon[0].getAttribute('href'));
  } else {
    for (const icon of Array.from(icons)) {
      const type = icon.getAttribute('type') || '';
      if (type.includes('png') || type.includes('image')) {
        logoUrl = toAbsolute(icon.getAttribute('href'));
        break;
      }
    }
  }

  // Priority 2: og:image
  if (!logoUrl) {
    const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;
    if (ogImage) {
      logoUrl = toAbsolute(ogImage);
    }
  }

  // Priority 3: img in header or nav
  if (!logoUrl) {
    const headerImgs = doc.querySelectorAll('header img, nav img');
    if (headerImgs.length > 0) {
      logoUrl = toAbsolute(headerImgs[0].getAttribute('src'));
    }
  }

  // Priority 4: img with "logo" in alt or class
  if (!logoUrl) {
    const allImgs = doc.querySelectorAll('img');
    for (const img of Array.from(allImgs)) {
      const alt = (img.getAttribute('alt') || '').toLowerCase();
      const cls = (img.getAttribute('class') || '').toLowerCase();
      if (alt.includes('logo') || cls.includes('logo')) {
        logoUrl = toAbsolute(img.getAttribute('src'));
        break;
      }
    }
  }

  // Priority 5: Standard favicon as last resort
  if (!logoUrl && favicon) {
    logoUrl = favicon;
  }

  return { logoUrl, brandName, tagline, favicon };
}

// Extract CSS using Puppeteer (real browser)
async function extractWithPuppeteer(
  urlString: string,
  url: URL,
  _options: ExtractionOptions
): Promise<ExtractedCSS> {
  const puppeteer = await import('puppeteer-core');
  const executablePath = findChromeExecutable();

  if (!executablePath) {
    throw new Error('No Chrome executable found');
  }

  const browser = await puppeteer.default.launch({
    executablePath,
    headless: true,
    args: PUPPETEER_LAUNCH_ARGS,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url.toString(), {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Extract all CSS data from the page
    const pageData = await page.evaluate(async () => {
      // Collect CSS custom properties from :root / documentElement
      const computedStyle = getComputedStyle(document.documentElement);
      const customProperties: Record<string, string> = {};
      for (let i = 0; i < computedStyle.length; i++) {
        const prop = computedStyle[i];
        if (prop.startsWith('--')) {
          customProperties[prop] = computedStyle.getPropertyValue(prop).trim();
        }
      }

      // Collect stylesheet text via CSSOM, with fetch fallback for CORS-blocked sheets
      const sheets: string[] = [];
      const corsBlockedUrls: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const rules = Array.from(sheet.cssRules);
          sheets.push(rules.map(r => r.cssText).join('\n'));
        } catch {
          // CORS-restricted — record URL for fetch fallback
          if (sheet.href) corsBlockedUrls.push(sheet.href);
        }
      }

      // Fetch CORS-blocked stylesheets directly (same-origin fetch from page context)
      for (const href of corsBlockedUrls) {
        try {
          const resp = await fetch(href);
          if (resp.ok) {
            sheets.push(await resp.text());
          }
        } catch {
          // Still can't access — skip
        }
      }
      const stylesheetText = sheets.join('\n');

      // Get computed styles from representative elements AND prominent visible elements
      const tagSelectors = ['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button'];
      // Also sample elements with prominent visual properties (hero sections, navs, CTAs)
      const classSelectors = [
        'nav', 'header', 'footer', 'main', 'section',
        '[class*="hero"]', '[class*="cta"]', '[class*="btn"]', '[class*="button"]',
        '[class*="primary"]', '[class*="brand"]', '[class*="accent"]',
        '[role="banner"]', '[role="navigation"]',
      ];
      const allSelectors = [...tagSelectors, ...classSelectors];

      const computedElements: Record<string, {
        fontSize: string; lineHeight: string; fontWeight: string;
        fontFamily: string; color: string; backgroundColor: string;
        borderColor: string; boxShadow: string; borderRadius: string;
      }> = {};

      for (const selector of allSelectors) {
        try {
          const el = document.querySelector(selector);
          if (el) {
            const cs = getComputedStyle(el);
            const key = selector.replace(/[[\]*"=]/g, '');
            computedElements[key] = {
              fontSize: cs.fontSize,
              lineHeight: cs.lineHeight,
              fontWeight: cs.fontWeight,
              fontFamily: cs.fontFamily,
              color: cs.color,
              backgroundColor: cs.backgroundColor,
              borderColor: cs.borderColor,
              boxShadow: cs.boxShadow,
              borderRadius: cs.borderRadius,
            };
          }
        } catch {
          // Invalid selector or element not found
        }
      }

      // --- Brand Identity Extraction ---
      const toAbsoluteUrl = (href: string | null | undefined): string | null => {
        if (!href) return null;
        try { return new URL(href, document.baseURI).toString(); } catch { return href; }
      };

      // Brand name
      const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || null;
      const titleEl = document.querySelector('title');
      const titleText = titleEl?.textContent?.trim() || null;
      const h1El = document.querySelector('h1');
      const h1Text = h1El?.textContent?.trim() || null;
      let brandName: string | null = null;
      if (ogSiteName) brandName = ogSiteName;
      else if (titleText) brandName = titleText.split(/\s*[|\-–—:]\s*/)[0].trim();
      else if (h1Text) brandName = h1Text;

      // Tagline
      const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || null;
      const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || null;
      const tagline = ogDesc || metaDesc || null;

      // Favicon
      const appleIcons = document.querySelectorAll('link[rel="apple-touch-icon"]');
      const linkIcons = document.querySelectorAll('link[rel="icon"]');
      let favicon: string | null = null;
      if (appleIcons.length > 0) favicon = toAbsoluteUrl((appleIcons[0] as HTMLLinkElement).href);
      else if (linkIcons.length > 0) favicon = toAbsoluteUrl((linkIcons[0] as HTMLLinkElement).href);

      // Logo URL (priority cascade)
      let logoUrl: string | null = null;
      // P1: apple-touch-icon or PNG icon
      if (appleIcons.length > 0) {
        logoUrl = toAbsoluteUrl((appleIcons[0] as HTMLLinkElement).href);
      } else {
        for (const icon of Array.from(linkIcons)) {
          const type = (icon as HTMLLinkElement).type || '';
          if (type.includes('png') || type.includes('image')) {
            logoUrl = toAbsoluteUrl((icon as HTMLLinkElement).href);
            break;
          }
        }
      }
      // P2: og:image
      if (!logoUrl) {
        const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;
        if (ogImg) logoUrl = toAbsoluteUrl(ogImg);
      }
      // P3: img in header/nav
      if (!logoUrl) {
        const headerImgs = document.querySelectorAll('header img, nav img');
        if (headerImgs.length > 0) logoUrl = toAbsoluteUrl((headerImgs[0] as HTMLImageElement).src);
      }
      // P4: img with "logo" in alt/class
      if (!logoUrl) {
        const allImgs = document.querySelectorAll('img');
        for (const img of Array.from(allImgs)) {
          const alt = ((img as HTMLImageElement).alt || '').toLowerCase();
          const cls = ((img as HTMLImageElement).className || '').toLowerCase();
          if (alt.includes('logo') || cls.includes('logo')) {
            logoUrl = toAbsoluteUrl((img as HTMLImageElement).src);
            break;
          }
        }
      }
      // P5: favicon fallback
      if (!logoUrl && favicon) logoUrl = favicon;

      const brandIdentity = { logoUrl, brandName, tagline, favicon };

      return {
        customProperties,
        stylesheetText,
        computedElements,
        brandIdentity,
        debug: {
          totalSheets: document.styleSheets.length,
          corsBlocked: corsBlockedUrls.length,
          sheetsCollected: sheets.length,
          customPropsCount: Object.keys(customProperties).length,
          elementsFound: Object.keys(computedElements).length,
        },
      };
    });

    // Log extraction debug info
    const dbg = (pageData as any).debug;
    if (dbg) {
      console.log(`Puppeteer extraction: ${dbg.totalSheets} total sheets, ${dbg.corsBlocked} CORS-blocked, ` +
        `${dbg.sheetsCollected} collected, ${dbg.customPropsCount} custom props, ${dbg.elementsFound} elements`);
    }

    // Resolve variables in the stylesheet text
    const resolvedCSS = resolveVariables(pageData.stylesheetText, pageData.customProperties);

    // Synthesize CSS from custom properties — map color-like values into parseable declarations
    // so the regex extractor can pick them up. Also categorize by property name hints.
    const customPropLines: string[] = [];
    for (const [name, value] of Object.entries(pageData.customProperties as Record<string, string>)) {
      const nameLower = name.toLowerCase();
      // Determine context from property name
      if (nameLower.includes('background') || nameLower.includes('bg')) {
        customPropLines.push(`.cp { background-color: ${value}; }`);
      } else if (nameLower.includes('border')) {
        customPropLines.push(`.cp { border-color: ${value}; }`);
      } else if (nameLower.includes('color') || nameLower.includes('text') ||
                 nameLower.includes('primary') || nameLower.includes('secondary') ||
                 nameLower.includes('accent') || nameLower.includes('brand')) {
        customPropLines.push(`.cp { color: ${value}; }`);
      } else {
        // Try to detect if value looks like a color
        const trimmed = value.trim();
        if (/^#[0-9a-f]{3,8}$/i.test(trimmed) || /^rgba?\(/.test(trimmed) || /^hsla?\(/.test(trimmed)) {
          customPropLines.push(`.cp { color: ${value}; }`);
        }
        // Non-color values (dimensions, strings, etc.) are skipped
      }
    }
    const customPropCSS = customPropLines.join('\n');

    const html = ''; // Not needed when using puppeteer
    const stylesheets: ExtractedCSS['stylesheets'] = [];
    if (resolvedCSS.trim()) {
      stylesheets.push({
        source: 'puppeteer-cssom',
        content: resolvedCSS,
        parsed: null,
      });
    }
    if (customPropCSS.trim()) {
      stylesheets.push({
        source: 'puppeteer-custom-properties',
        content: customPropCSS,
        parsed: null,
      });
    }

    await page.close();

    return {
      url: urlString,
      html,
      stylesheets,
      extractedAt: new Date().toISOString(),
      computedElements: pageData.computedElements,
      brandIdentity: (pageData as any).brandIdentity as BrandIdentity,
    };
  } finally {
    await browser.close();
  }
}

// Extract CSS using JSDOM (fallback path)
async function extractWithJSDOM(
  urlString: string,
  url: URL,
  html: string | undefined,
  options: ExtractionOptions
): Promise<ExtractedCSS> {
  const maxStylesheets = options.maxStylesheets ?? 10;
  const includeExternalStylesheets = options.includeExternalStylesheets ?? true;

  let htmlContent: string;

  if (html) {
    htmlContent = html;
  } else {
    try {
      const response = await axios.get(url.toString(), {
        timeout: 30000,
        headers: { 'User-Agent': 'AgentWeb-CSS-Extractor/1.0' },
        responseType: 'text',
      });
      htmlContent = String(response.data);
    } catch (error: any) {
      throw new Error(`Failed to fetch URL: ${error.message}`);
    }
  }

  const dom = new JSDOM(htmlContent);
  const document = dom.window.document;

  const stylesheets: ExtractedCSS['stylesheets'] = [];

  // Extract inline styles
  const styleElements = document.querySelectorAll('style');
  styleElements.forEach((styleElement) => {
    const content = styleElement.textContent || '';
    if (content.trim()) {
      stylesheets.push({ source: 'inline', content, parsed: null });
    }
  });

  // Extract external stylesheets (if enabled and not in test mode)
  if (includeExternalStylesheets && !html) {
    const linkElements = document.querySelectorAll('link[rel="stylesheet"]');
    let fetchedCount = 0;

    for (const linkElement of Array.from(linkElements)) {
      if (fetchedCount >= maxStylesheets) break;

      const href = linkElement.getAttribute('href');
      if (!href) continue;

      try {
        const stylesheetURL = new URL(href, url);
        validateURL(stylesheetURL.toString());

        const response = await axios.get(stylesheetURL.toString(), {
          timeout: 10000,
          headers: { 'User-Agent': 'AgentWeb-CSS-Extractor/1.0' },
          responseType: 'text',
        });

        stylesheets.push({
          source: stylesheetURL.toString(),
          content: String(response.data),
          parsed: null,
        });
        fetchedCount++;
      } catch (error) {
        console.warn(`Failed to fetch stylesheet ${href}:`, error);
      }
    }
  }

  // Extract brand identity from the document
  const brandIdentity = extractBrandIdentityFromDocument(document, url.toString());

  return {
    url: urlString,
    html: htmlContent,
    stylesheets,
    extractedAt: new Date().toISOString(),
    brandIdentity,
  };
}

// Extract CSS from URL or provided HTML
export async function extractCSSFromURL(
  urlString: string,
  options: ExtractionOptions = {}
): Promise<ExtractedCSS> {
  // Validate URL
  const url = validateURL(urlString);

  // If HTML is provided (test mode), use JSDOM path directly
  if (options.html) {
    return extractWithJSDOM(urlString, url, options.html, options);
  }

  // Try puppeteer first (real browser), fall back to JSDOM
  try {
    return await extractWithPuppeteer(urlString, url, options);
  } catch (error) {
    console.warn('Puppeteer extraction failed, falling back to JSDOM:', error);
    return extractWithJSDOM(urlString, url, undefined, options);
  }
}

// Analyze CSS and extract design tokens
export async function analyzeDesignTokens(cssData: ExtractedCSS): Promise<DesignTokens> {
  // First, resolve CSS variables in all stylesheets
  const allCSS = cssData.stylesheets.map(s => s.content).join('\n');
  const varMap = extractCustomProperties(allCSS);

  // Create resolved stylesheets
  const resolvedStylesheets = cssData.stylesheets.map(s => ({
    ...s,
    content: resolveVariables(s.content, varMap),
  }));

  // Try to use @projectwallace/css-analyzer for structured analysis
  let wallaceResult: any = null;
  const resolvedCSS = resolvedStylesheets.map(s => s.content).join('\n');
  if (resolvedCSS.trim()) {
    try {
      const { analyze } = await import('@projectwallace/css-analyzer');
      wallaceResult = analyze(resolvedCSS);
    } catch (error) {
      // css-analyzer not available or failed — fall back to regex
      console.warn('css-analyzer failed, using regex fallback:', error);
    }
  }

  // Extract tokens using regex from resolved CSS (always needed for context categorization)
  const regexTokens = extractTokensWithRegex(resolvedStylesheets);

  // If wallace analyzer succeeded, enhance with its output
  if (wallaceResult) {
    return mergeWallaceWithRegex(wallaceResult, regexTokens, cssData.computedElements);
  }

  // Pure regex path (fallback)
  return addComputedScale(regexTokens, cssData.computedElements);
}

// Extract tokens using regex (the original approach, now on resolved CSS)
function extractTokensWithRegex(
  stylesheets: Array<{ content: string }>
): DesignTokens {
  const colorMap = new Map<string, { count: number; contexts: string[] }>();
  const fontFamilyMap = new Map<string, number>();
  const fontSizeMap = new Map<string, number>();
  const fontWeightMap = new Map<number, number>();
  const lineHeightMap = new Map<string, number>();
  const boxShadowMap = new Map<string, number>();
  const borderRadiusMap = new Map<string, number>();

  const backgroundColors: Set<string> = new Set();
  const textColors: Set<string> = new Set();
  const borderColors: Set<string> = new Set();

  for (const stylesheet of stylesheets) {
    const css = stylesheet.content;

    extractColorsWithContext(css, colorMap, backgroundColors, textColors, borderColors);

    const fontFamilyRegex = /font-family\s*:\s*([^;{}]+)/gi;
    let match;
    while ((match = fontFamilyRegex.exec(css)) !== null) {
      const family = extractFontFamily(match[1]);
      if (family) {
        fontFamilyMap.set(family, (fontFamilyMap.get(family) || 0) + 1);
      }
    }

    const fontSizeRegex = /font-size\s*:\s*([^;{}]+)/gi;
    while ((match = fontSizeRegex.exec(css)) !== null) {
      const size = match[1].trim();
      if (size) fontSizeMap.set(size, (fontSizeMap.get(size) || 0) + 1);
    }

    const fontWeightRegex = /font-weight\s*:\s*(\d+)/gi;
    while ((match = fontWeightRegex.exec(css)) !== null) {
      const weight = parseInt(match[1]);
      if (!isNaN(weight)) fontWeightMap.set(weight, (fontWeightMap.get(weight) || 0) + 1);
    }

    const lineHeightRegex = /line-height\s*:\s*([^;{}]+)/gi;
    while ((match = lineHeightRegex.exec(css)) !== null) {
      const height = match[1].trim();
      if (height) lineHeightMap.set(height, (lineHeightMap.get(height) || 0) + 1);
    }

    const boxShadowRegex = /box-shadow\s*:\s*([^;{}]+)/gi;
    while ((match = boxShadowRegex.exec(css)) !== null) {
      const shadow = match[1].trim().replace(/\s+/g, ' ');
      if (shadow && shadow !== 'none') boxShadowMap.set(shadow, (boxShadowMap.get(shadow) || 0) + 1);
    }

    const borderRadiusRegex = /border-radius\s*:\s*([^;{}]+)/gi;
    while ((match = borderRadiusRegex.exec(css)) !== null) {
      const radius = match[1].trim();
      if (radius) borderRadiusMap.set(radius, (borderRadiusMap.get(radius) || 0) + 1);
    }
  }

  const colors = Array.from(colorMap.entries())
    .map(([value, data]) => ({ value, count: data.count, contexts: data.contexts }))
    .sort((a, b) => b.count - a.count);

  const accentColors = colors
    .filter(c => {
      try {
        const color = Color(c.value);
        const lightness = color.lightness();
        return lightness > 10 && lightness < 90 && c.value !== '#ffffff' && c.value !== '#000000';
      } catch { return false; }
    })
    .map(c => c.value);

  return {
    colors: {
      all: colors,
      backgrounds: Array.from(backgroundColors),
      text: Array.from(textColors),
      borders: Array.from(borderColors),
      accents: accentColors,
    },
    typography: {
      fontFamilies: Array.from(fontFamilyMap.entries())
        .map(([family, count]) => ({ family, count }))
        .sort((a, b) => b.count - a.count),
      fontSizes: Array.from(fontSizeMap.entries())
        .map(([size, count]) => ({ size, count }))
        .sort((a, b) => b.count - a.count),
      fontWeights: Array.from(fontWeightMap.entries())
        .map(([weight, count]) => ({ weight, count }))
        .sort((a, b) => b.count - a.count),
      lineHeights: Array.from(lineHeightMap.entries())
        .map(([height, count]) => ({ height, count }))
        .sort((a, b) => b.count - a.count),
    },
    visualEffects: {
      boxShadows: Array.from(boxShadowMap.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count),
      textShadows: [],
      borderRadius: Array.from(borderRadiusMap.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count),
      transitions: [],
    },
  };
}

// Merge Wallace analyzer output with regex-extracted context data
function mergeWallaceWithRegex(
  wallace: any,
  regexTokens: DesignTokens,
  computedElements?: ComputedElementStyles
): DesignTokens {
  const result = { ...regexTokens };

  // Helper: wallace .unique fields are frequency maps ({ value: count }), not arrays
  const wallaceKeys = (unique: unknown): string[] =>
    unique && typeof unique === 'object' && !Array.isArray(unique)
      ? Object.keys(unique as Record<string, unknown>)
      : Array.isArray(unique) ? (unique as string[]) : [];

  // Enhance colors with wallace unique values
  for (const colorStr of wallaceKeys(wallace.values?.colors?.unique)) {
    const normalized = normalizeColor(colorStr);
    if (normalized && !result.colors.all.some(c => c.value === normalized)) {
      result.colors.all.push({ value: normalized, count: 1, contexts: [] });
    }
  }

  // Enhance font families
  for (const family of wallaceKeys(wallace.values?.fontFamilies?.unique)) {
    const cleaned = family.replace(/['"]/g, '').split(',')[0].trim();
    if (cleaned && !result.typography.fontFamilies.some(f => f.family === cleaned)) {
      result.typography.fontFamilies.push({ family: cleaned, count: 1 });
    }
  }

  // Enhance font sizes
  for (const size of wallaceKeys(wallace.values?.fontSizes?.unique)) {
    if (!result.typography.fontSizes.some(f => f.size === size)) {
      result.typography.fontSizes.push({ size, count: 1 });
    }
  }

  // Enhance line heights
  for (const height of wallaceKeys(wallace.values?.lineHeights?.unique)) {
    if (!result.typography.lineHeights.some(l => l.height === height)) {
      result.typography.lineHeights.push({ height, count: 1 });
    }
  }

  // Enhance box shadows
  for (const shadow of wallaceKeys(wallace.values?.boxShadows?.unique)) {
    if (!result.visualEffects.boxShadows.some(s => s.value === shadow)) {
      result.visualEffects.boxShadows.push({ value: shadow, count: 1 });
    }
  }

  // Enhance text shadows
  for (const shadow of wallaceKeys(wallace.values?.textShadows?.unique)) {
    result.visualEffects.textShadows.push({ value: shadow, count: 1 });
  }

  // Enhance border radius
  for (const radius of wallaceKeys(wallace.values?.borderRadiuses?.unique)) {
    if (!result.visualEffects.borderRadius.some(r => r.value === radius)) {
      result.visualEffects.borderRadius.push({ value: radius, count: 1 });
    }
  }

  return addComputedScale(result, computedElements);
}

// Add typography scale from computed element styles
function addComputedScale(
  tokens: DesignTokens,
  computedElements?: ComputedElementStyles
): DesignTokens {
  if (!computedElements) return tokens;

  const scale: NonNullable<DesignTokens['typography']['scale']> = {};

  if (computedElements.h1) {
    scale.h1 = {
      fontSize: computedElements.h1.fontSize,
      lineHeight: computedElements.h1.lineHeight,
      fontWeight: parseInt(computedElements.h1.fontWeight) || 700,
    };
  }
  if (computedElements.h2) {
    scale.h2 = {
      fontSize: computedElements.h2.fontSize,
      lineHeight: computedElements.h2.lineHeight,
      fontWeight: parseInt(computedElements.h2.fontWeight) || 700,
    };
  }
  if (computedElements.h3) {
    scale.h3 = {
      fontSize: computedElements.h3.fontSize,
      lineHeight: computedElements.h3.lineHeight,
      fontWeight: parseInt(computedElements.h3.fontWeight) || 600,
    };
  }
  if (computedElements.body) {
    scale.body = {
      fontSize: computedElements.body.fontSize,
      lineHeight: computedElements.body.lineHeight,
      fontWeight: parseInt(computedElements.body.fontWeight) || 400,
    };
  }
  if (computedElements.small) {
    scale.small = {
      fontSize: computedElements.small.fontSize,
      lineHeight: computedElements.small.lineHeight,
      fontWeight: parseInt(computedElements.small.fontWeight) || 400,
    };
  }

  if (Object.keys(scale).length > 0) {
    tokens.typography.scale = scale;
  }

  // Enrich tokens from computed element styles
  for (const [selector, styles] of Object.entries(computedElements)) {
    // Colors — with proper context categorization
    if (styles.color && styles.color !== 'transparent') {
      const normalized = normalizeColor(styles.color);
      if (normalized) {
        const existing = tokens.colors.all.find(c => c.value === normalized);
        if (existing) {
          existing.count++;
          if (!existing.contexts.includes('color')) existing.contexts.push('color');
        } else {
          tokens.colors.all.push({ value: normalized, count: 1, contexts: ['color'] });
        }
        if (!tokens.colors.text.includes(normalized)) {
          tokens.colors.text.push(normalized);
        }
      }
    }
    if (styles.backgroundColor && styles.backgroundColor !== 'transparent' && styles.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      const normalized = normalizeColor(styles.backgroundColor);
      if (normalized) {
        const existing = tokens.colors.all.find(c => c.value === normalized);
        if (existing) {
          existing.count++;
          if (!existing.contexts.includes('background')) existing.contexts.push('background');
        } else {
          tokens.colors.all.push({ value: normalized, count: 1, contexts: ['background'] });
        }
        if (!tokens.colors.backgrounds.includes(normalized)) {
          tokens.colors.backgrounds.push(normalized);
        }
      }
    }
    if (styles.borderColor && styles.borderColor !== 'transparent' && styles.borderColor !== 'rgba(0, 0, 0, 0)') {
      const normalized = normalizeColor(styles.borderColor);
      if (normalized) {
        const existing = tokens.colors.all.find(c => c.value === normalized);
        if (existing) {
          existing.count++;
          if (!existing.contexts.includes('border')) existing.contexts.push('border');
        } else {
          tokens.colors.all.push({ value: normalized, count: 1, contexts: ['border'] });
        }
        if (!tokens.colors.borders.includes(normalized)) {
          tokens.colors.borders.push(normalized);
        }
      }
    }

    // Font family
    if (styles.fontFamily) {
      const family = styles.fontFamily.replace(/['"]/g, '').split(',')[0].trim();
      if (family) {
        const existing = tokens.typography.fontFamilies.find(f => f.family === family);
        if (existing) {
          existing.count++;
        } else {
          tokens.typography.fontFamilies.push({ family, count: 1 });
        }
      }
    }

    // Font weight
    if (styles.fontWeight) {
      const weight = parseInt(styles.fontWeight);
      if (!isNaN(weight)) {
        const existing = tokens.typography.fontWeights.find(w => w.weight === weight);
        if (existing) {
          existing.count++;
        } else {
          tokens.typography.fontWeights.push({ weight, count: 1 });
        }
      }
    }

    // Box shadow
    if (styles.boxShadow && styles.boxShadow !== 'none') {
      const shadow = styles.boxShadow.trim();
      if (!tokens.visualEffects.boxShadows.some(s => s.value === shadow)) {
        tokens.visualEffects.boxShadows.push({ value: shadow, count: 1 });
      }
    }

    // Border radius
    if (styles.borderRadius && styles.borderRadius !== '0px') {
      const radius = styles.borderRadius.trim();
      if (!tokens.visualEffects.borderRadius.some(r => r.value === radius)) {
        tokens.visualEffects.borderRadius.push({ value: radius, count: 1 });
      }
    }
  }

  // Re-sort colors by count after enrichment
  tokens.colors.all.sort((a, b) => b.count - a.count);

  // Recalculate accent colors
  tokens.colors.accents = tokens.colors.all
    .filter(c => {
      try {
        const color = Color(c.value);
        const lightness = color.lightness();
        return lightness > 10 && lightness < 90 && c.value !== '#ffffff' && c.value !== '#000000';
      } catch { return false; }
    })
    .map(c => c.value);

  return tokens;
}

// Extract colors with context
function extractColorsWithContext(
  css: string,
  colorMap: Map<string, { count: number; contexts: string[] }>,
  backgroundColors: Set<string>,
  textColors: Set<string>,
  borderColors: Set<string>
) {
  const propertyRegex = /(background-color|background|color|border-color|border)\s*:\s*([^;{}]+)/gi;
  let match;

  while ((match = propertyRegex.exec(css)) !== null) {
    const property = match[1].toLowerCase();
    const value = match[2];

    const colors = extractColorsFromValue(value);
    colors.forEach(color => {
      const normalized = normalizeColor(color);
      if (normalized) {
        const existing = colorMap.get(normalized) || { count: 0, contexts: [] };
        existing.count++;
        if (!existing.contexts.includes(property)) {
          existing.contexts.push(property);
        }
        colorMap.set(normalized, existing);

        if (property.includes('background')) {
          backgroundColors.add(normalized);
        } else if (property === 'color') {
          textColors.add(normalized);
        } else if (property.includes('border')) {
          borderColors.add(normalized);
        }
      }
    });
  }
}

// Extract color values from CSS value string
function extractColorsFromValue(value: string): string[] {
  const colors: string[] = [];

  const hexRegex = /#[0-9A-Fa-f]{3,6}\b/g;
  const hexMatches = value.match(hexRegex);
  if (hexMatches) colors.push(...hexMatches);

  const rgbRegex = /rgba?\([^)]+\)/g;
  const rgbMatches = value.match(rgbRegex);
  if (rgbMatches) colors.push(...rgbMatches);

  const hslRegex = /hsla?\([^)]+\)/g;
  const hslMatches = value.match(hslRegex);
  if (hslMatches) colors.push(...hslMatches);

  return colors;
}

// Extract font family from CSS value
function extractFontFamily(value: string): string | null {
  const cleaned = value
    .replace(/['"]/g, '')
    .split(',')[0]
    .trim();

  return cleaned || null;
}

// Infer brand tokens from design tokens
export function inferBrandTokens(tokens: DesignTokens): BrandTokens {
  // Use accent colors as primary/secondary candidates — these exclude black, white,
  // and near-black/near-white which are almost always text/background, not brand colors
  const accentCandidates = tokens.colors.accents.length > 0
    ? tokens.colors.all.filter(c => tokens.colors.accents.includes(c.value))
        .sort((a, b) => b.count - a.count)
    : tokens.colors.all.filter(c => {
        try {
          const color = Color(c.value);
          const lightness = color.lightness();
          return lightness > 10 && lightness < 90;
        } catch { return false; }
      });

  const primary = accentCandidates[0]?.value || tokens.colors.all[0]?.value || '#000000';
  const secondary = accentCandidates[1]?.value || accentCandidates[0]?.value || '#333333';

  const palette = tokens.colors.all
    .filter(c => c.value !== '#ffffff' || tokens.colors.all.length < 5)
    .slice(0, 10)
    .map(c => c.value);

  // Use typography scale if available for better font detection
  let bodyFont: string;
  let headingFont: string;

  if (tokens.typography.scale?.body?.fontSize && tokens.typography.scale?.h1?.fontSize) {
    // If we have computed scale data, use font families from frequency
    bodyFont = tokens.typography.fontFamilies[0]?.family || 'sans-serif';
    headingFont = tokens.typography.fontFamilies[1]?.family || tokens.typography.fontFamilies[0]?.family || 'sans-serif';
  } else {
    bodyFont = tokens.typography.fontFamilies[0]?.family || 'sans-serif';
    headingFont = tokens.typography.fontFamilies[1]?.family || tokens.typography.fontFamilies[0]?.family || 'sans-serif';
  }

  const weightsList = tokens.typography.fontWeights.map(w => w.weight);
  const regular = weightsList.find(w => w === 400) || weightsList[0] || 400;
  const semibold = weightsList.find(w => w === 600) || weightsList.find(w => w > 400 && w < 700) || 600;
  const bold = weightsList.find(w => w === 700) || weightsList.find(w => w >= 700) || 700;

  const primaryShadow = tokens.visualEffects.boxShadows[0]?.value || 'none';
  const borderRadius = tokens.visualEffects.borderRadius[0]?.value || '0';

  return {
    colors: { primary, secondary, palette },
    typography: {
      headingFont,
      bodyFont,
      fontWeights: { regular, semibold, bold },
    },
    visualEffects: { primaryShadow, borderRadius },
  };
}
