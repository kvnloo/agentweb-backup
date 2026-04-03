import Jexl from 'jexl';

const jexl = new Jexl.Jexl();

// Register custom functions
jexl.addFunction('contains', (str: any, sub: any): boolean => {
  if (str == null || sub == null) return false;
  return String(str).includes(String(sub));
});

jexl.addFunction('startsWith', (str: any, prefix: any): boolean => {
  if (str == null || prefix == null) return false;
  return String(str).startsWith(String(prefix));
});

jexl.addFunction('endsWith', (str: any, suffix: any): boolean => {
  if (str == null || suffix == null) return false;
  return String(str).endsWith(String(suffix));
});

jexl.addFunction('concat', (...args: any[]): string => {
  return args.map((a) => (a == null ? '' : String(a))).join('');
});

jexl.addFunction('substring', (str: any, start: number, end?: number): string => {
  if (str == null) return '';
  const s = String(str);
  return end !== undefined ? s.substring(start, end) : s.substring(start);
});

jexl.addFunction('regex', (str: any, pattern: string): boolean => {
  if (str == null || pattern == null) return false;
  try {
    return new RegExp(pattern).test(String(str));
  } catch {
    return false;
  }
});

jexl.addFunction('lower', (str: any): string => {
  if (str == null) return '';
  return String(str).toLowerCase();
});

jexl.addFunction('upper', (str: any): string => {
  if (str == null) return '';
  return String(str).toUpperCase();
});

jexl.addFunction('trim', (str: any): string => {
  if (str == null) return '';
  return String(str).trim();
});

jexl.addFunction('len', (str: any): number => {
  if (str == null) return 0;
  return String(str).length;
});

jexl.addFunction('isEmpty', (val: any): boolean => {
  if (val == null) return true;
  if (typeof val === 'string') return val.length === 0;
  return false;
});

jexl.addFunction('isNotEmpty', (val: any): boolean => {
  if (val == null) return false;
  if (typeof val === 'string') return val.length > 0;
  return true;
});

/**
 * Build the evaluation context from a lead and optional previous lead state.
 * All top-level lead fields are available directly (e.g. `email`, `status`).
 * The previous lead state (for lead.updated) is available as `prev`.
 */
export function buildContext(
  lead: Record<string, any>,
  prevLead?: Record<string, any>
): Record<string, any> {
  const ctx: Record<string, any> = { ...lead };
  if (prevLead) {
    ctx.prev = { ...prevLead };
  } else {
    ctx.prev = {};
  }
  return ctx;
}

/**
 * Evaluate a jexl condition expression against a lead.
 * Returns false on any parse/runtime error (safe default — never throws).
 */
export async function evaluateExpression(
  expr: string,
  lead: Record<string, any>,
  prevLead?: Record<string, any>
): Promise<boolean> {
  if (!expr || expr.trim() === '') return false;
  try {
    const context = buildContext(lead, prevLead);
    const result = await jexl.eval(expr, context);
    return result === true || result === 1;
  } catch {
    return false;
  }
}

/**
 * Validate a jexl expression for syntax errors without evaluating against real data.
 * Uses a dummy context to attempt evaluation.
 */
export async function validateExpression(
  expr: string
): Promise<{ valid: boolean; error?: string }> {
  if (!expr || expr.trim() === '') {
    return { valid: false, error: 'Expression cannot be empty' };
  }
  try {
    // compile() checks syntax without evaluating
    jexl.compile(expr);
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err?.message || 'Invalid expression' };
  }
}
