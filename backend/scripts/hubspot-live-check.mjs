#!/usr/bin/env node
// ENG-2464: record how a REAL HubSpot answers the contact edge cases the ENG-2171 push
// (hubspotAdapter.ts, updateContactsByStoredId / isContactGoneError) depends on and HubSpot's
// docs do not describe. Read-only on everything except throwaway probe contacts it creates
// and archives itself.
//
//   HUBSPOT_TOKEN=<private-app token> HUBSPOT_SANDBOX_CONFIRMED=yes \
//     node backend/scripts/hubspot-live-check.mjs [--out results.json]
//
// Use a HubSpot DEVELOPER TEST ACCOUNT (free; no customer data). The private app needs
// crm.objects.contacts.read/write. Every probe uses @eng2171.example.com addresses and
// firstname "ENG2171-probe"; nothing else in the portal is read, changed or deleted.
// The output is the raw status and body of each call: paste it into ENG-2464.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOMAIN = 'eng2171.example.com';
const NEVER_EXISTS = '999999999999';

// Mirrors HubspotAdapter.isContactGoneError. If experiment 3 or 4 is not classified "gone"
// here, that method is wrong for real HubSpot and must be changed.
export function classifyGone(status, body) {
  if (status === 404 || status === 410) return true;
  if (status !== 207) return false;
  const errs = body?.errors;
  return Array.isArray(errs) && errs.length > 0 && errs.every((e) => /NOT_FOUND/i.test(e?.category || ''));
}

