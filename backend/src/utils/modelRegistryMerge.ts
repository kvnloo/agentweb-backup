/**
 * ENG-1777 (ENG-1689 design item 3): field split for AW-ModelRegistry items.
 *
 * The OpenRouter discovery poll owns a fixed, explicitly enumerated set of
 * auto-derived fields. Everything else on a registry item is an AgentWeb
 * overlay (tier, qualityScore, description, enabled, BYOK, priceOverrideUsd…)
 * that the poll must never write once set. This is an allow-list on purpose:
 * a denylist silently starts overwriting any overlay field added later.
 *
 * Pure module — no table name, no DynamoDB, no I/O. The discovery job
 * (ENG-1776) calls mergeDiscoveredModel() before its upsert.
 */

/** Poll-owned fields. Enumerated explicitly; never derived by exclusion. */
export const AUTO_DERIVED_FIELDS = Object.freeze([
  "upstreamId",
  "inputPricePerM",
  "outputPricePerM",
  "cacheReadPricePerM",
  "cacheWritePricePerM",
  "contextLength",
  "modalities",
  "supportsVision",
  "supportsTemperature",
  "supportedParams",
] as const);

export type AutoDerivedField = (typeof AUTO_DERIVED_FIELDS)[number];

/** AgentWeb-owned fields. Listed for documentation/tests; the merge never reads this list. */
export const OVERLAY_FIELDS = Object.freeze([
  "tier",
  "qualityScore",
  "qualityScoreSource",
  "description",
  "enabled",
  "adminOnly",
  "legacy",
  "family",
  "byokDeploymentId",
  "priceOverrideUsd",
] as const);

export type RegistryItem = { modelId: string } & Record<string, unknown>;
export type PolledModel = { modelId: string } & Partial<Record<AutoDerivedField, unknown>> &
  Record<string, unknown>;

const AUTO_DERIVED_SET: ReadonlySet<string> = new Set(AUTO_DERIVED_FIELDS);

/**
 * Merge one polled upstream model into the existing registry item.
 * - Existing item: copy only allow-listed keys from the poll; every other key
 *   on the existing item is preserved byte-for-byte.
 * - New discovery: allow-listed keys only, landing `enabled: false` so nothing
 *   reaches customers without an explicit overlay decision.
 */
export function mergeDiscoveredModel(
  existing: RegistryItem | undefined,
  polled: PolledModel,
): RegistryItem {
  const derived: Record<string, unknown> = {};
  for (const key of Object.keys(polled)) {
    if (AUTO_DERIVED_SET.has(key) && polled[key] !== undefined) derived[key] = polled[key];
  }
  if (!existing) return { modelId: polled.modelId, ...derived, enabled: false };
  return { ...existing, ...derived, modelId: existing.modelId };
}

/**
 * Billed per-million price for a registry item. An explicit priceOverrideUsd
 * (e.g. BYOK billed at Azure's rate) always wins over the poll-derived price.
 */
export function billedPricePerM(
  item: RegistryItem,
): { inPerM: number; outPerM: number } | undefined {
  const o = item.priceOverrideUsd as { inPerM?: unknown; outPerM?: unknown } | undefined;
  if (o && typeof o.inPerM === "number" && typeof o.outPerM === "number") {
    return { inPerM: o.inPerM, outPerM: o.outPerM };
  }
  const inPerM = item.inputPricePerM;
  const outPerM = item.outputPricePerM;
  if (typeof inPerM === "number" && typeof outPerM === "number") return { inPerM, outPerM };
  return undefined;
}
