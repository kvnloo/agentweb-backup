/** Shared Marketing API/CAPI BUC usage, percentages of the rolling allowance. */
export interface CapiUsage {
  callCountPct: number;
  totalTimePct: number;
  totalCpuTimePct: number;
  estimatedMinutesToRegainAccess?: number;
}

/** Parse the worst usage/estimate across all account/use-case entries; malformed headers are inconclusive. */
export function parseBusinessUseCaseUsage(response: { headers?: { get?: (name: string) => string | null } }): CapiUsage | undefined {
  try {
    const raw = response.headers?.get?.('x-business-use-case-usage');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    const entries = Object.values(parsed).flatMap(value => Array.isArray(value) ? value : []).filter(entry => entry && typeof entry === 'object');
    if (!entries.length) return undefined;
    const finite = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    const estimates = entries.filter(entry => entry.estimated_time_to_regain_access !== undefined)
      .map(entry => finite(entry.estimated_time_to_regain_access));
    return {
      callCountPct: Math.max(...entries.map(entry => finite(entry.call_count))),
      totalTimePct: Math.max(...entries.map(entry => finite(entry.total_time))),
      totalCpuTimePct: Math.max(...entries.map(entry => finite(entry.total_cputime))),
      estimatedMinutesToRegainAccess: estimates.length ? Math.max(...estimates) : undefined,
    };
  } catch {
    return undefined;
  }
}
