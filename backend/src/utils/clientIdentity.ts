/**
 * ENG-926 §B follow-up — decide whether the caller is the visitor or a forwarding server.
 *
 * Landing pages do not POST to `forward-lead` from the browser. They POST to their own
 * Next.js route, which then calls our API server-side from Vercel:
 *
 *   hireemma.ai       -> app/(frontend)/api/lead/route.ts -> forward-lead
 *   generated landers -> buildCaptureRoute's app/api/capture/route.ts -> forward-lead
 *
 * Neither forwards the visitor's IP or user agent, so `x-forwarded-for` / `req.ip` in this
 * handler resolve to Vercel's egress. A real end-to-end run stored `clientIp: 44.202.76.171`
 * (AWS) and `clientUserAgent: node` on a lead that came from an actual iPhone.
 *
 * A wrong IP is WORSE than no IP. Meta reads `client_ip_address` as a match signal, and a
 * datacenter address matches nobody — it dilutes Event Match Quality while looking like it
 * improves it. Storing nothing is the honest answer.
 *
 * The cost of getting this wrong is permanent, not merely stale: these attributes are
 * WRITE-ONCE (`if_not_exists`, see db.ts), so a lead that records the forwarder can never
 * have it replaced through updateLead.
 *
 * This guard can only ever REMOVE data it positively recognises as not-the-visitor. It never
 * invents a value, and it never accepts one from the request body — `forward-lead` is public,
 * CORS-open and unauthenticated, so a body-supplied IP would be trivially spoofable.
 */

/**
 * Anchored patterns, not substring matches. A browser UA is a long string containing many
 * words; a loose `includes('java')` would swallow real traffic advertising JavaFX, and
 * `includes('go-')` would match plenty of nothing in particular.
 */
const SERVER_SIDE_AGENT_PATTERNS: readonly RegExp[] = [
  /^node(?:[./\s-]|$)/i,        // 'node', 'node-fetch/2.6.7', 'Node.js'
  /^undici(?:[./\s]|$)/i,
  /^axios(?:[./\s]|$)/i,
  /^got(?:[./\s(]|$)/i,
  /^python-requests(?:[./\s]|$)/i,
  /^go-http-client(?:[./\s]|$)/i,
  /^curl(?:[./\s]|$)/i,
  /^okhttp(?:[./\s]|$)/i,
  /^java(?:[./\s]|$)/i,
  /^postmanruntime(?:[./\s]|$)/i,
  /^next\.js(?:[./\s]|$)/i,
  /^vercel(?:[./\s]|$)/i,
  /^aws-sdk(?:[./\s]|$)/i,
  /^guzzlehttp(?:[./\s]|$)/i,
];

/**
 * Is this user agent a server-side HTTP client rather than a browser?
 *
 * A MISSING or blank agent counts as server-side. Every real browser sends one, so its
 * absence on this route means the caller is not a browser — and therefore the IP that
 * arrived with it belongs to that caller, not to a visitor. Failing closed here costs at
 * most a match signal we never legitimately had; failing open records a wrong one forever.
 */
export function isServerSideUserAgent(userAgent: unknown): boolean {
  if (typeof userAgent !== 'string') return true;
  const ua = userAgent.trim();
  if (!ua) return true;
  return SERVER_SIDE_AGENT_PATTERNS.some((re) => re.test(ua));
}

export interface ClientIdentity {
  clientIp?: string;
  clientUserAgent?: string;
}

/**
 * Resolve the visitor's IP and user agent, or nothing at all.
 *
 * Both are dropped together when the caller is a forwarding server. Dropping only the user
 * agent would leave the damaging half in place — the IP is the actual match signal — while
 * making the row look repaired.
 *
 * Returns `{}` rather than undefined so callers can always spread the result.
 */
export function resolveClientIdentity(
  userAgent: unknown,
  ip: unknown,
): ClientIdentity {
  if (isServerSideUserAgent(userAgent)) return {};

  const out: ClientIdentity = { clientUserAgent: (userAgent as string).trim() };

  const addr = typeof ip === 'string' ? ip.trim() : '';
  // 'unknown' is the sentinel the CAPI call falls back to when nothing resolved. It is a
  // placeholder for a missing value, never something to persist as one.
  if (addr && addr.toLowerCase() !== 'unknown') out.clientIp = addr;

  return out;
}
