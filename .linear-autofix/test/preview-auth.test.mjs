// Tests for the preview proxy's shared-secret gate (ENG-920).
//
// Why this exists: the preview ports (5173/5174/3001) are internet-exposed on the runner and the
// backend behind them holds live dev AWS credentials. preview.mjs binds every real server to
// 127.0.0.1, so proxy.mjs is the only listener — decideAccess() is therefore the single thing
// standing between the internet and a dev-credentialed app. It has to be right in six ways at once:
// deny by default, grant on ?k, remember via cookie, never trust a wrong token, never break the
// on-box Playwright verify step, and fail CLOSED (not open) when the env var is missing.
//
// Run: node test/preview-auth.test.mjs
import {
  decideAccess, cookieValue, cookieDomain, buildSetCookie, stripToken,
  parseCookies, isPrivateAddr, isSelfAddr, normalizeIp, safeEqual, COOKIE_NAME,
} from '../preview/auth.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const SECRET = 's3cret-preview-token';
const HOST = 'eng-920.54.148.185.209.nip.io:5174';
const PUBLIC = '203.0.113.7';                       // an off-box caller (TEST-NET-3)
const SELF = ['172.31.31.5', '127.0.0.1', '54.148.185.209'];

const call = (o) => decideAccess({ secret: SECRET, url: '/', host: HOST, remoteAddress: PUBLIC, selfIps: SELF, ...o });

console.log('no token supplied → 401');
{
  const d = call({});
  ok(d.action === 'deny' && d.status === 401, 'public request with no token/cookie → 401');
  ok(d.reason === 'no-token', 'reason is no-token');
  // The 401 must be identical whether or not the bug exists: decideAccess never sees routes.json,
  // and proxy.mjs runs the gate BEFORE the route lookup that would 502 "no preview route for X".
  const real = call({ url: '/dashboard', host: 'eng-1.54.148.185.209.nip.io:5174' });
  const bogus = call({ url: '/dashboard', host: 'nope-9999.54.148.185.209.nip.io:5174' });
  ok(JSON.stringify(real) === JSON.stringify(bogus), 'identical denial for existing vs non-existent bug id (no existence leak)');
}

