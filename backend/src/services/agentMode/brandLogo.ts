/**
 * Brand-logo handling for AgentMode + onboarding (ENG-326).
 *
 * The customer's real logo must be a persisted brand asset — never something
 * an image model invents on the fly. This module owns the deterministic
 * pieces of that contract:
 *
 *   - `downloadBrandLogoToS3` — the download + S3 persist block extracted
 *     (behavior-preserving) out of `agentModeService.extractCSSFromURL`.
 *   - `ensureBrandLogoPersisted` — the deterministic post-scrape onboarding
 *     step: if the Emma brand-build session left no logo on the account,
 *     discover one with the existing cssExtractor heuristics, pin it to S3,
 *     and persist it as `brandData.logoUrl` + a `logo` brand asset (AC-1).
 *   - `getPersistedBrandLogoUrl(ForUser)` — the one shared resolution order
 *     for "what is this account's logo": attachments `logo` asset (an
 *     explicit brand-config upload wins) → brandData.logoUrl → legacy
 *     brandAssets array (org-aware for the ForUser variant).
 *   - `promptRequestsLogo` + `missingBrandLogoToolResult` — the generate_image
 *     gate: prompts that ask for a logo either composite the persisted one or
 *     come back as an explicit ask-the-user result pointing at brand config
 *     (AC-2 / AC-3). Never a silent invented logo.
 *
 * All external boundaries (axios, S3, Dynamo, cssExtractor, the
 * brand-guidelines write path) are lazy-loaded and injectable so every branch
 * is unit-testable with mocks.
 */

export interface BrandGuidelinesLike {
  brandData?: Record<string, unknown>;
  attachments?: unknown;
  /** Legacy shape — some old records carry assets here instead of attachments. */
  brandAssets?: unknown;
}

export const MISSING_BRAND_LOGO_ERROR = 'missing_brand_logo';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function firstLogoAssetUrl(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  for (const asset of list) {
    const url = isNonEmptyString((asset as any)?.url) ? (asset as any).url.trim() : '';
    const type =
      typeof (asset as any)?.type === 'string'
        ? (asset as any).type.toLowerCase()
        : '';
    if (url && type.includes('logo')) return url;
  }
  return null;
}

/**
 * Resolve the persisted brand logo off a brandGuidelines object.
 * Order: attachments `logo` asset → brandData.logoUrl → legacy brandAssets.
 *
 * Attachments win over brandData.logoUrl deliberately: an explicit logo
 * upload in brand config lands ONLY on attachments (routes/brand.ts), while
 * brandData.logoUrl can hold a stale scraped URL — the logo the user sees in
 * brand config must be the logo generation composites.
 */
export function getPersistedBrandLogoUrl(
  brand: BrandGuidelinesLike | null | undefined,
): string | null {
  if (!brand) return null;
  const attachmentLogo = firstLogoAssetUrl(brand.attachments);
  if (attachmentLogo) return attachmentLogo;
  const logoUrl = (brand.brandData as any)?.logoUrl;
  if (isNonEmptyString(logoUrl)) return logoUrl.trim();
  return firstLogoAssetUrl(brand.brandAssets);
}

/**
 * The logo as a stored brand ASSET — attachments (or the legacy brandAssets
 * array), never `brandData.logoUrl`.
 *
 * ENG-933: the Brand Guidelines "Logo & Assets" card renders `attachments`
 * only, so an account whose logo lives solely on `brandData.logoUrl` shows
 * "No logos uploaded" — the reported symptom. `ensureBrandLogoPersisted` uses
 * this (not `getPersistedBrandLogoUrl`) to decide whether onboarding actually
 * finished the job.
 */
export function getPersistedBrandLogoAssetUrl(
  brand: BrandGuidelinesLike | null | undefined,
): string | null {
  if (!brand) return null;
  return firstLogoAssetUrl(brand.attachments) ?? firstLogoAssetUrl(brand.brandAssets);
}

/**
 * Org-aware brandGuidelines read off an ALREADY-LOADED user record — same
 * resolution as `agentModeService.readBrandGuidelines` (org members read the
 * org record, because that is where updateBrandGuidelines and brand-config
 * uploads write for them). Use this when the caller already holds the user
 * to avoid a duplicate Dynamo read.
 */
