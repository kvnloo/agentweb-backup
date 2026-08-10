// Tests for same-origin API routing in preview/proxy.mjs. The SPA is served on the portal ports
// (5174 customer / 5173 partner) but its API + websocket traffic must reach this bug's BACKEND, so the
// proxy routes /api* and /socket.io* on a portal port to the '-api' route. This is what makes the ?k=
// gate work for API calls (same-origin request carries the gate cookie; a cross-origin :3001 call was
// 401'd because its CORS preflight has no cookie). proxy.mjs self-starts its listeners on import, so
// (per this repo's convention) we keep a FAITHFUL COPY of apiSuffixFor here. Run:
//   node test/preview-api-routing.test.mjs
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// ── Faithful copy of preview/proxy.mjs apiSuffixFor (keep in sync) ──
function apiSuffixFor(url, suffix) {
  const pathname = String(url || '/').split('?')[0];
  const isBackend = pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/socket.io');
  return isBackend ? '-api' : suffix;
}

console.log('preview same-origin API routing');

// On the CUSTOMER port (suffix '') backend paths route to the api route, app paths stay on the portal.
ok(apiSuffixFor('/api/auth/login', '') === '-api', 'customer: /api/auth/login → backend (-api)');
ok(apiSuffixFor('/api', '') === '-api', 'customer: bare /api → backend (-api)');
ok(apiSuffixFor('/api/tasks?limit=20', '') === '-api', 'customer: /api with query → backend (-api)');
ok(apiSuffixFor('/socket.io/?EIO=4&transport=polling', '') === '-api', 'customer: /socket.io → backend (-api)');
ok(apiSuffixFor('/', '') === '', 'customer: / stays on the portal');
ok(apiSuffixFor('/login?redirectUrl=%2F', '') === '', 'customer: SPA route /login stays on the portal');
ok(apiSuffixFor('/assets/index-abc.js', '') === '', 'customer: static asset stays on the portal');

// On the PARTNER port (suffix '-admin') the same split applies — one shared backend for both portals.
ok(apiSuffixFor('/api/admin/users', '-admin') === '-api', 'partner: /api → backend (-api), not -admin');
ok(apiSuffixFor('/dashboard', '-admin') === '-admin', 'partner: app route stays on the partner portal');

// The api listener (suffix '-api') is unaffected — backend paths stay -api, and it only ever sees them.
ok(apiSuffixFor('/api/auth/login', '-api') === '-api', 'api listener: /api stays -api');

// Guard against a path that merely CONTAINS "api" but is a portal route (e.g. /api-docs page).
ok(apiSuffixFor('/apidocs', '') === '', 'lookalike /apidocs is NOT treated as backend');
ok(apiSuffixFor('/api-docs', '') === '', 'lookalike /api-docs is NOT treated as backend');

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