console.log('\ncorrect ?k= → sets cookie + redirects');
{
  const d = call({ url: `/dashboard?tab=leads&k=${encodeURIComponent(SECRET)}` });
  ok(d.action === 'grant', 'correct token → grant');
  ok(d.location === '/dashboard?tab=leads', 'redirects to the same URL without ?k (token leaves the address bar)');
  const c = d.setCookie;
  ok(c.startsWith(`${COOKIE_NAME}=${cookieValue(SECRET)}`), 'cookie carries the HMAC, not the raw token');
  ok(!c.includes(SECRET), 'raw token never appears in the Set-Cookie header');
  ok(/HttpOnly/.test(c) && /SameSite=Lax/.test(c) && /Path=\//.test(c), 'HttpOnly + SameSite=Lax + Path=/');
  ok(/Max-Age=2592000/.test(c), 'Max-Age ~30d');
  ok(/Domain=54\.148\.185\.209\.nip\.io/.test(c), 'Domain is the shared <ip>.nip.io parent, so one grant covers every bug + port');
  // A ?k with no other params must not leave a bare "?" behind.
  ok(call({ url: `/?k=${SECRET}` }).location === '/', 'lone ?k strips cleanly to /');
}

console.log('\nvalid cookie → passes');
{
  const d = call({ cookieHeader: `foo=1; ${COOKIE_NAME}=${cookieValue(SECRET)}; bar=2` });
  ok(d.action === 'allow' && d.reason === 'cookie', 'valid signed cookie among others → allow');
  ok(call({ cookieHeader: `${COOKIE_NAME}=${cookieValue(SECRET)}`, url: '/anything?x=1' }).action === 'allow',
    'cookie works on any path, no redirect loop');
}

console.log('\nwrong token → 401');
{
  ok(call({ url: '/?k=wrong' }).action === 'deny', 'wrong ?k → 401');
  ok(call({ url: `/?k=${SECRET}x` }).action === 'deny', 'token with an extra char → 401 (no prefix match)');
  ok(call({ url: `/?k=${SECRET.slice(0, -1)}` }).action === 'deny', 'truncated token → 401');
  ok(call({ url: '/?k=' }).action === 'deny', 'empty ?k → 401 (never matches an empty-ish secret)');
  ok(call({ cookieHeader: `${COOKIE_NAME}=deadbeef` }).action === 'deny', 'forged cookie → 401');
  ok(call({ cookieHeader: `${COOKIE_NAME}=${SECRET}` }).action === 'deny', 'raw token pasted as the cookie value → 401 (cookie must be the HMAC)');
  ok(safeEqual(SECRET, SECRET) && !safeEqual(SECRET, 'x'), 'safeEqual compares by digest (length-agnostic, constant time)');
}

console.log('\nloopback / private ranges → allowed without a token');
{
  const priv = ['127.0.0.1', '::ffff:127.0.0.1', '::1', '10.0.0.4', '172.16.0.1', '172.31.31.5', '192.168.29.76'];
  for (const ip of priv) {
    ok(decideAccess({ secret: SECRET, url: '/', host: HOST, remoteAddress: ip, selfIps: SELF }).action === 'allow',
      `${ip} → allowed without a token (keeps on-box Playwright verify working)`);
  }
  ok(!isPrivateAddr('172.32.0.1') && !isPrivateAddr('172.15.0.1'), '172.16/12 boundaries: .15 and .32 are public');
  ok(!isPrivateAddr('11.0.0.1') && !isPrivateAddr('192.169.0.1'), 'near-miss public ranges are not private');
  ok(!isPrivateAddr('1270.0.0.1') && !isPrivateAddr('') && !isPrivateAddr('example.com'), 'garbage is never private');
  ok(normalizeIp('::ffff:10.1.2.3') === '10.1.2.3' && normalizeIp('fe80::1%eth0') === 'fe80::1', 'normalizeIp unwraps v4-mapped + zone ids');
  // The instance's own PUBLIC ip: on-box requests to the nip.io URL hairpin through the IGW and
  // arrive SNAT'd to it. Off-box callers can't forge that (they couldn't complete the handshake).
  ok(decideAccess({ secret: SECRET, url: '/', host: HOST, remoteAddress: '54.148.185.209', selfIps: SELF }).reason === 'self',
    "the box's own public IP (IGW hairpin) → allowed");
  ok(!isSelfAddr(PUBLIC, SELF), 'an unrelated public IP is not self');
  // X-Forwarded-For must never be consulted — the proxy IS the edge, so it would be attacker-supplied.
  const spoof = decideAccess({
    secret: SECRET, url: '/', host: HOST, remoteAddress: PUBLIC, selfIps: SELF,
    headers: { 'x-forwarded-for': '127.0.0.1' }, xff: '127.0.0.1',
  });
  ok(spoof.action === 'deny', 'a spoofed X-Forwarded-For: 127.0.0.1 does NOT bypass the gate');
}

console.log('\nPREVIEW_ACCESS_TOKEN unset → fail CLOSED (private allowed, public refused)');
{
  for (const secret of ['', undefined, null]) {
    const pub = decideAccess({ secret, url: '/', host: HOST, remoteAddress: PUBLIC, selfIps: SELF });
    ok(pub.action === 'deny' && pub.reason === 'unconfigured', `secret=${JSON.stringify(secret)} → public refused (never silently open)`);
    ok(decideAccess({ secret, url: '/', host: HOST, remoteAddress: '127.0.0.1', selfIps: SELF }).action === 'allow',
      `secret=${JSON.stringify(secret)} → loopback still allowed (missing env var can't brick the box)`);
  }
  // ...and no ?k / cookie can talk its way past a missing secret.
  ok(decideAccess({ secret: '', url: '/?k=', host: HOST, remoteAddress: PUBLIC, selfIps: SELF }).action === 'deny',
    'empty ?k against an unset secret → still refused');
  ok(decideAccess({ secret: '', cookieHeader: `${COOKIE_NAME}=${cookieValue('')}`, url: '/', host: HOST, remoteAddress: PUBLIC, selfIps: SELF }).action === 'deny',
    'cookie signed with the empty secret → still refused');
}

console.log('\nhelpers');
{
  ok(cookieDomain('eng-1.54.1.2.3.nip.io:5174') === '54.1.2.3.nip.io', 'cookieDomain drops the bug label for nip.io hosts');
  ok(cookieDomain('54.1.2.3.nip.io') === null, 'bare <ip>.nip.io gets a host-scoped cookie');
  ok(cookieDomain('eng-1.54-1-2-3.nip.io:5174') === '54-1-2-3.nip.io', "nip.io's dashed form works too");
  ok(cookieDomain('localhost:5174') === null && cookieDomain('evil.com') === null, 'non-nip.io hosts never get a Domain attribute');
  ok(cookieDomain('eng-1.54.1.2.3.nip.io.evil.com') === null, 'a nip.io-looking prefix on someone else\'s domain gets no Domain');
  ok(!buildSetCookie(SECRET, 'localhost:5174').includes('Domain='), 'host-scoped cookie omits Domain entirely');
  ok(parseCookies('a=1; b=2; broken')?.a === '1' && parseCookies('')?.a === undefined, 'parseCookies tolerates junk');
  ok(stripToken('/a?b=1&k=x&c=2') === '/a?b=1&c=2', 'stripToken keeps the other params');
  ok(cookieValue(SECRET) !== cookieValue(SECRET + '!') && cookieValue(SECRET) === cookieValue(SECRET), 'cookieValue is a stable, secret-bound HMAC');
}

console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
