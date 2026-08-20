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

import { isIP } from 'net';

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

/**
 * ENG-926 §B — accept the visitor's identity from the one caller that actually knows it.
 *
 * The guard above is right and stays: an IP resolved from the REQUEST belongs to whoever made
 * the request, and for a landing-page lead that is Vercel. But refusing it left lander leads
 * carrying NEITHER `client_ip_address` nor `client_user_agent`, both named in the card's §B as
 * signals that materially improve Event Match Quality. Storing nothing was honest; it was still
 * a gap.
 *
 * The visitor's real IP and user agent exist in exactly one place — the site's own Next.js
 * capture route, which the browser posts to directly. So the forwarder declares them, and this
 * is the narrow path that accepts a declaration.
 *
 * ⚠ THIS IS NOT "TRUST THE BODY". `forward-lead` is public, CORS-open and unauthenticated, so a
 * declaration is accepted only when all three hold:
 *
 *   1. the CALLER is already recognised as a forwarding server. A direct browser caller can
 *      never override its own identity, or any visitor could launder an arbitrary IP through a
 *      public endpoint by simply claiming one.
 *   2. the DECLARED user agent is itself a browser. A forwarder declaring `node` is describing
 *      ITSELF — the original bug arriving through the new door — so the whole declaration is
 *      refused rather than half-accepted.
 *   3. the DECLARED IP is a syntactically valid PUBLIC address. Private, loopback, link-local,
 *      CGNAT, multicast and reserved addresses cannot be a visitor's public IP and match nobody
 *      at Meta, which is the same "a wrong IP is worse than no IP" rule applied to a declared
 *      value instead of an observed one.
 *
 * ⚠ Stated plainly rather than implied: **this does not make the value trustworthy against a
 * determined attacker.** Anyone can already POST an arbitrary lead here with a fake email and
 * fake attribution, so declaring a fake IP alongside them is not a new capability, and
 * `if_not_exists` in db.ts means an EXISTING lead's identity can never be overwritten. What the
 * validation buys is correctness for real traffic: it stops a forwarder from mistakenly
 * declaring its own datacenter identity, which is the precise failure the guard above exists for.
 */
/**
 * ⚠ ONE-LINE KILL SWITCH, and the reason it exists is COMPLIANCE, not correctness.
 *
 * Accepting a declaration widens the population whose IP we store from "leads that posted to
 * us from a browser" to "every landing-page lead" — a materially larger set. It is not a new
 * data CLASS (the browser leg has stored IPs since ENG-926 §B's first half), but GDPR
 * requires consent BEFORE collection, and §B's `marketingConsent` field is still unbuilt and
 * blocked on a business decision about which customers and which regions.
 *
 * That decision is not engineering's to make, so the whole behaviour sits behind one constant:
 * flip this to `false` and lander leads immediately go back to storing nothing, with no code
 * archaeology and no revert. Same pattern this codebase already uses for LDU.
 */
export const ACCEPT_DECLARED_CLIENT_IDENTITY = true;

export interface ForwardedClientIdentity {
  clientIp?: unknown;
  clientUserAgent?: unknown;
}

/** Reject every IPv4 range that cannot be a visitor's public address. */
function isPublicIpv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const o = parts.map((p) => Number(p));
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  if (o[0] === 0) return false;                              // "this network"
  if (o[0] === 10) return false;                             // private 10/8
  if (o[0] === 127) return false;                            // loopback — what req.ip is today
  if (o[0] === 169 && o[1] === 254) return false;            // link-local / cloud metadata
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false; // private 172.16/12 — the ALB range
  if (o[0] === 192 && o[1] === 168) return false;            // private 192.168/16
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false; // CGNAT 100.64/10
  if (o[0] >= 224) return false;                             // multicast, reserved, broadcast
  if (o[0] === 192 && o[1] === 0 && o[2] === 0) return false; // IETF protocol assignments
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return false; // benchmarking 198.18/15
  // Documentation ranges. Non-routable, so they cannot describe a real visitor either.
  if (o[0] === 192 && o[1] === 0 && o[2] === 2) return false;      // TEST-NET-1
  if (o[0] === 198 && o[1] === 51 && o[2] === 100) return false;   // TEST-NET-2
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return false;    // TEST-NET-3

  return true;
}