export async function resolveBrandGuidelinesForLoadedUser(
  user:
    | { orgId?: string; brandGuidelines?: BrandGuidelinesLike | null }
    | null
    | undefined,
): Promise<BrandGuidelinesLike | null> {
  if (!user) return null;
  let brand: BrandGuidelinesLike | null = user.brandGuidelines ?? null;
  if (user.orgId) {
    const { orgDb } = await import('../db');
    const org: any = await orgDb.getOrgById(user.orgId);
    if (org?.brandGuidelines) brand = org.brandGuidelines;
  }
  return brand;
}

/** Org-aware brandGuidelines read by userId. */
export async function resolveBrandGuidelinesForUser(
  userId: string,
): Promise<BrandGuidelinesLike | null> {
  const { userDb } = await import('../db');
  const user: any = await userDb.getUserById(userId);
  return resolveBrandGuidelinesForLoadedUser(user);
}

export async function getPersistedBrandLogoUrlForUser(
  userId: string,
): Promise<string | null> {
  return getPersistedBrandLogoUrl(await resolveBrandGuidelinesForUser(userId));
}

/**
 * Negated logo mentions ("no logo", "without any logos", "omit the logo",
 * "do not include the logo") must not trigger the brand-logo gate.
 *
 * The negation must DIRECTLY modify "logo": a negator followed by at most two
 * filler words from a small whitelist (determiners / possessives / logo-ish
 * verbs) before "logo(s)". A wide scan window (the first cut used 0-40 chars)
 * swallowed positive asks like "no text, just our logo" or "Do not crop the
 * logo" — re-opening the invented-logo hole the gate exists to close.
 */
