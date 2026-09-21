/**
 * Placid image rendering over the REST API — ENG-1972.
 *
 * ## Why not the URL API
 *
 * The render used to be a plain GET of `api.placid.app/u/<template_uuid>?<layers>`.
 * In production that endpoint answers **403 Forbidden** for this project — for a
 * parameter-free request too, so it is not about what we send — while the REST
 * calls beside it (template listing, editor token) succeed with the private
 * token. Placid lets a project restrict the URL API to signed URLs, which is the
 * likely reason; either way the effect was that no ad image could be created at
 * all, and production recorded zero Placid renders and zero Placid spend.
 *
 * The REST API authenticates with the same token this backend already holds and
 * already uses successfully, so it does not depend on that project setting.
 *
 * ## Shape
 *
 * `POST /images` returns an image object immediately: `finished` with an
 * `image_url` when `create_now` was honoured, `queued` with a `polling_url`
 * otherwise, or `error`. Placid documents `create_now` as best-effort — it "may
 * fail under high load" — so a queued response is normal and is polled, not an
 * error. Polling is bounded because this runs inside a user's request.
 */

import axios from 'axios';
import { recordVendorUsage } from './usageRecorderService';

export const PLACID_REST_API_BASE = process.env.PLACID_REST_API_BASE || 'https://api.placid.app/api/rest';

/** Bounded so the caller's HTTP request cannot hang on a stuck queue. */
export const PLACID_POLL_ATTEMPTS = 10;
export const PLACID_POLL_INTERVAL_MS = 1_500;

export class PlacidRenderError extends Error {
  constructor(
    message: string,
    /** Placid's own `status` when it reported one, e.g. `error`. */
    readonly placidStatus?: string,
  ) {
    super(message);
    this.name = 'PlacidRenderError';
  }
}

