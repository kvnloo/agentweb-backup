/**
 * ENG-2278 (ENG-2046 A1b): budget writes get the same independent read-back as spend caps.
 * "Campaign/Ad set updated successfully" on a money field without reading it back was the
 * same silent-success failure mode ENG-1018 closed for spend_cap. Three outcomes, never two:
 *   CONFIRMED   — every requested budget field read back equal (minor units).
 *   MISMATCH    — Meta returned the field with a DIFFERENT value on every attempt.
 *   UNCONFIRMED — the read failed or the field was absent; not a failed write, never success.
 * Only the read is retried; the write is never re-sent.
 */
export const BUDGET_VERIFY_FIELDS = ['daily_budget', 'lifetime_budget'] as const;

export interface BudgetVerifyOptions {
  attempts: number;
  backoffMs: number;
}

export interface BudgetVerdict {
  status: 'CONFIRMED' | 'MISMATCH' | 'UNCONFIRMED';
  requested: Record<string, number>;
  applied: Record<string, number | undefined>;
  detail: string;
  attempts: number;
}

export async function verifyMetaBudget(
  read: () => Promise<any>,
  intended: Record<string, any>,
  opts: BudgetVerifyOptions
): Promise<BudgetVerdict> {
  const requested: Record<string, number> = {};
  for (const f of BUDGET_VERIFY_FIELDS) {
    if (intended[f] !== undefined && intended[f] !== null) requested[f] = Number(intended[f]);
  }
  let applied: Record<string, number | undefined> = {};
  let status: 'MISMATCH' | 'UNCONFIRMED' = 'UNCONFIRMED';
  let detail = 'not read';
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      const fresh: any = await read();
      applied = {};
      let absent = false;
      const diffs: string[] = [];
      for (const [f, want] of Object.entries(requested)) {
        const raw = fresh?.[f];
        const got = raw === undefined || raw === null || raw === '' ? undefined : Number(raw);
        applied[f] = got;
        if (got === undefined || !Number.isFinite(got)) absent = true;
        else if (got !== want) diffs.push(`${f}: requested ${want}, Meta has ${got}`);
      }
      if (!absent && diffs.length === 0) {
        return { status: 'CONFIRMED', requested, applied, detail: 'budget read back as requested', attempts: attempt };
      }
      status = diffs.length > 0 ? 'MISMATCH' : 'UNCONFIRMED';
      detail = diffs.length > 0 ? diffs.join('; ') : 'the budget field was absent on read-back';
    } catch (error: any) {
      status = 'UNCONFIRMED';
      detail = `read-back failed: ${error?.message || 'unknown error'}`;
    }
    if (attempt < opts.attempts) {
      await new Promise(resolve => setTimeout(resolve, opts.backoffMs));
    }
  }
  return { status, requested, applied, detail, attempts: opts.attempts };
}

export function hasBudgetField(params: Record<string, any>): boolean {
  return BUDGET_VERIFY_FIELDS.some(f => params[f] !== undefined && params[f] !== null);
}

/** Shape a verifyMetaBudget verdict into tool-result fields. Never success:false — the write landed. */
export function budgetVerdictFields(
  what: string,
  check: BudgetVerdict,
  describeMinorUnits: (minorUnits: number) => string
): Record<string, any> {
  const fmt = (rec: Record<string, number | undefined>) => Object.entries(rec)
    .map(([f, v]) => `${f}=${v === undefined ? 'absent' : describeMinorUnits(v)}`).join(', ');
  const base = {
    budget_verification: check.status,
    budget_requested: check.requested,
    budget_applied: check.applied,
  };
  if (check.status === 'CONFIRMED') {
    return { ...base, budget_message: `budget verified: ${fmt(check.applied)}` };
  }
  if (check.status === 'MISMATCH') {
    return {
      ...base,
      error: 'BUDGET_MISMATCH',
      budget_message: `⚠️ The budget on ${what} does NOT match what was requested after ${check.attempts} read-back(s): ` +
        `requested ${fmt(check.requested)}; Meta has ${fmt(check.applied)}. Tell the user both values; ` +
        `do NOT claim the requested budget is in place.`,
    };
  }
  return {
    ...base,
    error: 'BUDGET_UNCONFIRMED',
    budget_message: `⚠️ The budget write on ${what} was accepted by Meta but could NOT be confirmed after ` +
      `${check.attempts} read-back(s) — ${check.detail}. This is not a failure, but do NOT tell the user the ` +
      `budget (${fmt(check.requested)}) is in place until a re-read confirms it.`,
  };
}