const NEGATED_LOGO_RE =
  /\b(?:no|not|don'?t|do\s+not|without|never|avoid|omit|exclude|remove|skip|minus)(?:\s+(?:a|an|any|the|our|your|their|its|all|either|both|company|brand|visible|include|including|show|showing|use|using|add|adding|display|displaying)){0,2}\s+logos?\b/gi;
const LOGO_RE = /\blogos?\b/i;

/** Does this image prompt ask for a logo to appear in the output? */
export function promptRequestsLogo(prompt: string): boolean {
  if (!isNonEmptyString(prompt)) return false;
  return LOGO_RE.test(prompt.replace(NEGATED_LOGO_RE, ' '));
}

/**
 * Does this prompt ask to CREATE a brand-new logo from scratch (design one),
 * as opposed to placing/compositing an EXISTING brand logo onto a larger
 * design?
 *
 * ENG-393: an account with no persisted logo legitimately wants generate_image
 * to design a FIRST logo. The `missing_brand_logo` gate below exists to stop
 * the model inventing a fake copy of a logo the brand already owns — NOT to
 * block designing a first logo. Both a creation ask ("create a logo for X")
 * and a compositing ask ("add our logo to this banner") match
 * `promptRequestsLogo` (they mention "logo") with no `logo_image`/inputImages,
 * so the gate over-fired on creation. This discriminator lets creation asks
 * through while compositing asks still gate.
 *
 * Matched (creation):
 *   - a creation verb (create/design/make/generate/…) directly modifying
 *     "logo" through a small whitelist of fillers ("make me a clean logo"), and
 *   - creation-signalling logo noun-phrases ("logo for <brand>", "logo design",
 *     "logo concept", "logo mockup/options/variations", "logo from scratch").
 *
 * NOT matched (compositing — still gates): "add our logo to this banner",
 * "banner with the company logo", "generate an image with our logo" — these
 * place an existing logo and must not be treated as creating a new one.
 */
const CREATE_LOGO_RE =
  /\b(?:create|design|generate|make|build|draw|produce|craft|develop|render|sketch|come\s+up\s+with|need|want|give\s+(?:me|us))(?:\s+(?:me|us|a|an|any|some|one|new|another|fresh|custom|modern|minimal(?:ist)?|simple|clean|professional|unique|brand|company|the|first|initial|our|my|your|cool|sleek|bold|elegant|creative|original))*\s+logos?\b/i;
const LOGO_NOUN_CREATE_RE =
  /\blogos?\s+(?:for\b|designs?\b|concepts?\b|ideas?\b|mockups?\b|options?\b|variations?\b|from\s+scratch\b)/i;

export function promptCreatesLogo(prompt: string): boolean {
  if (!isNonEmptyString(prompt)) return false;
  return CREATE_LOGO_RE.test(prompt) || LOGO_NOUN_CREATE_RE.test(prompt);
}

/**
 * The AC-3 tool result: the model must ask the user for their real logo (or
 * point them at brand config) instead of generating with an invented one.
 */
export function missingBrandLogoToolResult(): {
  success: false;
  error: string;
  askUser: true;
  message: string;
} {
  return {
    success: false,
    error: MISSING_BRAND_LOGO_ERROR,
    askUser: true,
    message:
      'This image request asks for the brand logo, but no logo is saved in the ' +
      "account's Brand Guidelines. Do NOT generate the image with an invented, " +
      'approximate, or AI-rendered logo. Ask the user to provide their real logo — ' +
      'they can upload it in Brand Guidelines (brand config) or share the file/URL ' +
      'here — then call generate_image again with logo_image set to that URL. If the ' +
      'user explicitly says to proceed without a logo, call generate_image again with ' +
      'a prompt that does not mention a logo.',
  };
}

/**
 * Outcome of the download + S3 pin. Discriminated so callers can tell
 * "the URL is a verified raster image but the pin failed" (remote-URL
 * fallback is safe) apart from "the URL never yielded image bytes" or
 * "the logo is an SVG" (persisting the URL would be wrong).
 */
export type BrandLogoDownloadOutcome =
  | { status: 'uploaded'; url: string }
  | { status: 'svg' }
  | { status: 'download-failed'; detail?: string }
  | { status: 'upload-failed'; detail?: string };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Directory entry of the largest frame in an ICO container, if it parses. */
function largestIcoFrame(
  buf: Buffer,
): { offset: number; size: number; width: number; height: number } | null {
  // ICONDIR: reserved(0) | type(1 = icon) | count
  if (buf.length < 6) return null;
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  if (count < 1 || buf.length < 6 + count * 16) return null;
  let best: { offset: number; size: number; width: number; height: number } | null =
    null;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    // A dimension byte of 0 means 256 (it doesn't fit in a byte).
    const width = buf[e] === 0 ? 256 : buf[e];
    const height = buf[e + 1] === 0 ? 256 : buf[e + 1];
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    if (size <= 0 || offset + size > buf.length) continue;
    if (!best || width * height > best.width * best.height) {
      best = { offset, size, width, height };
    }
  }
  return best;
}

/**
 * Convert an ICO container to PNG bytes, or null when it isn't an ICO we can
 * decode. sharp/libvips has no ICO decoder, so the frame is unpacked here:
 * modern icons embed a whole PNG per frame, older ones a headerless
 * BITMAPINFOHEADER DIB (bottom-up BGRA/BGR rows).
 */
