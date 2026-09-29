/**
 * Deterministic creative CONTENT checks (ENG-2193, ENG-2128 B): OCR text-area ratio and
 * legibility, a dictionary spell check on OCR'd text and any supplied ad copy, brand-colour
 * palette distance, brand-logo presence via template matching, and a Meta/Google restricted-ad
 * keyword classifier.
 *
 * ADVISORY ONLY, same as `./creativeGates` — every function here returns/contributes a
 * `CreativeGateCheck` and never throws. `creativeContentCheckRunner.ts` merges the result of
 * `runCreativeContentChecks` into a candidate's existing `CreativeGateResult.checks` via
 * `humanEvalService.appendCreativeGateChecks`; nothing in this file touches Dynamo, S3, or the
 * network directly — every measurer takes bytes already in hand, so it's unit-testable with
 * plain buffers/fixtures and mockable at a single boundary (`tesseract.js`/`nspell`) in tests.
 *
 * OCR choice (see PR body for the full writeup): `tesseract.js` over a hosted OCR API. It is
 * pure JS + WASM — no system `tesseract` binary, unlike `node-tesseract-ocr` — so it adds no new
 * native/system dependency, and it keeps customer creative bytes off a third-party API. The
 * trade-off is the one already flagged in `creativeGates.ts`'s prior header comment: the English
 * language model (~1-2MB) is fetched from a CDN on first use per process, not vendored into the
 * repo (adding ~30MB of WASM cores unpacked to `node_modules` is already the larger cost; a
 * vendored traineddata blob would add more without buying much, since a cold Lambda/EB fetch is
 * a one-time cost only while unused workers spin up). That fetch, like the OCR call itself, is
 * bounded and never allowed to block: any failure — no network, timeout, corrupt language data —
 * degrades every OCR-derived check (`ocr_text_ratio`, `ocr_legibility`, and transitively
 * `spelling`/`policy_keywords` when they had no other text) to `skipped`, exactly like a `sharp`
 * decode failure already degrades the structural gates. See `creativeContentCheckRunner.ts` for
 * why this whole group also runs out-of-band rather than inline in `imageGeneration.ts`: OCR
 * inference (seconds) and an optional brand-logo download are too slow to sit in the
 * user-facing `generateImage()` response path that the fast structural gates are awaited in.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { CreativeGateCheck } from './creativeGates';

// ---------------------------------------------------------------------------------------------
// Shared text tokenising (spelling + brand vocabulary)
// ---------------------------------------------------------------------------------------------

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;

function tokenizeWords(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// ---------------------------------------------------------------------------------------------
// Brand profile — built from `brandGuidelines.brandData` (backend/src/services/db.ts:474-495) by
// the caller; a narrow structural type so this module never imports the (large, unrelated) `db`
// module. `buildBrandProfile` takes the loosely-typed record `brandLogo.ts`'s
// `BrandGuidelinesLike.brandData` already is, so a caller holding a real user record needs no
// cast beyond that existing type.
// ---------------------------------------------------------------------------------------------

export interface CreativeBrandProfile {
  /** Hex colours (`#rrggbb`) from `primaryColor` / `primaryColorEnd` / `secondaryColor`. */
  colours: string[];
  /** Lower-cased brand words allow-listed for the spelling check. */
  vocabulary: string[];
}

/** Builds a `CreativeBrandProfile` off `brandGuidelines.brandData` (or `undefined` if none). */
export function buildBrandProfile(brandData: Record<string, unknown> | undefined): CreativeBrandProfile {
  if (!brandData) return { colours: [], vocabulary: [] };

  const colours = [brandData.primaryColor, brandData.primaryColorEnd, brandData.secondaryColor]
    .map(asTrimmedString)
    .filter((c): c is string => !!c);

  const vocabulary = new Set<string>();
  const addPhrase = (phrase: unknown) => {
    const s = asTrimmedString(phrase);
    if (!s) return;
    for (const w of tokenizeWords(s)) vocabulary.add(w.toLowerCase());
  };
  addPhrase(brandData.brandName);
  addPhrase(brandData.tagline);
  addPhrase(brandData.valueProposition);
  for (const m of asStringArray(brandData.keyMessages)) addPhrase(m);
  for (const v of asStringArray(brandData.brandValues)) addPhrase(v);
  const founders = Array.isArray(brandData.founders) ? brandData.founders : [];
  for (const f of founders) {
    if (f && typeof f === 'object') addPhrase((f as Record<string, unknown>).name);
  }

  return { colours, vocabulary: [...vocabulary] };
}