interface PlacidImageResponse {
  id?: number | string;
  status?: 'queued' | 'finished' | 'error' | string;
  image_url?: string | null;
  polling_url?: string | null;
  errors?: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Whether `candidate` addresses the same scheme+host as `base`. Used to decide
 * if a URL handed back by the API may carry our private token.
 */
function isSameOrigin(candidate: string, base: string): boolean {
  try {
    const c = new URL(candidate);
    const b = new URL(base);
    return c.protocol === b.protocol && c.host === b.host;
  } catch {
    return false;
  }
}

/** One log record, bounded — see describePlacidError. */
export const MAX_DESCRIBED_ERROR_CHARS = 600;

/** Collapse newlines and runs of whitespace so one failure is one log line. */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A Placid failure in the form a log reader can act on: the HTTP status and the
 * vendor's own message, not just "Request failed with status code 403".
 *
 * That bare axios string cost three round-trips of investigation on ENG-1972 —
 * the answer was sitting in the response body all along
 * (`{"message":"Requires Subscription and Credits"}`: the account had no
 * subscription, so no render could ever succeed). Placid's error bodies carry no
 * credentials; the request headers, which do, are never touched here.
 *
 * The RESULT is what is bounded, on one line — not just the body. A vendor can
 * put its megabyte in the status text or in a multiline message just as easily
 * as in the body, and this repo has already had a disk-fill incident from
 * oversized log records.
 */
export function describePlacidError(error: unknown): string {
  const res = (error as { response?: { status?: number; data?: unknown } })?.response;
  const message = error instanceof Error ? error.message : String(error);

  let described: string;
  if (!res) {
    described = message;
  } else {
    let body: string;
    try {
      body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    } catch {
      body = '<unserializable response body>';
    }
    described = `HTTP ${res.status ?? '?'}${body ? `: ${body}` : ''} (${message})`;
  }

  const flat = toSingleLine(described);
  return flat.length > MAX_DESCRIBED_ERROR_CHARS
    ? `${flat.slice(0, MAX_DESCRIBED_ERROR_CHARS)}…`
    : flat;
}

/** Who a successful render is billed to (ENG-698 / ENG-1957). */
export interface PlacidRenderBilling {
  /** The acting caller. */
  userId: string;
  /** Who pays: the task owner or the chat session owner, never the caller. */
  billingUserId: string;
  /** Set only when the caller is not the owner, e.g. an admin rendering for them. */
  onBehalfOf?: string;
  /** Present for a render started from an Emma chat image. */
  sessionId?: string;
}

/**
 * Meter one successful render.
 *
 * Deliberately lives beside the call that spends the money rather than in the
 * controller: ENG-701's coverage guard holds every paid-vendor egress site to
 * booking its own usage, and this is the only place that knows a render actually
 * produced an image. Priced by `rateKey` inside the recorder (ENG-1929), so a
 * rate-card key rename records `unpriced` and logs loudly instead of throwing
 * into the render (ENG-698 AC6); the try/catch is the last line of defence.
 */
function meterRender(billing: PlacidRenderBilling): void {
  try {
    void recordVendorUsage({
      userId: billing.userId,
      billingUserId: billing.billingUserId,
      ...(billing.onBehalfOf ? { onBehalfOf: billing.onBehalfOf } : {}),
      ...(billing.sessionId ? { sessionId: billing.sessionId } : {}),
      provider: 'placid',
      operation: 'image_render',
      feature: 'ad_image',
      unit: 'render',
      quantity: 1,
      rateKey: 'image_render',
    });
  } catch (meterErr) {
    console.error(
      '[Placid] failed to meter render (image still served):',
      meterErr instanceof Error ? meterErr.message : meterErr,
    );
  }
}

/**
 * Render one image and return its Placid URL.
 *
 * Throws `PlacidRenderError` when Placid reports `error` or the render is still
 * unfinished at the polling ceiling; an HTTP failure propagates as the axios
 * error, so the caller can tell a refused request from a slow one. A render that
 * produced an image is metered before returning — nothing that fails is booked.
 */
export async function renderPlacidImage(opts: {
  token: string;
  templateUuid: string;
  layers: Record<string, Record<string, unknown>>;
  billing: PlacidRenderBilling;
  base?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ imageUrl: string }> {
  const base = opts.base || PLACID_REST_API_BASE;
  const sleep = opts.sleep || defaultSleep;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'application/json',
  };

  const created = await axios.post<PlacidImageResponse>(
    `${base}/images`,
    {
      template_uuid: opts.templateUuid,
      layers: opts.layers,
      // Ask for a synchronous render; a queue is still possible under load.
      create_now: true,
    },
    { headers, timeout: 30_000 },
  );

  let image = created.data || {};
  if (image.status === 'error') {
    throw new PlacidRenderError('Placid reported an error creating the image', 'error');
  }
  if (image.status === 'finished' && image.image_url) {
    meterRender(opts.billing);
    return { imageUrl: image.image_url };
  }

  // Queued: poll until it finishes, errors, or we hit the ceiling.
  //
  // The polling request carries the private token, and `polling_url` arrives in
  // a response body — so it is only followed when it points at the same origin
  // we called. Anything else is ignored in favour of the id-derived URL we built
  // ourselves, rather than sending the token wherever the body says
  // (CodeRabbit, #2943).
  const idDerivedUrl = image.id ? `${base}/images/${image.id}` : null;
  let pollingUrl: string | null = idDerivedUrl;
  if (image.polling_url) {
    if (isSameOrigin(image.polling_url, base)) {
      pollingUrl = image.polling_url;
    } else {
      console.warn('[Placid] ignoring off-origin polling_url from the API response');
    }
  }
  if (!pollingUrl) {
    throw new PlacidRenderError('Placid returned no image and no polling URL', image.status);
  }

  for (let attempt = 0; attempt < PLACID_POLL_ATTEMPTS; attempt++) {
    await sleep(PLACID_POLL_INTERVAL_MS);
    const polled = await axios.get<PlacidImageResponse>(pollingUrl, { headers, timeout: 15_000 });
    image = polled.data || {};
    if (image.status === 'error') {
      throw new PlacidRenderError('Placid reported an error rendering the image', 'error');
    }
    if (image.status === 'finished' && image.image_url) {
      meterRender(opts.billing);
      return { imageUrl: image.image_url };
    }
  }

  throw new PlacidRenderError(
    `Placid image was still ${image.status || 'unfinished'} after ${PLACID_POLL_ATTEMPTS} polls`,
    image.status,
  );
}