async function icoToPng(buf: Buffer): Promise<Buffer | null> {
  const frame = largestIcoFrame(buf);
  if (!frame) return null;
  const bytes = buf.subarray(frame.offset, frame.offset + frame.size);
  const sharp = (await import('sharp')).default;

  if (bytes.subarray(0, 4).equals(PNG_MAGIC)) {
    return sharp(bytes).png().toBuffer();
  }

  const headerSize = bytes.length >= 40 ? bytes.readUInt32LE(0) : 0;
  if (headerSize < 40) return null;
  const width = bytes.readInt32LE(4);
  // An ICO's DIB height covers the XOR image plus the AND mask, so it is
  // double the real height.
  const height = Math.floor(Math.abs(bytes.readInt32LE(8)) / 2);
  const bitCount = bytes.readUInt16LE(14);
  const compression = bytes.readUInt32LE(16);
  if (
    width !== frame.width ||
    height !== frame.height ||
    compression !== 0 ||
    (bitCount !== 32 && bitCount !== 24)
  ) {
    // Palettised or compressed frames need a full BMP decoder — leave them to
    // the raw-upload fallback rather than guessing at pixels.
    return null;
  }

  const stride = (((width * bitCount + 31) / 32) | 0) * 4;
  const pixels = bytes.subarray(headerSize);
  if (pixels.length < stride * height) return null;
  const rgba = Buffer.alloc(width * height * 4);
  const bytesPerPixel = bitCount / 8;
  for (let y = 0; y < height; y++) {
    // DIB rows are stored bottom-up.
    const row = (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const s = row + x * bytesPerPixel;
      const d = (y * width + x) * 4;
      rgba[d] = pixels[s + 2];
      rgba[d + 1] = pixels[s + 1];
      rgba[d + 2] = pixels[s];
      rgba[d + 3] = bitCount === 32 ? pixels[s + 3] : 255;
    }
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * ENG-933: normalise a downloaded logo to PNG when the site serves it in a
 * format brand guidelines and the image models can't consume.
 *
 * Websites overwhelmingly embed their logo as an `.ico` (the reported Zetld
 * case) or an `.svg` — neither is a raster asset the Brand Guidelines "Logo &
 * Assets" card, the ad-image pipeline, or `generate_image` can use, so the
 * logo either never got stored or got stored mislabelled. Rasterising here is
 * the one place every persist path funnels through.
 *
 * Returns null when the bytes are already a usable raster format or the
 * conversion fails — the caller then uploads them as-is.
 */
async function normalizeLogoToPng(
  buf: Buffer,
  contentType: string,
): Promise<Buffer | null> {
  const isIco =
    contentType.includes('icon') ||
    contentType.includes('/ico') ||
    (buf.length >= 4 &&
      buf[0] === 0 &&
      buf[1] === 0 &&
      buf[2] === 1 &&
      buf[3] === 0);
  const isSvg = contentType.includes('svg');
  if (!isIco && !isSvg) return null;
  try {
    if (isIco) return await icoToPng(buf);
    const sharp = (await import('sharp')).default;
    // SVGs often declare no pixel size; render at a high density so the
    // rasterised logo is usable rather than a 16px thumbnail.
    return await sharp(buf, { density: 384 }).png().toBuffer();
  } catch (err: any) {
    console.warn(
      `Failed to convert ${isIco ? 'ICO' : 'SVG'} logo to PNG:`,
      err?.message ?? String(err),
    );
    return null;
  }
}

/**
 * Download a discovered logo and pin it to S3 under
 * `users/{userId}/brand/logo`. The download + upload mechanics are the block
 * extracted from `agentModeService.extractCSSFromURL` (ENG-326), plus the
 * ENG-933 PNG normalisation: ICO/SVG logos are rasterised so they can be
 * stored as a real brand asset, and only an SVG we could NOT rasterise still
 * reports `svg` (brand guidelines reject raw SVG). Failures log a warning.
 * Never throws — every branch resolves to a `BrandLogoDownloadOutcome`.
 */
export async function downloadBrandLogoToS3(
  logoUrl: string,
  userId: string,
): Promise<BrandLogoDownloadOutcome> {
  let logoResponse: { headers: Record<string, string>; data: unknown };
  try {
    console.log(`Downloading logo from ${logoUrl}...`);
    const axios = (await import('axios')).default;
    logoResponse = await axios.get(logoUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
    });
  } catch (logoErr: any) {
    const detail = logoErr?.message ?? String(logoErr);
    console.warn('Failed to download logo:', detail);
    return { status: 'download-failed', detail };
  }
  let contentType = logoResponse.headers['content-type'] || '';
  let body = Buffer.from(logoResponse.data as ArrayBuffer);
  const png = await normalizeLogoToPng(body, contentType);
  if (png) {
    console.log(`Converted logo to PNG (was ${contentType || 'unknown type'})`);
    body = png;
    contentType = 'image/png';
  } else if (contentType.includes('svg')) {
    // Un-rasterisable SVG: brand guidelines reject it outright.
    console.log('Skipping SVG logo (not supported by brand guidelines)');
    return { status: 'svg' };
  }
  try {
    const ext = contentType.includes('png')
      ? 'png'
      : contentType.includes('gif')
        ? 'gif'
        : contentType.includes('webp')
          ? 'webp'
          : contentType.includes('icon') || contentType.includes('/ico')
            ? 'ico'
            : 'jpg';
    const filename = `logo.${ext}`;
    const { uploadFileToS3WithPath } = await import('../../utils/s3Utils');
    const uploadResult = await uploadFileToS3WithPath(
      body,
      filename,
      contentType,
      `users/${userId}/brand/logo`,
    );
    if (uploadResult.success && uploadResult.url) {
      console.log(`Logo uploaded to S3: ${uploadResult.url}`);
      return { status: 'uploaded', url: uploadResult.url };
    }
    return { status: 'upload-failed', detail: uploadResult.error };
  } catch (uploadErr: any) {
    const detail = uploadErr?.message ?? String(uploadErr);
    console.warn('Failed to upload logo:', detail);
    return { status: 'upload-failed', detail };
  }
}

/**
 * How usable a persisted logo URL is *right now* (ENG-792).
 *
 * Deliberately tri-state rather than boolean, because the two callers need
 * OPPOSITE failure semantics for an inconclusive probe:
 *
 *  - the ad-image preflight fails CLOSED (`'unknown'` blocks the run) — a
 *    doubtful logo would otherwise burn three Gemini calls and ship
 *    placeholders;
 *  - `ensureBrandLogoPersisted` fails OPEN (`'unknown'` keeps the existing
 *    logo) — a transient blip must never cause us to replace an account's
 *    real, manually-uploaded logo.
 *
 * Only a DEFINITIVE negative is `'broken'`: a 4xx (the resource genuinely
 * isn't there — e.g. the reported `google.com/s2/favicons` URL that
 * 301→404s for a domain with no crawlable favicon), or a 2xx whose body is
 * empty or clearly textual (an HTML/JSON error page is not a logo).
 * Timeouts, DNS errors and 5xx are `'unknown'` — the URL may be perfectly
 * fine and merely unreachable this second.
 */
export type BrandLogoUsability = 'usable' | 'broken' | 'unknown';

/** Timeout for the one-shot logo usability probe (ENG-792). */
const LOGO_PROBE_TIMEOUT_MS = 15_000;

export interface BrandLogoProbeDeps {
  /**
   * One-shot fetch. Defaults to a real axios GET. May either reject (real
   * axios rejects non-2xx) or resolve with a non-2xx `status`; both shapes
   * are classified.
   */
  httpGet?: (url: string) => Promise<{
    status?: number;
    headers?: Record<string, unknown>;
    data?: unknown;
  }>;
}

/**
 * Probe a logo URL once and classify whether it currently serves usable
 * image bytes. Never throws.
 *
 * A 2xx with a generic or absent content-type counts as `'usable'`: the
 * downstream consumer (`imageGeneration.processInputImage` →
 * `getImageMimeType`) tolerates those by sniffing the URL extension and
 * defaulting to image/png, so rejecting them here would break logos that
 * work fine today (e.g. S3 objects with no ContentType metadata).
 */
export async function classifyBrandLogoUrl(
  logoUrl: string,
  deps: BrandLogoProbeDeps = {},
): Promise<BrandLogoUsability> {
  if (typeof logoUrl !== 'string' || logoUrl.trim() === '') return 'broken';
  const httpGet =
    deps.httpGet ??
    (async (url: string) => {
      const axios = (await import('axios')).default;
      return axios.get(url, {
        responseType: 'arraybuffer',
        timeout: LOGO_PROBE_TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)' },
      });
    });
  try {
    const resp = await httpGet(logoUrl);
    const status = resp?.status;
    if (typeof status === 'number' && (status < 200 || status >= 300)) {
      // An injected fetcher (or a custom validateStatus) can surface the
      // non-2xx instead of rejecting. Same classification as the throw path.
      return status >= 400 && status < 500 ? 'broken' : 'unknown';
    }
    const data: any = resp?.data;
    const byteLength =
      data == null
        ? 0
        : typeof data.byteLength === 'number'
          ? data.byteLength
          : typeof data.length === 'number'
            ? data.length
            : 0;
    // A 2xx with no bytes is definitively not a logo.
    if (byteLength <= 0) return 'broken';
    const contentType = String(
      (resp?.headers as any)?.['content-type'] || '',
    ).toLowerCase();
    const isTextual =
      contentType.startsWith('text/') ||
      contentType.startsWith('application/json');
    return isTextual ? 'broken' : 'usable';
  } catch (err: any) {
    const status = err?.response?.status;
    // Real axios rejects on non-2xx and carries the response. A 4xx is a
    // definitive "not there"; everything else (timeout, DNS, 5xx, and any
    // error with no response attached) is inconclusive.
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return 'broken';
    }
    return 'unknown';
  }
}

