/**
 * ENG-2840 (W2-10): the argument checks (and two small answer helpers) shared by the MCP tools `search_user_assets` and `inspect_linkedin_account`
 * (mcp/server/assetAndOutreachAccountTools.ts) and the /api/emma routes behind them (routes/emmaAssetRoutes.ts). The tool checks first
 * (a refusal calls nothing); the route checks the same body again, so a direct caller of the route gets the same answer.
 *
 * Known names only (an identity field is refused by name like any other unknown name), then every value: null counts as absent.
 */

export type ArgCheck = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/** What each route (and each MCP tool) takes. */
export const ROUTE_INPUTS = {
  search_user_assets: ['type', 'query', 'favorites_only', 'approved_only', 'limit'],
  inspect_linkedin_account: ['account_id'],
} as const;
export type AssetTool = keyof typeof ROUTE_INPUTS;

/** Emma's own `type` enum (emma/tools.ts search_user_assets). */
export const ASSET_TYPES = ['images', 'videos', 'htmlReports', 'all'] as const;
export const MAX_QUERY_CHARS = 100;
export const MAX_ASSET_LIMIT = 100;
export const DEFAULT_ASSET_LIMIT = 50;
/** A Unipile account id as AgentWeb stores it: letters, digits, - and _ only. */
export const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Control, line-separator, zero-width and bidirectional characters: never part of a search word an agent means.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

const absent = (value: unknown) => value === undefined || value === null;

function bool(b: Record<string, unknown>, key: string, out: Record<string, unknown>): string | null {
  if (absent(b[key])) return null;
  if (typeof b[key] !== 'boolean') return `${key} must be true or false`;
  out[key] = b[key];
  return null;
}

/** The body of one route (or the arguments of one MCP tool): known names only, every value checked. */
export function checkArgs(tool: AssetTool, body: unknown): ArgCheck {
  if (absent(body)) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'the arguments must be an object' };
  const b = body as Record<string, unknown>;
  const inputs: readonly string[] = ROUTE_INPUTS[tool];
  const unknown = Object.keys(b).filter((key) => !inputs.includes(key));
  if (unknown.length > 0) return { ok: false, error: `${unknown.map((k) => `"${k.slice(0, 40)}"`).join(', ')} ${unknown.length > 1 ? 'are not inputs' : 'is not an input'}. The inputs are: ${inputs.join(', ')}` };
  const out: Record<string, unknown> = {};
  let error: string | null = null;
  switch (tool) {
    case 'search_user_assets': {
      if (!absent(b.type)) {
        if (!(ASSET_TYPES as readonly unknown[]).includes(b.type)) { error = `type must be one of ${ASSET_TYPES.join(', ')}`; break; }
        out.type = b.type;
      }
      if (!absent(b.query)) {
        const q = b.query;
        if (typeof q !== 'string' || q.length > MAX_QUERY_CHARS || UNSAFE_TEXT_RE.test(q)) {
          error = `query must be text of at most ${MAX_QUERY_CHARS} characters, without control or invisible characters`;
          break;
        }
        // An empty or blank query filters nothing, as in Emma.
        if (q.trim() !== '') out.query = q.trim();
      }
      error = bool(b, 'favorites_only', out) ?? bool(b, 'approved_only', out);
      if (error) break;
      if (absent(b.limit)) {
        out.limit = DEFAULT_ASSET_LIMIT;
      } else if (typeof b.limit === 'number' && Number.isInteger(b.limit) && b.limit >= 1 && b.limit <= MAX_ASSET_LIMIT) {
        out.limit = b.limit;
      } else {
        error = `limit must be a whole number from 1 to ${MAX_ASSET_LIMIT}`;
      }
      break;
    }
    case 'inspect_linkedin_account': {
      if (absent(b.account_id)) break;
      // Never echo the value: it may be anything an agent was given.
      if (typeof b.account_id !== 'string' || !ACCOUNT_ID_RE.test(b.account_id)) {
        error = 'account_id must be the id of one of your LinkedIn Outreach accounts, as this tool lists it (1 to 64 letters, digits, - or _)';
        break;
      }
      out.account_id = b.account_id;
      break;
    }
  }
  return error ? { ok: false, error } : { ok: true, args: out };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── answers

export const MAX_URL_CHARS = 2048;
// An http(s) link with no whitespace, control or invisible characters; anything else is left out of an answer.
const URL_RE = /^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+$/i;

/** Text (or a finite number, as text) cut to `max` characters; anything else is left out. */
export function cut(value: unknown, max: number): string | undefined {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return undefined;
  return text.length > max ? `${text.slice(0, max)}… [cut at ${max} characters]` : text;
}

/** An http(s) link of at most MAX_URL_CHARS characters, or nothing. */
export function linkOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_URL_CHARS && URL_RE.test(value) ? value : undefined;
}