/**
 * Expand any valid IPv6 spelling into its eight 16-bit hextets, or null if it is not one.
 *
 * ⚠ TEXT MATCHING ON IPv6 IS NOT SUFFICIENT, and the first version of this file got it wrong.
 * `::ffff:127.0.0.1`, `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:1` are all THE SAME loopback
 * address. A regex that recognised only the compressed dotted spelling let the other two
 * through as "valid global IPv6" — so a declared `client_ip_address` of loopback would have
 * been accepted and sent to Meta. Found by CodeRabbit on #2513, after it had already shipped.
 *
 * Handles `::` compression and a trailing dotted-quad, which is the only form where an IPv6
 * address legitimately contains IPv4 notation.
 */
function ipv6Hextets(lower: string): number[] | null {
  const addr = lower.split('%')[0]; // drop any zone id
  let text = addr;

  // A trailing dotted quad occupies the last TWO hextets. Convert it so the rest of the
  // parser only ever deals with hex groups.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text =
      text.slice(0, dotted.index) +
      (((o[0] << 8) | o[1]) >>> 0).toString(16) +
      ':' +
      (((o[2] << 8) | o[3]) >>> 0).toString(16);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter((g) => g !== '') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter((g) => g !== '') : [];

  let groups: string[];
  if (halves.length === 1) {
    groups = left;
  } else {
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  }
  if (groups.length !== 8) return null;

  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some((n) => Number.isNaN(n)) ? null : out;
}

/**
 * Is this IPv6 address publicly routable?
 *
 * ⚠ AN ALLOWLIST (`2000::/3`, global unicast), NOT A DENY LIST. The original deny-listed
 * fc00::/7, fe80::/10, multicast and a few others — which meant every range nobody had thought
 * of defaulted to ACCEPTED. `4000::1` is reserved and sailed through. Requiring global unicast
 * inverts that: anything unrecognised is rejected, which is the correct direction for a value
 * we persist write-once and send to Meta as a match signal.
 *
 * Global unicast still contains one range worth excluding: 2001:db8::/32, documentation.
 */
function isPublicIpv6(hextets: number[]): boolean {
  // IPv4-mapped in ANY spelling — judge what it actually contains.
  if (
    hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 &&
    hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0xffff
  ) {
    const v4 = `${(hextets[6] >> 8) & 255}.${hextets[6] & 255}.${(hextets[7] >> 8) & 255}.${hextets[7] & 255}`;
    return isPublicIpv4(v4);
  }

  if (hextets[0] < 0x2000 || hextets[0] > 0x3fff) return false; // not global unicast
  if (hextets[0] === 0x2001 && hextets[1] === 0x0db8) return false; // documentation
  return true;
}

/**
 * Is this a syntactically valid, publicly routable IP address?
 *
 * Uses Node's own `net.isIP` for the shape rather than a hand-rolled regex — an address is
 * exactly the kind of grammar where a regex looks right and is subtly wrong, and this value
 * is attacker-supplied.
 */
export function isPublicIpAddress(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw) return false;

  const kind = isIP(raw);
  if (kind === 4) return isPublicIpv4(raw);
  if (kind !== 6) return false;

  const hextets = ipv6Hextets(raw.toLowerCase());
  if (!hextets) return false;
  return isPublicIpv6(hextets);
}

/**
 * Resolve the visitor's identity, allowing a recognised forwarder to declare it.
 *
 * Falls back to {@link resolveClientIdentity} exactly when there is nothing to declare, so the
 * observed-caller behaviour is unchanged and this is purely additive.
 */
export function resolveClientIdentityWithForwarded(
  userAgent: unknown,
  ip: unknown,
  declared?: ForwardedClientIdentity,
): ClientIdentity {
  // A caller we can observe directly never gets to describe itself.
  if (!isServerSideUserAgent(userAgent)) return resolveClientIdentity(userAgent, ip);

  // Compliance kill switch — see the constant. Off means we behave exactly as before.
  if (!ACCEPT_DECLARED_CLIENT_IDENTITY) return {};

  // The caller is a forwarder, so its own IP and agent are its own — already refused above.
  // The only identity worth having is one it explicitly declares for the visitor.
  const declaredUa =
    typeof declared?.clientUserAgent === 'string' ? declared.clientUserAgent.trim() : '';
  // Refuse the WHOLE declaration, not just the agent: if the forwarder is describing itself,
  // its IP is its own too, and keeping that half is the bug this module exists to prevent.
  if (!declaredUa || isServerSideUserAgent(declaredUa)) return {};

  const out: ClientIdentity = { clientUserAgent: declaredUa };
  const declaredIp = typeof declared?.clientIp === 'string' ? declared.clientIp.trim() : '';
  // An unusable IP is simply absent. It NEVER falls back to the forwarder's own address.
  if (isPublicIpAddress(declaredIp)) out.clientIp = declaredIp;
  return out;
}