export interface EnsureBrandLogoDeps {
  /** Org-aware brandGuidelines read. Defaults to the real Dynamo read. */
  resolveBrand?: (userId: string) => Promise<BrandGuidelinesLike | null>;
  /**
   * Usability probe for an ALREADY-persisted logo (ENG-792). Defaults to
   * `classifyBrandLogoUrl`. Only a `'broken'` verdict makes the step fall
   * through to rediscovery — see the call site.
   */
  classifyExisting?: (logoUrl: string) => Promise<BrandLogoUsability>;
  /** Logo discovery. Defaults to the cssExtractor heuristics on the company URL. */
  discoverLogoUrl?: (companyUrl: string) => Promise<string | null>;
  /** Download + S3 pin. Defaults to `downloadBrandLogoToS3`. */
  download?: (logoUrl: string, userId: string) => Promise<BrandLogoDownloadOutcome>;
  /**
   * Brand-guidelines write. Defaults to
   * `agentModeService.updateBrandGuidelines` — the same org-aware,
   * merge-by-type path Emma's update_brand_guidelines tool uses.
   */
  persist?: (
    userId: string,
    logoUrl: string,
    filename: string,
  ) => Promise<{ success: boolean; error?: string }>;
}

export interface EnsureBrandLogoOutcome {
  persisted: boolean;
  logoUrl: string | null;
  reason:
    | 'persisted'
    | 'already-present'
    | 'no-logo-found'
    | 'svg-only'
    | 'download-failed'
    | 'persist-failed'
    | 'error';
  detail?: string;
}

