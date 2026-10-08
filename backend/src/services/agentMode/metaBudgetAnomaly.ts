/** Both values must be in the same currency unit (the caller uses Meta minor units). */
export function classifyMetaBudgetChange(prior: unknown, proposed: unknown) {
  const amount = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const before = amount(prior);
  const after = amount(proposed);
  if (before === undefined || after === undefined) {
    return { severity: 'unknown' as const, ratio: null, prior: before, proposed: after };
  }
  return {
    severity: after > before * 10 ? 'critical' as const : after > before * 2 ? 'warning' as const : 'normal' as const,
    ratio: before > 0 ? after / before : null,
    prior: before,
    proposed: after,
  };
}
