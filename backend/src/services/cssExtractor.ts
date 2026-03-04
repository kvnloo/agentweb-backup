import { JSDOM } from 'jsdom';
import Color from 'color';
import axios from 'axios';

// Type definitions
export interface ExtractedCSS {
  url: string;
  html: string;
  stylesheets: Array<{
    source: string; // 'inline' or URL
    content: string;
    parsed: null; // For compatibility
  }>;
  extractedAt: string;
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

// Extract CSS from URL or provided HTML
export async function extractCSSFromURL(
  urlString: string,
  options: ExtractionOptions = {}
): Promise<ExtractedCSS> {
  // Validate URL
  const url = validateURL(urlString);

  const maxStylesheets = options.maxStylesheets ?? 10;
  const includeExternalStylesheets = options.includeExternalStylesheets ?? true;

  let html: string;

  // Use provided HTML for testing, otherwise fetch
  if (options.html) {
    html = options.html;
  } else {
    try {
      const response = await axios.get(url.toString(), {
        timeout: 30000, // 30 second timeout
        headers: {
          'User-Agent': 'AgentWeb-CSS-Extractor/1.0'
        },
        responseType: 'text'
      });
      html = String(response.data);
    } catch (error: any) {
      throw new Error(`Failed to fetch URL: ${error.message}`);
    }
  }

  // Parse HTML with JSDOM
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const stylesheets: ExtractedCSS['stylesheets'] = [];

  // Extract inline styles
  const styleElements = document.querySelectorAll('style');
  styleElements.forEach((styleElement) => {
    const content = styleElement.textContent || '';
    if (content.trim()) {
      stylesheets.push({
        source: 'inline',
        content,
        parsed: null
      });
    }
  });

  // Extract external stylesheets (if enabled and not in test mode)
  if (includeExternalStylesheets && !options.html) {
    const linkElements = document.querySelectorAll('link[rel="stylesheet"]');
    let fetchedCount = 0;

    for (const linkElement of Array.from(linkElements)) {
      if (fetchedCount >= maxStylesheets) {
        break;
      }

      const href = linkElement.getAttribute('href');
      if (!href) continue;

      try {
        // Resolve relative URLs
        const stylesheetURL = new URL(href, url);

        // Validate the stylesheet URL too (prevent SSRF)
        validateURL(stylesheetURL.toString());

        const response = await axios.get(stylesheetURL.toString(), {
          timeout: 10000,
          headers: {
            'User-Agent': 'AgentWeb-CSS-Extractor/1.0'
          },
          responseType: 'text'
        });

        const content = String(response.data);

        stylesheets.push({
          source: stylesheetURL.toString(),
          content,
          parsed: null
        });

        fetchedCount++;
      } catch (error) {
        console.warn(`Failed to fetch stylesheet ${href}:`, error);
      }
    }
  }

  return {
    url: urlString,
    html,
    stylesheets,
    extractedAt: new Date().toISOString()
  };
}

// Analyze CSS and extract design tokens using regex
export function analyzeDesignTokens(cssData: ExtractedCSS): DesignTokens {
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

  // Process each stylesheet
  for (const stylesheet of cssData.stylesheets) {
    const css = stylesheet.content;

    // Extract colors
    extractColorsWithContext(css, colorMap, backgroundColors, textColors, borderColors);

    // Extract font families
    const fontFamilyRegex = /font-family\s*:\s*([^;{}]+)/gi;
    let match;
    while ((match = fontFamilyRegex.exec(css)) !== null) {
      const family = extractFontFamily(match[1]);
      if (family) {
        fontFamilyMap.set(family, (fontFamilyMap.get(family) || 0) + 1);
      }
    }

    // Extract font sizes
    const fontSizeRegex = /font-size\s*:\s*([^;{}]+)/gi;
    while ((match = fontSizeRegex.exec(css)) !== null) {
      const size = match[1].trim();
      if (size) {
        fontSizeMap.set(size, (fontSizeMap.get(size) || 0) + 1);
      }
    }

    // Extract font weights
    const fontWeightRegex = /font-weight\s*:\s*(\d+)/gi;
    while ((match = fontWeightRegex.exec(css)) !== null) {
      const weight = parseInt(match[1]);
      if (!isNaN(weight)) {
        fontWeightMap.set(weight, (fontWeightMap.get(weight) || 0) + 1);
      }
    }

    // Extract line heights
    const lineHeightRegex = /line-height\s*:\s*([^;{}]+)/gi;
    while ((match = lineHeightRegex.exec(css)) !== null) {
      const height = match[1].trim();
      if (height) {
        lineHeightMap.set(height, (lineHeightMap.get(height) || 0) + 1);
      }
    }

    // Extract box shadows
    const boxShadowRegex = /box-shadow\s*:\s*([^;{}]+)/gi;
    while ((match = boxShadowRegex.exec(css)) !== null) {
      const shadow = match[1].trim().replace(/\s+/g, ' ');
      if (shadow && shadow !== 'none') {
        boxShadowMap.set(shadow, (boxShadowMap.get(shadow) || 0) + 1);
      }
    }

    // Extract border radius
    const borderRadiusRegex = /border-radius\s*:\s*([^;{}]+)/gi;
    while ((match = borderRadiusRegex.exec(css)) !== null) {
      const radius = match[1].trim();
      if (radius) {
        borderRadiusMap.set(radius, (borderRadiusMap.get(radius) || 0) + 1);
      }
    }
  }

  // Convert maps to arrays, sorted by frequency
  const colors = Array.from(colorMap.entries())
    .map(([value, data]) => ({ value, count: data.count, contexts: data.contexts }))
    .sort((a, b) => b.count - a.count);

  const fontFamilies = Array.from(fontFamilyMap.entries())
    .map(([family, count]) => ({ family, count }))
    .sort((a, b) => b.count - a.count);

  const fontSizes = Array.from(fontSizeMap.entries())
    .map(([size, count]) => ({ size, count }))
    .sort((a, b) => b.count - a.count);

  const fontWeights = Array.from(fontWeightMap.entries())
    .map(([weight, count]) => ({ weight, count }))
    .sort((a, b) => b.count - a.count);

  const lineHeights = Array.from(lineHeightMap.entries())
    .map(([height, count]) => ({ height, count }))
    .sort((a, b) => b.count - a.count);

  const boxShadows = Array.from(boxShadowMap.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  const borderRadius = Array.from(borderRadiusMap.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  // Infer accent colors (exclude white, black, and very light/dark colors)
  const accentColors = colors
    .filter(c => {
      try {
        const color = Color(c.value);
        const lightness = color.lightness();
        return lightness > 10 && lightness < 90 && c.value !== '#ffffff' && c.value !== '#000000';
      } catch {
        return false;
      }
    })
    .map(c => c.value);

  return {
    colors: {
      all: colors,
      backgrounds: Array.from(backgroundColors),
      text: Array.from(textColors),
      borders: Array.from(borderColors),
      accents: accentColors
    },
    typography: {
      fontFamilies,
      fontSizes,
      fontWeights,
      lineHeights
    },
    visualEffects: {
      boxShadows,
      textShadows: [],
      borderRadius,
      transitions: []
    }
  };
}

// Extract colors with context
function extractColorsWithContext(
  css: string,
  colorMap: Map<string, { count: number; contexts: string[] }>,
  backgroundColors: Set<string>,
  textColors: Set<string>,
  borderColors: Set<string>
) {
  // Extract all CSS properties with colors
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

        // Categorize colors
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

  // Hex colors
  const hexRegex = /#[0-9A-Fa-f]{3,6}\b/g;
  const hexMatches = value.match(hexRegex);
  if (hexMatches) {
    colors.push(...hexMatches);
  }

  // RGB/RGBA
  const rgbRegex = /rgba?\([^)]+\)/g;
  const rgbMatches = value.match(rgbRegex);
  if (rgbMatches) {
    colors.push(...rgbMatches);
  }

  // HSL/HSLA
  const hslRegex = /hsla?\([^)]+\)/g;
  const hslMatches = value.match(hslRegex);
  if (hslMatches) {
    colors.push(...hslMatches);
  }

  return colors;
}

// Extract font family from CSS value
function extractFontFamily(value: string): string | null {
  // Remove quotes and clean up
  const cleaned = value
    .replace(/['"]/g, '')
    .split(',')[0] // Take the first font in the stack
    .trim();

  return cleaned || null;
}

// Infer brand tokens from design tokens
export function inferBrandTokens(tokens: DesignTokens): BrandTokens {
  // Find primary color (most frequent non-background color)
  const nonBackgroundColors = tokens.colors.all.filter(c => {
    return !tokens.colors.backgrounds.includes(c.value) ||
           (c.value !== '#ffffff' && c.value !== '#000000');
  });

  const primary = nonBackgroundColors[0]?.value || tokens.colors.all[0]?.value || '#000000';

  // Find secondary color (second most frequent accent)
  const secondary = nonBackgroundColors[1]?.value || nonBackgroundColors[0]?.value || '#333333';

  // Build palette (top 10 colors, excluding white if it's too common)
  const palette = tokens.colors.all
    .filter(c => c.value !== '#ffffff' || tokens.colors.all.length < 5)
    .slice(0, 10)
    .map(c => c.value);

  // Font selection
  const bodyFont = tokens.typography.fontFamilies[0]?.family || 'sans-serif';
  const headingFont = tokens.typography.fontFamilies[1]?.family || tokens.typography.fontFamilies[0]?.family || 'sans-serif';

  // Font weights
  const weightsList = tokens.typography.fontWeights.map(w => w.weight);
  const regular = weightsList.find(w => w === 400) || weightsList[0] || 400;
  const semibold = weightsList.find(w => w === 600) || weightsList.find(w => w > 400 && w < 700) || 600;
  const bold = weightsList.find(w => w === 700) || weightsList.find(w => w >= 700) || 700;

  // Visual effects
  const primaryShadow = tokens.visualEffects.boxShadows[0]?.value || 'none';
  const borderRadius = tokens.visualEffects.borderRadius[0]?.value || '0';

  return {
    colors: {
      primary,
      secondary,
      palette
    },
    typography: {
      headingFont,
      bodyFont,
      fontWeights: {
        regular,
        semibold,
        bold
      }
    },
    visualEffects: {
      primaryShadow,
      borderRadius
    }
  };
}
