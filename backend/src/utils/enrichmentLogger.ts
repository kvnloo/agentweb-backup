/**
 * Structured logger for the CRM enrichment pipeline.
 *
 * Emits one JSON object per call so logs are aggregable in CloudWatch / Loki.
 * In development (NODE_ENV !== 'production'), pretty-prints for readability.
 *
 * Convention: every log call carries a stable `event` slug (e.g. "lead.start",
 * "llm.complete", "cache.hit") and a context bag of structured fields.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  event: string;
  jobId?: string;
  leadId?: string;
  step?: string;
  ms?: number;
  ok?: boolean;
  [key: string]: unknown;
}

const isProd = process.env.NODE_ENV === 'production';

function emit(level: Level, fields: LogFields, message?: string): void {
  const record = {
    level,
    ts: new Date().toISOString(),
    component: 'crm-enrichment',
    ...fields,
    ...(message ? { msg: message } : {}),
  };
  if (isProd) {
    // single-line JSON for log aggregators
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } else {
    // pretty print in dev
    const tag = `[crm-enrichment][${fields.event}]`;
    const rest = { ...fields };
    delete (rest as any).event;
    if (level === 'error') console.error(tag, message ?? '', rest);
    else if (level === 'warn') console.warn(tag, message ?? '', rest);
    else console.log(tag, message ?? '', rest);
  }
}

export const enrichLog = {
  debug: (fields: LogFields, msg?: string) => emit('debug', fields, msg),
  info: (fields: LogFields, msg?: string) => emit('info', fields, msg),
  warn: (fields: LogFields, msg?: string) => emit('warn', fields, msg),
  error: (fields: LogFields, msg?: string) => emit('error', fields, msg),
};

/** Time a synchronous-ish span and log on completion. */
export async function timed<T>(
  fields: LogFields,
  fn: () => Promise<T>
): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    enrichLog.info({ ...fields, ms: Date.now() - t0, ok: true });
    return r;
  } catch (err: any) {
    enrichLog.error({ ...fields, ms: Date.now() - t0, ok: false, error: err?.message }, 'span failed');
    throw err;
  }
}