export async function run({ base = 'https://api.hubapi.com', token, upsertGapMs = 10000, log = console.log }) {
  const results = [];
  const probeIds = new Set();

  async function api(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }
  const record = (id, title, req, res, note = '') => {
    const entry = { id, title, request: req, status: res.status, body: res.body, gone: classifyGone(res.status, res.body), note };
    results.push(entry);
    log(`\n[${id}] ${title}\n  ${req.method} ${req.path}${req.body ? ' ' + JSON.stringify(req.body) : ''}\n  -> ${res.status} ${JSON.stringify(res.body)}\n  classified "gone": ${entry.gone}${note ? '\n  ' + note : ''}`);
    return entry;
  };
  const call = async (id, title, method, path, body, note) => record(id, title, { method, path, body }, await api(method, path, body), note);
  const create = async (props) => {
    const r = await api('POST', '/crm/v3/objects/contacts', { properties: { firstname: 'ENG2171-probe', ...props } });
    if (r.status !== 201 || !r.body?.id) throw new Error(`setup: could not create probe contact (${r.status} ${JSON.stringify(r.body)})`);
    probeIds.add(r.body.id);
    return r.body.id;
  };
  const update = (id, properties) => ({ inputs: [{ id, properties }] });

  try {
    const acct = await api('GET', '/account-info/v3/details');
    log(`portal: ${JSON.stringify({ status: acct.status, portalId: acct.body?.portalId, accountType: acct.body?.accountType })}`);
    results.push({ id: 'account', status: acct.status, body: acct.body });
    // Self-asserted confirmation is not enough: refuse any portal HubSpot does not label as a test or
    // sandbox account (STANDARD is a real customer portal), before anything is created.
    if (acct.status !== 200 || !/DEVELOPER|SANDBOX|TEST/i.test(String(acct.body?.accountType))) {
      throw new Error(`refusing to run: account-info says status=${acct.status} accountType=${acct.body?.accountType} — this must be a HubSpot developer test or sandbox account`);
    }

    // ── setup ──
    const A = await create({ phone: '+15550100001' });
    const B = await create({ email: `b@${DOMAIN}` });
    const C = await create({ phone: '+15550100003' });
    const X = await create({ email: `x@${DOMAIN}` });
    const Y = await create({ email: `y@${DOMAIN}` });
    const D = await create({ email: `d@${DOMAIN}` });
    await api('DELETE', `/crm/v3/objects/contacts/${D}`);
    log(`probes: A=${A} B=${B} C=${C} X=${X} Y=${Y} D(archived)=${D}`);

    // 1. add an email to a phone-only contact by id (the ENG-2171 scenario)
    await call('E1', 'add an email to a phone-only contact by id', 'POST', '/crm/v3/objects/contacts/batch/update', update(A, { email: `a@${DOMAIN}` }));
    const readA = await call('E1b', 'read contact A back', 'GET', `/crm/v3/objects/contacts/${A}?properties=email,phone`);
    results[results.length - 1].note = `id unchanged and email set: ${readA.body?.id === A && readA.body?.properties?.email === `a@${DOMAIN}`}`;

    // 2. batch upsert by that email straight after, twice
    const up = { inputs: [{ idProperty: 'email', id: `a@${DOMAIN}`, properties: { email: `a@${DOMAIN}` } }] };
    const u1 = await call('E2a', 'upsert by the email just written (immediately)', 'POST', '/crm/v3/objects/contacts/batch/upsert', up);
    for (const r of u1.body?.results ?? []) probeIds.add(r.id);
    if (upsertGapMs) await new Promise((r) => setTimeout(r, upsertGapMs));
    const u2 = await call('E2b', `upsert again after ${upsertGapMs}ms`, 'POST', '/crm/v3/objects/contacts/batch/upsert', up);
    for (const r of u2.body?.results ?? []) probeIds.add(r.id);
    const sameId = (u1.body?.results ?? []).every((r) => r.id === A) && (u2.body?.results ?? []).every((r) => r.id === A);
    results[results.length - 1].note = `both upserts resolved to contact A (no second contact): ${sameId}`;

    // 3-4. a missing id, an archived id
    await call('E3', 'batch update: id that never existed', 'POST', '/crm/v3/objects/contacts/batch/update', update(NEVER_EXISTS, { firstname: 'ENG2171-probe' }));
    await call('E4', 'batch update: archived (deleted) contact id', 'POST', '/crm/v3/objects/contacts/batch/update', update(D, { firstname: 'ENG2171-probe' }));

    // 5. mixed batch: are the valid inputs applied when one fails?
    await call('E5', 'mixed batch: valid, missing, valid', 'POST', '/crm/v3/objects/contacts/batch/update', {
      inputs: [{ id: B, properties: { firstname: 'ENG2171-mixed' } }, { id: NEVER_EXISTS, properties: { firstname: 'ENG2171-mixed' } }, { id: C, properties: { firstname: 'ENG2171-mixed' } }],
    });
    const rb = await api('GET', `/crm/v3/objects/contacts/${B}?properties=firstname`);
    const rc = await api('GET', `/crm/v3/objects/contacts/${C}?properties=firstname`);
    results.push({ id: 'E5b', title: 'were the valid inputs of the mixed batch applied?', B: rb.body?.properties?.firstname, C: rc.body?.properties?.firstname });
    log(`\n[E5b] after the mixed batch: B.firstname=${rb.body?.properties?.firstname} C.firstname=${rc.body?.properties?.firstname}`);

    // 6. the same id twice in one batch
    await call('E6', 'duplicate id in one batch', 'POST', '/crm/v3/objects/contacts/batch/update', {
      inputs: [{ id: B, properties: { firstname: 'ENG2171-dup1' } }, { id: B, properties: { firstname: 'ENG2171-dup2' } }],
    });
    const rd = await api('GET', `/crm/v3/objects/contacts/${B}?properties=firstname`);
    log(`[E6b] B.firstname after the duplicate-id batch: ${rd.body?.properties?.firstname}`);
    results.push({ id: 'E6b', B: rd.body?.properties?.firstname });

    // 7. email owned by another contact
    await call('E7a', 'batch update: email owned by another contact', 'POST', '/crm/v3/objects/contacts/batch/update', update(C, { email: `b@${DOMAIN}` }));
    await call('E7b', 'single PATCH: email owned by another contact', 'PATCH', `/crm/v3/objects/contacts/${C}`, { properties: { email: `b@${DOMAIN}` } });

    // 8. a merged-away id
    await call('E8', 'merge X into Y', 'POST', '/crm/v3/objects/contacts/merge', { primaryObjectId: Y, objectIdToMerge: X });
    await call('E8a', 'GET the merged-away id', 'GET', `/crm/v3/objects/contacts/${X}`);
    await call('E8b', 'batch update the merged-away id', 'POST', '/crm/v3/objects/contacts/batch/update', update(X, { firstname: 'ENG2171-merged' }));
    await call('E8c', 'PATCH the merged-away id', 'PATCH', `/crm/v3/objects/contacts/${X}`, { properties: { firstname: 'ENG2171-merged' } });
    const ry = await api('GET', `/crm/v3/objects/contacts/${Y}?properties=firstname`);
    log(`[E8d] survivor Y.firstname: ${ry.body?.properties?.firstname}`);
    results.push({ id: 'E8d', Y: ry.body?.properties?.firstname });

    // 9. a whole-batch failure that is not a missing id
    await call('E9', 'valid id, unknown property', 'POST', '/crm/v3/objects/contacts/batch/update', update(B, { no_such_property_xyz: '1' }));
  } finally {
    const cleaned = [];
    for (const id of probeIds) {
      const r = await api('DELETE', `/crm/v3/objects/contacts/${id}`).catch((e) => ({ status: 0, body: String(e) }));
      cleaned.push({ id, status: r.status });
    }
    results.push({ id: 'cleanup', archived: cleaned });
    log(`\ncleanup (archived): ${JSON.stringify(cleaned)}`);
  }
  return results;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { console.error('HUBSPOT_TOKEN is required (private-app token of a HubSpot DEVELOPER TEST ACCOUNT).'); process.exit(2); }
  if (process.env.HUBSPOT_SANDBOX_CONFIRMED !== 'yes') {
    console.error('Refusing to run: set HUBSPOT_SANDBOX_CONFIRMED=yes to confirm this token belongs to a developer test account with no customer data.');
    process.exit(2);
  }
  const outIdx = process.argv.indexOf('--out');
  const results = await run({ token });
  if (outIdx !== -1 && process.argv[outIdx + 1]) writeFileSync(process.argv[outIdx + 1], JSON.stringify(results, null, 2));
}