function filenameFromUrl(url: string): string {
  try {
    const base = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (base && /\.(png|jpe?g|gif|webp|ico)$/i.test(base)) return base;
  } catch {
    /* fall through to default */
  }
  return 'logo.png';
}

async function defaultDiscoverLogoUrl(companyUrl: string): Promise<string | null> {
  // Lazy require — cssExtractor pulls JSDOM and friends; only load when the
  // deterministic step actually runs (tests inject a fake).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { extractCSSFromURL } = require('../cssExtractor');
  const extracted = await extractCSSFromURL(companyUrl);
  const logoUrl = extracted?.brandIdentity?.logoUrl;
  return isNonEmptyString(logoUrl) ? logoUrl : null;
}

async function defaultPersistBrandLogo(
  userId: string,
  logoUrl: string,
  filename: string,
): Promise<{ success: boolean; error?: string }> {
  // Lazy import — agentModeService imports this module, so the reverse edge
  // must resolve at call time to avoid a load-order cycle.
  const { agentModeService } = await import('../agentModeService');
  return agentModeService.updateBrandGuidelines(
    {
      brandData: { logoUrl },
      brandAssets: {
        type: 'logo',
        url: logoUrl,
        filename,
        key: `auto-logo-${Date.now()}`,
      },
    },
    userId,
  );
}

/**
 * Deterministic post-scrape onboarding step (AC-1): whenever the Emma
 * brand-build session left no logo on the account, discover one on the
 * company site, pin it to S3, and persist it as `brandData.logoUrl` plus a
 * `logo` brand asset. Never throws — the caller treats every outcome as
 * best-effort and logs it.
 */
