/**
 * Creative deterministic gates (ENG-2139, ENG-2128 T7).
 *
 * Code checks on a generated image: does it decode, is it a blank/near-uniform (broken)
 * render, does its shape and size fit the placement that was asked for, is the file within the
 * platform's upload limit, and did the provider silently substitute a different aspect ratio.
 *
 * ADVISORY ONLY. Results are attached to the generation result and the human-eval candidate;
 * nothing blocks on them until the grader is validated against human labels (ENG-2136, see
 * `mayGate('creative-deterministic-gates')` in loops/eval/evalRegistry.ts).
 *
 * Not included: OCR text-area ratio / spelling. The only open-source option (tesseract.js)
 * downloads language data from a CDN at runtime unless it is vendored; deferred rather than
 * shipping a half-working check.
 *
 * `evaluateCreativeGates` is pure (measurement in, verdict out). `runCreativeGates` measures a
 * buffer with sharp (already a backend dependency, loaded lazily) and never throws.
 */
import {
  PLACEMENT_SPECS,
  aspectDeviation,
  placementForSize,
  requestedAspect,
  type AspectResolution,
  type PlacementId,
  type PlacementSpec,
} from './creativePlacementSpecs';

export const CREATIVE_GATES_GRADER_ID = 'creative-deterministic-gates';
export const CREATIVE_GATES_VERSION = '2026-09-25.1';

export type CreativeGateCheckId =
  | 'decode'
  | 'blank_render'
  | 'aspect_ratio'
  | 'dimensions'
  | 'file_size'
  | 'aspect_fallback';

export type CreativeGateStatus = 'pass' | 'fail' | 'skipped';

export interface CreativeGateCheck {
  id: CreativeGateCheckId;
  status: CreativeGateStatus;
  reason?: string;
}

export interface CreativeGateResult {
  graderId: typeof CREATIVE_GATES_GRADER_ID;
  version: string;
  /** Always true until the grader is validated; consumers must not block on `passed`. */
  advisory: true;
  /** True when no check failed (skipped checks do not count). */
  passed: boolean;
  checks: CreativeGateCheck[];
  requestedSize?: string;
  placement?: PlacementId;
  width?: number;
  height?: number;
  bytes: number;
  format?: string;
  /** Placements whose aspect ratio and minimum size the image satisfies. */
  fitsPlacements: PlacementId[];
  evaluatedAt: string;
}

/** What `runCreativeGates` reads from the image; also the pure evaluator's input. */
export interface ImageMeasurement {
  bytes: number;
  decoded: boolean;
  decodeError?: string;
  width?: number;
  height?: number;
  format?: string;
  /** Standard deviation of luminance (0-255) on a 64x64 greyscale thumbnail. */
  luminanceStdDev?: number;
}

export interface CreativeGateRequest {
  /** The `size` passed to generation ("1080x1350", "4:5", "auto", …). */
  requestedSize?: string;
  /** Explicit placement; otherwise inferred when `requestedSize` is a placement's exact size. */
  placement?: PlacementId;
  /** Present when the provider maps size → aspect ratio itself (Gemini 3). */
  aspectResolution?: AspectResolution;
}

/**
 * Luminance std-dev below this reads as a flat fill (blank, all-black, fully transparent,
 * single-colour). A real ad — even a minimal typographic one — has text and edges well above it.
 */
export const BLANK_RENDER_MAX_STDDEV = 4;

/** Aspect tolerance when only a ratio was requested (no placement to take it from). */
const DEFAULT_ASPECT_TOLERANCE = 0.03;

const THUMBNAIL_SIZE = 64;

function specFits(spec: PlacementSpec, width: number, height: number): boolean {
  return (
    aspectDeviation(width / height, spec.width / spec.height) <= spec.aspectTolerance &&
    width >= spec.minWidth &&
    height >= spec.minHeight
  );
}

function checkAspectFallback(request: CreativeGateRequest): CreativeGateCheck {
  const resolution = request.aspectResolution;
  if (!resolution) {
    return { id: 'aspect_fallback', status: 'skipped', reason: 'provider takes the size as given' };
  }
  if (!resolution.fallback) return { id: 'aspect_fallback', status: 'pass' };
  return {
    id: 'aspect_fallback',
    status: 'fail',
    reason: `requested size "${request.requestedSize}" was sent to the provider as ${resolution.aspectRatio} (${resolution.fallback})`,
  };
}

