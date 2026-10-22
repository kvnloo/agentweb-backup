// Offline test for hubspot-live-check.mjs (ENG-2464) against a local in-memory HubSpot.
// Proves the SCRIPT works end to end (it classifies, records, cleans up and touches only its
// own probes). It says nothing about how the real HubSpot answers: that is what the script is for.
//   node --test backend/scripts/hubspot-live-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run, classifyGone } from './hubspot-live-check.mjs';

function startFake({ missing = '404', accountType = 'DEVELOPER_TEST' } = {}) {
  const contacts = new Map(); const archived = new Set(); let next = 5000;
  const calls = [];
  const byEmail = (e) => [...contacts.values()].find((c) => c.properties.email?.toLowerCase() === e.toLowerCase());
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const path = req.url.split('?')[0];
      calls.push(`${req.method} ${path}`);
      const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(b === undefined ? '' : JSON.stringify(b)); };
      if (req.headers.authorization !== 'Bearer tok') return send(401, {});
      if (path === '/account-info/v3/details') return send(200, { portalId: 1, accountType });
      if (req.method === 'POST' && path === '/crm/v3/objects/contacts') {
        // ENG-2635: the real HubSpot rejects reserved-TLD addresses such as *.invalid (INVALID_EMAIL), which
        // made the first probe impossible on a real portal while this fake accepted anything.
        if (/\.invalid$/i.test(String(body.properties.email || ''))) return send(400, { category: 'VALIDATION_ERROR', message: `Email address ${body.properties.email} is invalid` });
        const id = String(next++); contacts.set(id, { id, properties: { ...body.properties } }); return send(201, { id, properties: body.properties });
      }
      const one = path.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/);
      if (one) {
        const c = contacts.get(one[1]);
        if (req.method === 'DELETE') { archived.add(one[1]); contacts.delete(one[1]); return send(204); }
        if (!c) return send(404, { category: 'OBJECT_NOT_FOUND' });
        if (req.method === 'GET') return send(200, c);
        if (req.method === 'PATCH') {
          const e = body.properties.email; const clash = e && byEmail(e);
          if (clash && clash.id !== c.id) return send(409, { category: 'CONFLICT' });
          Object.assign(c.properties, body.properties); return send(200, c);
        }
      }
      if (path === '/crm/v3/objects/contacts/batch/update') {
        const errors = []; const ok = [];
        for (const i of body.inputs) {
          const c = contacts.get(String(i.id));
          if (!c) { if (missing === '404') return send(404, { category: 'OBJECT_NOT_FOUND' }); errors.push({ category: 'OBJECT_NOT_FOUND' }); continue; }
          if (i.properties.no_such_property_xyz) return send(400, { category: 'VALIDATION_ERROR' });
          const e = i.properties.email; const clash = e && byEmail(e);
          if (clash && clash.id !== c.id) return send(409, { category: 'CONFLICT' });
          ok.push([c, i.properties]);
        }
        for (const [c, p] of ok) Object.assign(c.properties, p);
        return errors.length ? send(207, { results: ok.map(([c]) => c), errors, numErrors: errors.length }) : send(200, { results: ok.map(([c]) => c) });
      }
      if (path === '/crm/v3/objects/contacts/batch/upsert') {
        return send(200, { results: body.inputs.map((i) => {
          const c = byEmail(i.id) || (() => { const id = String(next++); const n = { id, properties: { email: i.id } }; contacts.set(id, n); return n; })();
          return { id: c.id, properties: c.properties, new: false };
        }) });
      }
      if (path === '/crm/v3/objects/contacts/merge') { contacts.delete(body.objectIdToMerge); return send(200, contacts.get(body.primaryObjectId)); }
      return send(500, { message: `unhandled ${req.method} ${path}` });
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, contacts, archived, calls, base: `http://127.0.0.1:${server.address().port}` })));
}

test('classifyGone: 404/410 and all-NOT_FOUND 207 are gone; everything else is not', () => {
  assert.equal(classifyGone(404), true);
  assert.equal(classifyGone(410), true);
  assert.equal(classifyGone(207, { errors: [{ category: 'OBJECT_NOT_FOUND' }] }), true);
  assert.equal(classifyGone(207, { errors: [{ category: 'OBJECT_NOT_FOUND' }, { category: 'VALIDATION_ERROR' }] }), false);
  assert.equal(classifyGone(207, { errors: [] }), false);
  assert.equal(classifyGone(400, { category: 'VALIDATION_ERROR' }), false);
  assert.equal(classifyGone(409), false);
  assert.equal(classifyGone(200), false);
});

for (const missing of ['404', '207']) {
  test(`runs every experiment, records the raw status, and archives every probe it created (missing id answered as ${missing})`, async () => {
    const f = await startFake({ missing });
    // a pre-existing contact that is NOT a probe: the script must never touch it
    f.contacts.set('1', { id: '1', properties: { email: 'customer@real.example', firstname: 'Real' } });
    const out = [];
    try {
      const results = await run({ base: f.base, token: 'tok', upsertGapMs: 0, log: (l) => out.push(l) });
      const byId = Object.fromEntries(results.filter((r) => r.id).map((r) => [r.id, r]));
      for (const id of ['E1', 'E2a', 'E2b', 'E3', 'E4', 'E5', 'E6', 'E7a', 'E7b', 'E8', 'E8a', 'E8b', 'E8c', 'E9']) assert.ok(byId[id], `missing experiment ${id}`);
      assert.equal(byId.E3.status, missing === '404' ? 404 : 207);
      assert.equal(byId.E3.gone, true);
      assert.equal(byId.E7a.status, 409);
      assert.equal(byId.E7a.gone, false);
      assert.equal(byId.E9.status, 400);
      assert.match(byId.E2b.note, /true/);
      // cleanup: nothing the script created survives, and the real contact is untouched
      assert.deepEqual([...f.contacts.keys()], ['1']);
      assert.equal(f.contacts.get('1').properties.firstname, 'Real');
      assert.ok(!f.calls.some((c) => c.endsWith('/contacts/1')), 'script touched a contact it did not create');
      assert.ok(!out.join('\n').includes('tok'), 'token leaked into the output');
    } finally { f.server.close(); }
  });
}

test('still archives its probes when an experiment throws midway', async () => {
  const f = await startFake();
  try {
    const realFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (...a) => (String(a[0]).includes('batch/upsert') && ++n === 1 ? Promise.reject(new Error('boom')) : realFetch(...a));
    await assert.rejects(run({ base: f.base, token: 'tok', upsertGapMs: 0, log: () => {} }), /boom/);
    globalThis.fetch = realFetch;
    assert.equal(f.contacts.size, 0);
  } finally { f.server.close(); }
});

test('refuses a STANDARD (customer) portal before creating or changing anything', async () => {
  const f = await startFake({ accountType: 'STANDARD' });
  try {
    await assert.rejects(run({ base: f.base, token: 'tok', upsertGapMs: 0, log: () => {} }), /refusing to run/);
    assert.deepEqual(f.calls.filter((c) => c !== 'GET /account-info/v3/details' && !c.startsWith('DELETE')), []);
    assert.equal(f.contacts.size, 0);
  } finally { f.server.close(); }
});