export async function ensureBrandLogoPersisted(
  userId: string,
  companyUrl: string,
  deps: EnsureBrandLogoDeps = {},
): Promise<EnsureBrandLogoOutcome> {
  try {
    const resolveBrand = deps.resolveBrand ?? resolveBrandGuidelinesForUser;
    const brand = await resolveBrand(userId);
    const classifyExisting = deps.classifyExisting ?? classifyBrandLogoUrl;
    // ENG-792: "already present" used to be a purely STRUCTURAL check — any
    // non-empty string short-circuited this step. Emma's brand-build session
    // writes `logoUrl` voluntarily and, when a site renders its logo as inline
    // SVG (nothing to link to), has been observed substituting a
    // `google.com/s2/favicons?domain=…` URL that 404s. That junk value counted
    // as "present", so the deterministic discover-and-pin below never ran and
    // every downstream ad-image generation failed on the unfetchable logo.
    //
    // Verify before trusting it, and fall through to rediscovery only on a
    // DEFINITIVE negative. `'unknown'` (timeout / DNS / 5xx) keeps the existing
    // URL: replacing an account's real logo because of a transient blip would
    // be far worse than leaving a possibly-stale one in place.
    //
    // ENG-933: "present" now means a stored brand ASSET. Emma routinely writes
    // `brandData.logoUrl` and nothing else, which left Brand Guidelines showing
    // "No logos uploaded" (the card renders `attachments`) even though the step
    // considered itself done. When only `brandData.logoUrl` exists we pin THAT
    // URL instead of re-scraping the site — it is the logo Emma already found.
    const existingAsset = getPersistedBrandLogoAssetUrl(brand);
    let sourceUrl: string | null = null;
    if (existingAsset) {
      const usability = await classifyExisting(existingAsset);
      if (usability !== 'broken') {
        return { persisted: false, logoUrl: existingAsset, reason: 'already-present' };
      }
      console.warn(
        '[brandLogo] persisted logo is unfetchable — rediscovering (ENG-792)',
        { userId, existing: existingAsset },
      );
    } else {
      const brandDataUrl = getPersistedBrandLogoUrl(brand);
      if (brandDataUrl) {
        const usability = await classifyExisting(brandDataUrl);
        if (usability !== 'broken') {
          sourceUrl = brandDataUrl;
        } else {
          console.warn(
            '[brandLogo] persisted logo is unfetchable — rediscovering (ENG-792)',
            { userId, existing: brandDataUrl },
          );
        }
      }
    }

    const discoverLogoUrl = deps.discoverLogoUrl ?? defaultDiscoverLogoUrl;
    const discovered = sourceUrl ?? (await discoverLogoUrl(companyUrl));
    if (!discovered) {
      return { persisted: false, logoUrl: null, reason: 'no-logo-found' };
    }

    const download = deps.download ?? downloadBrandLogoToS3;
    const outcome = await download(discovered, userId);
    let finalUrl: string;
    if (outcome.status === 'uploaded') {
      finalUrl = outcome.url;
    } else if (outcome.status === 'upload-failed') {
      // The download PROVED the URL serves raster image bytes — only the S3
      // pin failed. The customer's own hosted logo is still their real logo.
      finalUrl = discovered;
    } else if (outcome.status === 'svg') {
      // Brand guidelines reject SVG assets and image models can't ingest
      // them — nothing usable to persist, whatever the URL's extension says.
      return { persisted: false, logoUrl: null, reason: 'svg-only' };
    } else {
      // download-failed: the URL never yielded verified image bytes (404,
      // hotlink protection, timeout). Persisting it would make a broken
      // image the account's canonical logo — fail this step loudly instead.
      return {
        persisted: false,
        logoUrl: null,
        reason: 'download-failed',
        detail: outcome.detail,
      };
    }

    const persist = deps.persist ?? defaultPersistBrandLogo;
    const result = await persist(userId, finalUrl, filenameFromUrl(finalUrl));
    if (!result?.success) {
      return {
        persisted: false,
        logoUrl: finalUrl,
        reason: 'persist-failed',
        detail: result?.error,
      };
    }
    return { persisted: true, logoUrl: finalUrl, reason: 'persisted' };
  } catch (err: any) {
    return {
      persisted: false,
      logoUrl: null,
      reason: 'error',
      detail: err?.message ?? String(err),
    };
  }
}