/** Pure verdict from a measurement. Order of `checks` is stable. */
export function evaluateCreativeGates(
  m: ImageMeasurement,
  request: CreativeGateRequest = {},
  now: Date = new Date(),
): CreativeGateResult {
  const spec = request.placement ? PLACEMENT_SPECS[request.placement] : placementForSize(request.requestedSize);
  const checks: CreativeGateCheck[] = [];
  const hasSize = m.decoded && !!m.width && !!m.height;
  const width = m.width ?? 0;
  const height = m.height ?? 0;

  checks.push(
    hasSize
      ? { id: 'decode', status: 'pass' }
      : { id: 'decode', status: 'fail', reason: m.decodeError || 'image has no readable dimensions' },
  );

  if (!hasSize || m.luminanceStdDev === undefined) {
    checks.push({ id: 'blank_render', status: 'skipped', reason: 'image did not decode' });  } else if (m.luminanceStdDev < BLANK_RENDER_MAX_STDDEV) {
    checks.push({
      id: 'blank_render',
      status: 'fail',
      reason: `near-uniform image (luminance std-dev ${m.luminanceStdDev.toFixed(2)} < ${BLANK_RENDER_MAX_STDDEV})`,
    });
  } else {
    checks.push({ id: 'blank_render', status: 'pass' });
  }

  const target = spec ? spec.width / spec.height : requestedAspect(request.requestedSize);
  const tolerance = spec ? spec.aspectTolerance : DEFAULT_ASPECT_TOLERANCE;
  if (!hasSize) {
    checks.push({ id: 'aspect_ratio', status: 'skipped', reason: 'image did not decode' });
  } else if (target === null) {
    checks.push({ id: 'aspect_ratio', status: 'skipped', reason: 'no aspect ratio was requested' });
  } else {
    const deviation = aspectDeviation(width / height, target);
    checks.push(
      deviation <= tolerance
        ? { id: 'aspect_ratio', status: 'pass' }
        : {
            id: 'aspect_ratio',
            status: 'fail',
            reason: `${width}x${height} is ${(width / height).toFixed(3)}:1, requested ${target.toFixed(3)}:1 (off by ${(deviation * 100).toFixed(1)}%, tolerance ${(tolerance * 100).toFixed(0)}%)`,
          },
    );
  }

  if (!spec) {
    checks.push({ id: 'dimensions', status: 'skipped', reason: 'no placement requested' });
  } else if (!hasSize) {
    checks.push({ id: 'dimensions', status: 'skipped', reason: 'image did not decode' });
  } else if (width < spec.minWidth || height < spec.minHeight) {
    checks.push({
      id: 'dimensions',
      status: 'fail',
      reason: `${width}x${height} is below the ${spec.label} minimum ${spec.minWidth}x${spec.minHeight}`,
    });
  } else {
    checks.push({ id: 'dimensions', status: 'pass' });
  }

  if (!spec) {
    // Without a placement there is no platform limit to hold the file against;
    // `fitsPlacements` still reports which placements it would be accepted for.
    checks.push({ id: 'file_size', status: 'skipped', reason: 'no placement requested' });
  } else if (m.bytes > spec.maxBytes) {
    checks.push({
      id: 'file_size',
      status: 'fail',
      reason: `${m.bytes} bytes exceeds the ${spec.label} limit of ${spec.maxBytes} bytes`,
    });
  } else {
    checks.push({ id: 'file_size', status: 'pass' });
  }

  checks.push(checkAspectFallback(request));

  const fitsPlacements = hasSize
    ? Object.values(PLACEMENT_SPECS)
        .filter((s) => specFits(s, width, height) && m.bytes <= s.maxBytes)
        .map((s) => s.id)
    : [];

  return {
    graderId: CREATIVE_GATES_GRADER_ID,
    version: CREATIVE_GATES_VERSION,
    advisory: true,
    passed: checks.every((c) => c.status !== 'fail'),
    checks,
    ...(request.requestedSize ? { requestedSize: request.requestedSize } : {}),
    ...(spec ? { placement: spec.id } : {}),
    ...(hasSize ? { width, height } : {}),
    bytes: m.bytes,
    ...(m.format ? { format: m.format } : {}),
    fitsPlacements,
    evaluatedAt: now.toISOString(),
  };
}

/** Reads dimensions, format and a luminance spread from the encoded image. Never throws. */
export async function measureImage(buffer: Buffer): Promise<ImageMeasurement> {
  const bytes = buffer.length;
  try {
    const { default: sharp } = await import('sharp');
    const meta = await sharp(buffer).metadata();
    const { data } = await sharp(buffer)
      .flatten({ background: '#808080' })
      .greyscale()
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      bytes,
      decoded: true,
      width: meta.width,
      height: meta.height,
      format: meta.format,
      luminanceStdDev: stdDev(data),
    };
  } catch (err) {
    return { bytes, decoded: false, decodeError: err instanceof Error ? err.message : String(err) };
  }
}

function stdDev(values: Uint8Array): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  return Math.sqrt(sq / values.length);
}

/** Measure + evaluate. Never throws; a decode failure is reported as a failed `decode` check. */
export async function runCreativeGates(buffer: Buffer, request: CreativeGateRequest = {}): Promise<CreativeGateResult> {
  return evaluateCreativeGates(await measureImage(buffer), request);
}
