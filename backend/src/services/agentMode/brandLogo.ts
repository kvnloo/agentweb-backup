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

/**
 * Download a discovered logo and pin it to S3 under
 * `users/{userId}/brand/logo`. The download + upload mechanics are the block
 * extracted from `agentModeService.extractCSSFromURL` (ENG-326): SVGs are
 * skipped by CONTENT-TYPE (brand guidelines reject them; extensions lie),
 * failures log a warning. Never throws — every branch resolves to a
 * `BrandLogoDownloadOutcome`.
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
  const contentType = logoResponse.headers['content-type'] || '';
  // Skip SVG since brand guidelines doesn't accept it
  if (contentType.includes('svg')) {
    console.log('Skipping SVG logo (not supported by brand guidelines)');
    return { status: 'svg' };
  }
  try {
    const ext = contentType.includes('png')
      ? 'png'
      : contentType.includes('gif')
        ? 'gif'
        : 'jpg';
    const filename = `logo.${ext}`;
    const { uploadFileToS3WithPath } = await import('../../utils/s3Utils');
    const uploadResult = await uploadFileToS3WithPath(
      Buffer.from(logoResponse.data as ArrayBuffer),
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

export interface EnsureBrandLogoDeps {
  /** Org-aware brandGuidelines read. Defaults to the real Dynamo read. */
  resolveBrand?: (userId: string) => Promise<BrandGuidelinesLike | null>;
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
    const existing = getPersistedBrandLogoUrl(await resolveBrand(userId));
    if (existing) {
      return { persisted: false, logoUrl: existing, reason: 'already-present' };
    }

    const discoverLogoUrl = deps.discoverLogoUrl ?? defaultDiscoverLogoUrl;
    const discovered = await discoverLogoUrl(companyUrl);
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
