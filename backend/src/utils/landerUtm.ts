/**
 * landerUtm — the single precedence resolver for the UTM parameters a generated
 * landing page emits. ENG-723 (slice A of ENG-538 / ENG-327).
 *
 * Resolution order, from Harsha's approved contract:
 *
 *   incoming visitor params > per-lander override > customer default > absent
 *
 * Resolved **per key**, not per layer: a visitor arriving with only `utm_source`
 * must not erase a `utm_medium` the customer configured. That is what makes
 * pass-through useful — an ad supplies the real traffic source while the
 * customer's standing config fills in everything the ad did not set.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **Absent is absent.** A key no layer supplies is omitted from the output
 *    entirely. It is never emitted as `key=`, which downstream analytics reads
 *    as a real (empty) value and which would overwrite a good value on a later
 *    merge.
 * 2. **Click IDs survive.** `gclid`/`fbclid` are click-time values owned by the
 *    ad platform. They come only from the visitor, pass through verbatim, and no
 *    configuration layer may set or shadow them.
 * 3. **Our attribution never squats on the customer's.** AgentWeb provenance
 *    lives in its own `aw_lander` field. The customer's `utm_source` stays the
 *    customer's — the original RankAI complaint was exactly this collision.
 *
 * The output is a plain object keyed by parameter name, so a duplicate key is
 * structurally impossible rather than merely avoided.
 *
 * This module is **pure**: same inputs produce the same output, it reads no
 * clock, environment, randomness, network, or storage, and it does not mutate
 * its arguments. Later slices (Meta `url_tags`, lander outbound-link decoration,
 * the inherited-vs-overridden UI) all consume this one resolver rather than
 * re-deriving precedence — a second parameter system is what the contract
 * forbids.
 */

import { UTM_KEYS, type UtmKey } from "./adUtm";

/** AgentWeb's own provenance marker. Deliberately not a `utm_*` key. */
export const LANDER_PROVENANCE_KEY = "aw_lander";
export const LANDER_PROVENANCE_VALUE = "1";

/**
 * Click identifiers minted by the ad platform at click time. They are read from
 * the visitor only — no stored configuration can produce a valid one, so a
 * config layer offering one is a mistake worth surfacing, not honouring.
 */
export const CLICK_ID_KEYS = ["gclid", "fbclid"] as const;
export type ClickIdKey = (typeof CLICK_ID_KEYS)[number];

/** A stored UTM configuration: the customer default, or a per-lander override. */
export type UtmConfig = Partial<Record<UtmKey, string>>;

/** Which layer supplied a resolved parameter. Slice E renders this as inherited vs overridden. */
export type ParamOrigin = "visitor" | "override" | "default" | "provenance";

export interface ResolveLanderParamsInput {
  /** Query parameters the visitor arrived with, already parsed into an object. */
  visitor?: Record<string, unknown>;
  /** The per-lander override, if this lander has one. */
  override?: UtmConfig;
  /** The customer-level default. */
  customerDefault?: UtmConfig;
}

export interface ResolvedLanderParams {
  /** Parameters to emit, in deterministic order, each key present at most once. */
  params: Record<string, string>;
  /** The winning layer per emitted key, parallel to `params`. */
  origins: Record<string, ParamOrigin>;
}

/** The keys a stored configuration is allowed to set. */
const CONFIGURABLE_KEYS: ReadonlySet<string> = new Set<string>(UTM_KEYS);