// ---------------------------------------------------------------------------------------------
// OCR: text-area ratio + legibility
// ---------------------------------------------------------------------------------------------

/** Bound on tesseract worker init + recognize combined, so a slow/absent CDN never hangs the
 *  (already out-of-band) caller indefinitely — mirrors `imageGeneration.ts`'s remote-gate
 *  download bound. */
const OCR_TIMEOUT_MS = 20_000;
/** Tesseract's own 0-100 mean-word-confidence scale; below this the text is likely garbled. */
const OCR_LOW_CONFIDENCE_THRESHOLD = 60;
/** Above this fraction of the image's area, dense text reads as more flyer than ad creative. */
const OCR_HIGH_TEXT_RATIO_THRESHOLD = 0.5;

export interface OcrMeasurement {
  text: string;
  /** Page-level mean word confidence, 0-100. */
  confidence: number;
  /** Sum of word bounding-box areas / total image area, clamped to [0,1]. An approximation of
   *  true covered area (overlapping word boxes would double-count) — word boxes on a real ad
   *  essentially never overlap, so this is accurate enough for an advisory threshold. */
  textAreaRatio: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Runs OCR on the image bytes. Never throws — any failure (no network, bad image, timeout)
 *  returns `undefined` so the caller can record every OCR-derived check as `skipped`. */
export async function measureOcr(
  buffer: Buffer,
  width: number | undefined,
  height: number | undefined,
): Promise<OcrMeasurement | undefined> {
  if (!width || !height) return undefined;
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await withTimeout(createWorker('eng'), OCR_TIMEOUT_MS, 'tesseract worker init');
    try {
      const { data } = await withTimeout(worker.recognize(buffer), OCR_TIMEOUT_MS, 'tesseract recognize');
      const area = width * height;
      let textArea = 0;
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            for (const word of line.words) {
              const w = Math.max(0, word.bbox.x1 - word.bbox.x0);
              const h = Math.max(0, word.bbox.y1 - word.bbox.y0);
              textArea += w * h;
            }
          }
        }
      }
      return {
        text: data.text ?? '',
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        textAreaRatio: area > 0 ? Math.min(1, textArea / area) : 0,
      };
    } finally {
      await worker.terminate().catch(() => undefined);
    }
  } catch (err) {
    console.warn('[creative-content-checks] OCR failed (skipped):', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Pure: measurement in, the two OCR-derived checks out. */
export function evaluateOcrChecks(m: OcrMeasurement | undefined): CreativeGateCheck[] {
  if (!m) {
    return [
      { id: 'ocr_text_ratio', status: 'skipped', reason: 'OCR could not run on this image' },
      { id: 'ocr_legibility', status: 'skipped', reason: 'OCR could not run on this image' },
    ];
  }
  const hasText = m.text.trim().length > 0;

  const textRatioCheck: CreativeGateCheck = !hasText
    ? { id: 'ocr_text_ratio', status: 'skipped', reason: 'no text detected in the image' }
    : m.textAreaRatio > OCR_HIGH_TEXT_RATIO_THRESHOLD
      ? {
          id: 'ocr_text_ratio',
          status: 'fail',
          reason: `text covers an estimated ${(m.textAreaRatio * 100).toFixed(0)}% of the image (over ${(OCR_HIGH_TEXT_RATIO_THRESHOLD * 100).toFixed(0)}%)`,
        }
      : { id: 'ocr_text_ratio', status: 'pass' };

  const legibilityCheck: CreativeGateCheck = !hasText
    ? { id: 'ocr_legibility', status: 'skipped', reason: 'no text detected in the image' }
    : m.confidence < OCR_LOW_CONFIDENCE_THRESHOLD
      ? {
          id: 'ocr_legibility',
          status: 'fail',
          reason: `OCR confidence ${m.confidence.toFixed(0)} is below ${OCR_LOW_CONFIDENCE_THRESHOLD} — text may be illegible`,
        }
      : { id: 'ocr_legibility', status: 'pass' };

  return [textRatioCheck, legibilityCheck];
}

// ---------------------------------------------------------------------------------------------
// Spelling — dictionary check on OCR'd text and/or supplied ad copy, brand terms allow-listed
// ---------------------------------------------------------------------------------------------

const MIN_SPELL_WORD_LEN = 3;
const MAX_REPORTED_MISSPELLINGS = 10;

let spellerPromise: ReturnType<typeof loadSpeller> | undefined;

/**
 * `dictionary-en` (v4+) is a pure-ESM package (top-level `await`, no CJS entry point) — this
 * backend compiles to CommonJS, and TypeScript lowers a dynamic `import()` under
 * `"module": "commonjs"` to a `require()` call (verified: `require('dictionary-en')` throws
 * `ERR_REQUIRE_ASYNC_MODULE`). Rather than pull in an ESM loader, this reads the package's own
 * `index.aff`/`index.dic` data files directly — `require.resolve` only resolves the path (via
 * Node's normal `exports`-aware algorithm, so it stays correct if the package's internal layout
 * changes), it does not execute the ESM module, so it carries none of that problem.
 */
async function loadSpeller() {
  const nspell = (await import('nspell')).default;
  const dictionaryDir = dirname(require.resolve('dictionary-en'));
  const aff = readFileSync(join(dictionaryDir, 'index.aff'));
  const dic = readFileSync(join(dictionaryDir, 'index.dic'));
  return nspell({ aff, dic });
}

/** Lazily built once per process, matching `sharp`'s lazy-import pattern elsewhere in the gates. */
function getSpeller() {
  if (!spellerPromise) spellerPromise = loadSpeller();
  return spellerPromise;
}

export interface SpellingMeasurement {
  /** Unique misspelled words, first-seen order, already capped to `MAX_REPORTED_MISSPELLINGS`. */
  misspelled: string[];
  /** How many words (after length/allow-list filtering) were actually looked up. */
  checkedWordCount: number;
}

/** Never throws — a dictionary load failure returns `undefined` (check reads as `skipped`). */
export async function measureSpelling(
  text: string,
  brandVocabulary: readonly string[],
): Promise<SpellingMeasurement | undefined> {
  const words = tokenizeWords(text);
  if (words.length === 0) return undefined;
  try {
    const speller = await getSpeller();
    const allow = new Set(brandVocabulary.map((w) => w.toLowerCase()));
    const seen = new Set<string>();
    const misspelled: string[] = [];
    let checkedWordCount = 0;
    for (const word of words) {
      if (word.length < MIN_SPELL_WORD_LEN) continue;
      const lower = word.toLowerCase();
      if (allow.has(lower)) continue;
      checkedWordCount++;
      if (seen.has(lower)) continue;
      if (!speller.correct(word)) {
        seen.add(lower);
        if (misspelled.length < MAX_REPORTED_MISSPELLINGS) misspelled.push(word);
      }
    }
    return { misspelled, checkedWordCount };
  } catch (err) {
    console.warn('[creative-content-checks] spelling check failed (skipped):', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Pure: measurement in, the `spelling` check out. */
export function evaluateSpellingCheck(m: SpellingMeasurement | undefined): CreativeGateCheck {
  if (!m) return { id: 'spelling', status: 'skipped', reason: 'no text available to spell-check' };
  if (m.checkedWordCount === 0) {
    return { id: 'spelling', status: 'skipped', reason: 'no dictionary-checkable words found' };
  }
  if (m.misspelled.length === 0) return { id: 'spelling', status: 'pass' };
  const suffix = m.misspelled.length >= MAX_REPORTED_MISSPELLINGS ? ', …' : '';
  return {
    id: 'spelling',
    status: 'fail',
    reason: `possibly misspelled word(s): ${m.misspelled.join(', ')}${suffix}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Brand colour — dominant-palette distance from the brand's hex colours
// ---------------------------------------------------------------------------------------------

const PALETTE_THUMBNAIL_SIZE = 24;
const DOMINANT_COLOUR_COUNT = 5;
/** Max Euclidean RGB distance (of a possible ~441) counted as "close to the brand palette". */
const BRAND_COLOUR_MAX_DISTANCE = 90;

interface RgbColour {
  r: number;
  g: number;
  b: number;
}

function parseHexColour(hex: string): RgbColour | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbDistance(a: RgbColour, b: RgbColour): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

export interface PaletteMeasurement {
  dominant: RgbColour[];
}

/** Never throws — an undecodable image returns `undefined` (check reads as `skipped`). */
export async function measurePalette(buffer: Buffer): Promise<PaletteMeasurement | undefined> {
  try {
    const { default: sharp } = await import('sharp');
    const { data, info } = await sharp(buffer)
      .flatten({ background: '#ffffff' })
      .resize(PALETTE_THUMBNAIL_SIZE, PALETTE_THUMBNAIL_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const buckets = new Map<string, { colour: RgbColour; count: number }>();
    for (let i = 0; i + 2 < data.length; i += channels) {
      // Quantize to 16-value buckets per channel so near-identical pixels group together
      // instead of every unique RGB triple becoming its own singleton bucket.
      const r = data[i] - (data[i] % 16);
      const g = data[i + 1] - (data[i + 1] % 16);
      const b = data[i + 2] - (data[i + 2] % 16);
      const key = `${r},${g},${b}`;
      const existing = buckets.get(key);
      if (existing) existing.count += 1;
      else buckets.set(key, { colour: { r, g, b }, count: 1 });
    }
    const dominant = [...buckets.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, DOMINANT_COLOUR_COUNT)
      .map((b) => b.colour);
    return { dominant };
  } catch (err) {
    console.warn('[creative-content-checks] palette measurement failed (skipped):', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Pure: measurement + brand hex colours in, the `brand_colour` check out. */
export function evaluateBrandColourCheck(
  m: PaletteMeasurement | undefined,
  brandColours: readonly string[],
): CreativeGateCheck {
  const parsedBrand = brandColours.map(parseHexColour).filter((c): c is RgbColour => !!c);
  if (parsedBrand.length === 0) {
    return { id: 'brand_colour', status: 'skipped', reason: 'no brand colours on file' };
  }
  if (!m || m.dominant.length === 0) {
    return { id: 'brand_colour', status: 'skipped', reason: 'could not read a colour palette from the image' };
  }
  let best = Infinity;
  for (const d of m.dominant) {
    for (const b of parsedBrand) best = Math.min(best, rgbDistance(d, b));
  }
  if (best <= BRAND_COLOUR_MAX_DISTANCE) return { id: 'brand_colour', status: 'pass' };
  return {
    id: 'brand_colour',
    status: 'fail',
    reason: `no dominant image colour is close to the brand palette (closest distance ${best.toFixed(0)}, threshold ${BRAND_COLOUR_MAX_DISTANCE})`,
  };
}

// ---------------------------------------------------------------------------------------------
// Logo presence — bounded template match on downscaled greyscale bitmaps, no new dependency
// ---------------------------------------------------------------------------------------------

const LOGO_MATCH_MAX_DIM = 320;
const LOGO_MATCH_TEMPLATE_WIDTH = 48;
const LOGO_MATCH_STRIDE = 4;
const LOGO_MATCH_SCALES = [0.75, 1, 1.25] as const;
/** Normalized cross-correlation coefficient (-1..1) counted as a real match. */
const LOGO_MATCH_MIN_SCORE = 0.55;

interface GreyImage {
  width: number;
  height: number;
  data: Uint8Array;
}

async function toGreyscale(buffer: Buffer, maxDim: number): Promise<GreyImage> {
  const { default: sharp } = await import('sharp');
  const base = sharp(buffer).greyscale();
  const meta = await base.metadata();
  const scale = meta.width && meta.height ? Math.min(1, maxDim / Math.max(meta.width, meta.height)) : 1;
  const width = meta.width ? Math.max(1, Math.round(meta.width * scale)) : maxDim;
  const height = meta.height ? Math.max(1, Math.round(meta.height * scale)) : maxDim;
  const { data } = await base.resize(width, height, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** Nearest-neighbour resample — good enough for a coarse template match; no new dependency. */
function resizeGrey(g: GreyImage, width: number, height: number): GreyImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(g.height - 1, Math.floor((y * g.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(g.width - 1, Math.floor((x * g.width) / width));
      data[y * width + x] = g.data[sy * g.width + sx];
    }
  }
  return { width, height, data };
}

/** Normalized cross-correlation of `template` against `image` at one top-left offset. */
function correlationAt(image: GreyImage, template: GreyImage, ox: number, oy: number): number {
  let sumI = 0;
  let sumT = 0;
  let sumII = 0;
  let sumTT = 0;
  let sumIT = 0;
  let n = 0;
  for (let y = 0; y < template.height; y++) {
    const iy = oy + y;
    for (let x = 0; x < template.width; x++) {
      const ix = ox + x;
      const iv = image.data[iy * image.width + ix];
      const tv = template.data[y * template.width + x];
      sumI += iv;
      sumT += tv;
      sumII += iv * iv;
      sumTT += tv * tv;
      sumIT += iv * tv;
      n++;
    }
  }
  if (n === 0) return -1;
  const meanI = sumI / n;
  const meanT = sumT / n;
  const covariance = sumIT / n - meanI * meanT;
  const varI = sumII / n - meanI * meanI;
  const varT = sumTT / n - meanT * meanT;
  const denom = Math.sqrt(Math.max(varI, 0) * Math.max(varT, 0));
  // A flat region (constant background) or a flat template has zero variance — no meaningful
  // correlation is defined there, so it must never win as the "best" match.
  if (denom < 1e-6) return -1;
  return covariance / denom;
}

export interface LogoMatchMeasurement {
  /** Best correlation score found across the scanned scales/positions, -1..1. */
  bestScore: number;
}

/** Never throws — any failure (undecodable bytes, degenerate size) returns `undefined`. */
export async function measureLogoMatch(
  creativeBuffer: Buffer,
  logoBuffer: Buffer,
): Promise<LogoMatchMeasurement | undefined> {
  try {
    const image = await toGreyscale(creativeBuffer, LOGO_MATCH_MAX_DIM);
    const logo = await toGreyscale(logoBuffer, LOGO_MATCH_MAX_DIM);
    if (image.width < 4 || image.height < 4 || logo.width < 4 || logo.height < 4) return undefined;

    let bestScore = -1;
    for (const scale of LOGO_MATCH_SCALES) {
      const templateWidth = Math.max(4, Math.min(image.width, Math.round(LOGO_MATCH_TEMPLATE_WIDTH * scale)));
      const templateHeight = Math.max(4, Math.round((templateWidth * logo.height) / logo.width));
      if (templateWidth > image.width || templateHeight > image.height) continue;
      const template = resizeGrey(logo, templateWidth, templateHeight);
      for (let oy = 0; oy + templateHeight <= image.height; oy += LOGO_MATCH_STRIDE) {
        for (let ox = 0; ox + templateWidth <= image.width; ox += LOGO_MATCH_STRIDE) {
          const score = correlationAt(image, template, ox, oy);
          if (score > bestScore) bestScore = score;
        }
      }
    }
    return { bestScore };
  } catch (err) {
    console.warn('[creative-content-checks] logo match failed (skipped):', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Pure: measurement (if the logo could be matched at all) in, the `logo_presence` check out. */
export function evaluateLogoPresenceCheck(
  m: LogoMatchMeasurement | undefined,
  hasLogoOnFile: boolean,
): CreativeGateCheck {
  if (!hasLogoOnFile) return { id: 'logo_presence', status: 'skipped', reason: 'no persisted brand logo on file' };
  if (!m) return { id: 'logo_presence', status: 'skipped', reason: 'logo match could not run' };
  if (m.bestScore >= LOGO_MATCH_MIN_SCORE) {
    return { id: 'logo_presence', status: 'pass', reason: `best match score ${m.bestScore.toFixed(2)}` };
  }
  return {
    id: 'logo_presence',
    status: 'fail',
    reason: `no strong match for the brand logo (best score ${m.bestScore.toFixed(2)}, threshold ${LOGO_MATCH_MIN_SCORE})`,
  };
}

// ---------------------------------------------------------------------------------------------
// Policy keywords — cheap, deterministic Meta/Google restricted-category classifier. Distinct
// from `creativeRubricJudge.ts`'s existing LLM `policy_compliance` rubric criterion: that one is
// qualitative and costs a model call; this one is a fast, free pre-screen for a handful of
// well-known restricted categories (health claims, finance, before/after, personal attributes,
// restricted substances, adult content).
// ---------------------------------------------------------------------------------------------

interface PolicyCategory {
  label: string;
  pattern: RegExp;
}

const POLICY_CATEGORIES: PolicyCategory[] = [
  {
    label: 'health claims',
    pattern:
      /\b(miracle (cure|treatment)|guaranteed (weight loss|results)|lose \d+\s*(lbs?|pounds?|kg)|cures? (cancer|diabetes|covid)|fda[- ]approved|clinically proven to cure)\b/i,
  },
  {
    label: 'before/after imagery claims',
    pattern: /\bbefore\s*(and|&|\/)\s*after\b/i,
  },
  {
    label: 'financial claims',
    pattern:
      /\b(guaranteed (returns?|income|profits?)|get rich quick|no (credit check|risk) (loan|investment)|debt[- ]free in \d+|double your money|risk[- ]free investment)\b/i,
  },
  {
    label: 'personal attribute inference',
    pattern: /\bare you (pregnant|depressed|gay|struggling with)\b|\byou (are|might be) (overweight|balding|broke)\b/i,
  },
  {
    label: 'restricted substances',
    pattern: /\b(cbd|vaping|e-?cigarettes?|weight[- ]loss (pill|supplement)s?|prescription(-| )free)\b/i,
  },
  {
    label: 'adult content',
    pattern: /\b(xxx|adult content|nsfw)\b/i,
  },
];

/** Pure and synchronous — no measurement/IO step, unlike the other checks. */
export function evaluatePolicyKeywordCheck(text: string | undefined): CreativeGateCheck {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { id: 'policy_keywords', status: 'skipped', reason: 'no text available to check' };
  const matched = POLICY_CATEGORIES.filter((c) => c.pattern.test(trimmed));
  if (matched.length === 0) return { id: 'policy_keywords', status: 'pass' };
  return {
    id: 'policy_keywords',
    status: 'fail',
    reason: `possible restricted-category language: ${matched.map((c) => c.label).join(', ')}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------------------------

export interface CreativeContentCheckInput {
  buffer: Buffer;
  width?: number;
  height?: number;
  /** Ad copy (headline/body/CTA) supplied alongside the image, if any — spell-checked and
   *  policy-screened together with the OCR'd text. */
  adCopyText?: string;
  brand?: CreativeBrandProfile;
  /** The account's persisted brand logo bytes, if any (fetched by the caller — see
   *  `creativeContentCheckRunner.ts`). Absent means `logo_presence` reads as `skipped`. */
  logoBuffer?: Buffer;
}

/**
 * Runs every content check and returns them in a stable order (matching `CHECK_IDS` in
 * `creativeGates.ts`), ready to be appended onto an existing `CreativeGateResult.checks`. Never
 * throws — each sub-check independently degrades to `skipped` on its own failure.
 */
export async function runCreativeContentChecks(input: CreativeContentCheckInput): Promise<CreativeGateCheck[]> {
  const ocrMeasurement = await measureOcr(input.buffer, input.width, input.height);
  const ocrChecks = evaluateOcrChecks(ocrMeasurement);

  const combinedText = [ocrMeasurement?.text, input.adCopyText].filter((t): t is string => !!t && t.trim().length > 0).join('\n');

  const spellingMeasurement = await measureSpelling(combinedText, input.brand?.vocabulary ?? []);
  const spellingCheck = evaluateSpellingCheck(spellingMeasurement);

  const paletteMeasurement = await measurePalette(input.buffer);
  const brandColourCheck = evaluateBrandColourCheck(paletteMeasurement, input.brand?.colours ?? []);

  const logoMeasurement = input.logoBuffer
    ? await measureLogoMatch(input.buffer, input.logoBuffer)
    : undefined;
  const logoCheck = evaluateLogoPresenceCheck(logoMeasurement, !!input.logoBuffer);

  const policyCheck = evaluatePolicyKeywordCheck(combinedText);

  return [...ocrChecks, spellingCheck, brandColourCheck, logoCheck, policyCheck];
}
