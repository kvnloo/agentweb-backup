/**
 * ENG-3065 (ENG-592 slice 3): Meta updates and deletes are read back before the tool reports
 * success. `campaign.update()` returning without an error is not evidence the field changed.
 * Pattern: docs/ad-api-read-back-pattern.md. Budget fields, spend_cap and creative swaps keep
 * their own checks (metaBudgetReadBack, verifyCampaignSpendCap, verifyCreativeSwap).
 *
 * Only the read is retried; the write is never re-sent.
 */
export interface ReadBackOptions {
  attempts: number;
  backoffMs: number;
  /** Injected so the caller's own (test-stubbable) sleep is used. */
  sleep?: (ms: number) => Promise<unknown>;
}

/**
 * Fields compared on read-back, per object. Limited to scalars Meta echoes unchanged AND that
 * the existing single-object getters already request. Every other update field (targeting,
 * schedule, promoted_object, ...) is NOT verified here.
 */
export const META_READ_BACK_FIELDS = {
  campaign: ['name', 'status'],
  adSet: ['name', 'status', 'bid_strategy', 'bid_amount'],
  ad: ['name', 'status'],
} as const;

export type MetaReadBackObject = keyof typeof META_READ_BACK_FIELDS;

export interface MetaWriteFailure {
  success: false;
  errorType: 'unsupported_field' | 'read_back_failed';
  fields: string[];
  message: string;
  error: string;
}

const LABEL: Record<MetaReadBackObject, string> = { campaign: 'campaign', adSet: 'ad set', ad: 'ad' };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Compared as trimmed strings: Meta returns bid_amount as a string of minor units. */
function same(want: unknown, got: unknown): boolean {
  if (got === undefined || got === null) return false;
  return String(want).trim() === String(got).trim();
}

/** Meta answers a read of a hard-deleted or unknown node with code 100 / subcode 33. */
export function isMetaObjectNotFound(error: any): boolean {
  const e = error?.structuredError ?? error?.response?.error ?? error?.response ?? error ?? {};
  if (Number(e.error_subcode) === 33) return true;
  return Number(e.code) === 100 && /does not exist|unsupported get request/i.test(String(e.message ?? error?.message ?? ''));
}

/**
 * Read the object back after an update. Returns undefined when every checked field landed (or
 * none of the requested fields is checkable), otherwise a typed tool failure.
 */
export async function checkMetaUpdate(
  object: MetaReadBackObject,
  id: string,
  requested: Record<string, any>,
  read: () => Promise<any>,
  opts: ReadBackOptions,
): Promise<MetaWriteFailure | undefined> {
  const fields = META_READ_BACK_FIELDS[object].filter(f => requested?.[f] !== undefined && requested[f] !== null);
  if (fields.length === 0) return undefined;
  let unlanded: string[] = [];
  let detail = '';
  let readError: string | undefined;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      const live = await read();
      readError = undefined;
      unlanded = fields.filter(f => !same(requested[f], live?.[f]));
      if (unlanded.length === 0) return undefined;
      detail = unlanded
        .map(f => `${f}: requested ${JSON.stringify(requested[f])}, Meta has ${JSON.stringify(live?.[f] ?? null)}`)
        .join('; ');
    } catch (error: any) {
      readError = error?.message || 'unknown error';
    }
    if (attempt < opts.attempts) await (opts.sleep ?? sleep)(opts.backoffMs);
  }
  if (readError !== undefined) {
    const error = `read_back_failed: Meta accepted the update to ${LABEL[object]} ${id}, but it could not be read back ` +
      `after ${opts.attempts} attempt(s) (${readError}). The change is not confirmed. Read the ${LABEL[object]} ` +
      `before reporting it or sending the update again.`;
    return { success: false, errorType: 'read_back_failed', fields: [...fields], message: error, error };
  }
  const error = `unsupported_field: Meta accepted the update to ${LABEL[object]} ${id}, but these fields did not change ` +
    `after ${opts.attempts} read-back(s): ${detail}. Do not report them as updated.`;
  return { success: false, errorType: 'unsupported_field', fields: unlanded, message: error, error };
}

/**
 * Read the object back after a delete. Passes when it reads DELETED/ARCHIVED or is not found;
 * anything else is a typed failure.
 */
export async function checkMetaDelete(
  object: MetaReadBackObject,
  id: string,
  read: () => Promise<any>,
  opts: ReadBackOptions,
): Promise<MetaWriteFailure | undefined> {
  let status: unknown;
  let readError: string | undefined;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      const live = await read();
      readError = undefined;
      status = live?.status;
      if (status === 'DELETED' || status === 'ARCHIVED') return undefined;
    } catch (error: any) {
      if (isMetaObjectNotFound(error)) return undefined;
      readError = error?.message || 'unknown error';
    }
    if (attempt < opts.attempts) await (opts.sleep ?? sleep)(opts.backoffMs);
  }
  if (readError !== undefined) {
    const error = `read_back_failed: Meta accepted the delete of ${LABEL[object]} ${id}, but it could not be read back ` +
      `after ${opts.attempts} attempt(s) (${readError}). The delete is not confirmed. Read the ${LABEL[object]} ` +
      `before reporting it deleted.`;
    return { success: false, errorType: 'read_back_failed', fields: ['status'], message: error, error };
  }
  const error = `unsupported_field: Meta accepted the delete of ${LABEL[object]} ${id}, but it still reads back with status ` +
    `${JSON.stringify(status ?? null)} after ${opts.attempts} read-back(s). Do not report it as deleted.`;
  return { success: false, errorType: 'unsupported_field', fields: ['status'], message: error, error };
}