/**
 * Keys a configuration may never set: the click IDs (owned by the ad platform)
 * and our provenance marker (owned by this resolver). Rejecting them is what
 * stops a stored config from quietly shadowing an inbound `gclid`.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set<string>([
  ...CLICK_ID_KEYS,
  LANDER_PROVENANCE_KEY,
]);

/** A type name precise enough to debug from, unlike a bare `typeof`. */
function typeName(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

/** Written as separate guards rather than a chained condition so each rejection is individually provable. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object") {
    return false;
  }
  if (value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  return true;
}

/**
 * Validate a stored UTM configuration and return a trimmed copy.
 *
 * Strict on purpose. A stored config is authored — by a customer in the UI or by
 * a later slice writing a record — so an unknown key, a non-string value, or a
 * blank value is a real defect. Ignoring it would silently drop a parameter the
 * author believed was live, which is precisely the failure this contract calls out.
 * Exported so the storage and UI slices can validate at write time using the same
 * rules the resolver applies at read time.
 *
 * `label` names the layer in any error, so a failure says which config is wrong.
 */
export function validateUtmConfig(config: unknown, label: string): UtmConfig {
  if (config === undefined) {
    return {};
  }
  if (!isPlainObject(config)) {
    throw new Error(`landerUtm: ${label} must be an object, got ${typeName(config)}`);
  }

  const validated: UtmConfig = {};
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `landerUtm: ${label} may not set reserved parameter "${key}" — it is supplied at click time, not by configuration`,
      );
    }
    if (!CONFIGURABLE_KEYS.has(key)) {
      throw new Error(
        `landerUtm: ${label} has unsupported parameter "${key}"; allowed: ${UTM_KEYS.join(", ")}`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `landerUtm: ${label} "${key}" must be a string, got ${typeName(value)}`,
      );
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      throw new Error(
        `landerUtm: ${label} "${key}" is empty — remove the key instead of storing a blank value`,
      );
    }
    validated[key as UtmKey] = trimmed;
  }
  return validated;
}

/**
 * Read one declared key from the visitor's parsed query parameters.
 *
 * Absent, unset, and blank all mean "the visitor did not supply this", so
 * resolution falls through to the next layer — matching the marketing-site
 * reference implementation this ports from, where a bare `?utm_source=` is
 * treated as no value rather than as an empty one.
 *
 * A non-string value is different: a query parser yields an array for a repeated
 * key (`?utm_source=a&utm_source=b`), and picking one silently would be an
 * invisible attribution decision. That throws.
 */
function readVisitorValue(visitor: Record<string, unknown>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(visitor, key)) {
    return undefined;
  }
  const value = visitor[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(
      `landerUtm: visitor parameter "${key}" must be a string, got ${typeName(value)}`,
    );
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  return trimmed;
}

/**
 * Resolve the parameters a lander should emit on its outbound links, and the
 * `url_tags` its Meta ads should carry.
 *
 * Only declared keys are read from the visitor. That allowlist is deliberate:
 * outbound links point at the customer's own domain, so reflecting arbitrary
 * inbound query parameters onto them would let any third party attach whatever
 * they liked to a customer's traffic.
 */
export function resolveLanderParams(
  input: ResolveLanderParamsInput = {},
): ResolvedLanderParams {
  if (!isPlainObject(input)) {
    throw new Error(`landerUtm: input must be an object, got ${typeName(input)}`);
  }

  const rawVisitor = input.visitor;
  let visitor: Record<string, unknown> = {};
  if (rawVisitor !== undefined) {
    if (!isPlainObject(rawVisitor)) {
      throw new Error(
        `landerUtm: visitor parameters must be an object, got ${typeName(rawVisitor)}`,
      );
    }
    visitor = rawVisitor;
  }

  const override = validateUtmConfig(input.override, "per-lander override");
  const customerDefault = validateUtmConfig(input.customerDefault, "customer default");

  const params: Record<string, string> = {};
  const origins: Record<string, ParamOrigin> = {};

  // UTM keys first, in the canonical order, so output is byte-stable.
  for (const key of UTM_KEYS) {
    const visitorValue = readVisitorValue(visitor, key);
    if (visitorValue !== undefined) {
      params[key] = visitorValue;
      origins[key] = "visitor";
      continue;
    }
    const overrideValue = override[key];
    if (overrideValue !== undefined) {
      params[key] = overrideValue;
      origins[key] = "override";
      continue;
    }
    const defaultValue = customerDefault[key];
    if (defaultValue !== undefined) {
      params[key] = defaultValue;
      origins[key] = "default";
      continue;
    }
    // No layer supplied it: the key stays absent. Never `key=`.
  }

  // Click IDs: visitor-only, verbatim, never renamed.
  for (const key of CLICK_ID_KEYS) {
    const value = readVisitorValue(visitor, key);
    if (value !== undefined) {
      params[key] = value;
      origins[key] = "visitor";
    }
  }

  // Provenance is always ours, written exactly once. A visitor arriving with an
  // `aw_lander` of their own is not read, so it can neither duplicate the key nor
  // forge the value.
  params[LANDER_PROVENANCE_KEY] = LANDER_PROVENANCE_VALUE;
  origins[LANDER_PROVENANCE_KEY] = "provenance";

  return { params, origins };
}
