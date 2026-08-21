export interface LlmUsageTopUpPackage {
  id: string;
  label: string;
  priceCents: number;
  usageCreditMicroUsd: number;
  active: boolean;
}

export interface LlmUsageTopUpConfig {
  enabled: boolean;
  minimumMarkupBps: number;
  packages: LlmUsageTopUpPackage[];
}

export function validateLlmUsageTopUpConfig(config: LlmUsageTopUpConfig): string[] {
  const errors: string[] = [];
  if (typeof config.enabled !== 'boolean') errors.push('enabled must be boolean');
  if (!Number.isInteger(config.minimumMarkupBps) || config.minimumMarkupBps < 10_000) {
    errors.push('minimumMarkupBps must be an integer of at least 10000 (1x)');
  }
  if (!Array.isArray(config.packages)) errors.push('packages must be an array');
  const ids = new Set<string>();
  for (const [index, item] of (config.packages || []).entries()) {
    const prefix = `packages[${index}]`;
    if (!item.id?.trim()) errors.push(`${prefix}.id is required`);
    if (ids.has(item.id)) errors.push(`${prefix}.id must be unique`);
    ids.add(item.id);
    if (!item.label?.trim()) errors.push(`${prefix}.label is required`);
    if (!Number.isInteger(item.priceCents) || item.priceCents <= 0) errors.push(`${prefix}.priceCents must be positive`);
    if (!Number.isInteger(item.usageCreditMicroUsd) || item.usageCreditMicroUsd <= 0) {
      errors.push(`${prefix}.usageCreditMicroUsd must be positive`);
    } else if (Number.isInteger(item.priceCents) && item.priceCents > 0) {
      // 1 cent = 10,000 micro-USD. Markup bps = customer price / provider
      // credit * 10,000. Integer cross-multiplication avoids float drift.
      const actualMarkupNumerator = item.priceCents * 10_000 * 10_000;
      const requiredMarkupNumerator = item.usageCreditMicroUsd * config.minimumMarkupBps;
      if (actualMarkupNumerator < requiredMarkupNumerator) {
        errors.push(`${prefix} is below minimumMarkupBps`);
      }
    }
  }
  return errors;
}

export function getActiveLlmUsageTopUpPackages(config: LlmUsageTopUpConfig | null | undefined) {
  if (!config || !config.enabled || validateLlmUsageTopUpConfig(config).length > 0) return [];
  return config.packages.filter((item) => item.active).map((item) => ({ ...item }));
}

export function resolveLlmUsageTopUpPackage(
  config: LlmUsageTopUpConfig | null | undefined,
  packageId: string,
): LlmUsageTopUpPackage | null {
  return getActiveLlmUsageTopUpPackages(config).find((item) => item.id === packageId) || null;
}
