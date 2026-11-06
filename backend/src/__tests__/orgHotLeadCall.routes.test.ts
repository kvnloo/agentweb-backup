import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() } }));
jest.mock('../services/usageRecorderService', () => ({ recordVendorUsage: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: { getChatSession: jest.fn(), claimMetaWriteManifestDigest: jest.fn() } }));
import { orgDb, userDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';
import routes from '../routes/orgHotLeadCall';
import { hotLeadCallRevisionOf } from '../services/hotLeadCallSettingsService';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { FakeVoiceProvider } from './helpers/fakeVoiceProvider';
import { installFakeOrgTable, type FakeOrgTable } from './helpers/fakeOrgTable';
import { EVERY_DAY, storedConfigFixture, teamMember } from './helpers/hotLeadCallFixtures';
import { spokenCode } from './helpers/spokenCode';

const A = 'maaaaaaa';
const B = 'mbbbbbbb';
const BASE = '/api/orgs/me/hot-lead-call';
const WEEKDAYS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

const stored = (extra: Record<string, unknown> = {}) => storedConfigFixture({ enabled: false, ...extra }, [
  teamMember('+14155550100'), teamMember('+14155550122', { id: B, name: 'Sam Ortiz', verifiedAt: undefined, windows: [WEEKDAYS] }),
]);

let table: FakeOrgTable;
let fake: FakeVoiceProvider;
let role: string | undefined;

function makeApp(userId: string | null = 'u-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (userId) (req as unknown as { user: unknown }).user = { userId }; next(); });
  app.use(BASE, routes);
  return app;
}
const api = () => request(makeApp());
const rev = () => hotLeadCallRevisionOf(table.org.hotLeadCall);
const codeOfCall = (i = 0) => spokenCode(fake.placedCalls[i]);

beforeAll(() => { process.env.JWT_SECRET = 'test-secret-not-real'; });
beforeEach(() => {
  jest.clearAllMocks();
  role = 'owner';
  setHotLeadCallEntitledOverride(true);
  table = { org: { orgId: 'org-a', ownerUserId: 'billing-owner', hotLeadCall: stored() }, writes: [], beforeWrite: null };
  installFakeOrgTable(orgDb as never, table);
  (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => (id === 'u-1' ? { userId: 'u-1', orgId: 'org-a', orgRole: role } : null));
  fake = new FakeVoiceProvider();
  setVoiceProviderForTests(fake);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  setVoiceProviderForTests(null);
  setHotLeadCallEntitledOverride(null);
});

describe('mounting', () => {
  it('is mounted beside the other org routes behind authenticateToken', () => {
    const source = readFileSync(join(__dirname, '../app.ts'), 'utf8');
    expect(source).toContain('app.use("/api/orgs/me/hot-lead-call", authenticateToken, orgHotLeadCallRoutes);');
  });
});

describe('authorization', () => {
  const calls: Array<[string, string, () => request.Test]> = [
    ['GET /', 'get', () => api().get(BASE)],
    ['PUT /', 'put', () => api().put(BASE).send({ _revision: rev(), enabled: false })],
    ['POST start', 'post', () => api().post(`${BASE}/members/${A}/verification/start`)],
    ['POST confirm', 'post', () => api().post(`${BASE}/members/${A}/verification/confirm`).send({ code: '123456' })],
    ['GET preview', 'get', () => api().get(`${BASE}/preview`)],
  ];
  it.each(calls)('%s answers 403 to a member without org:configure and touches nothing', async (_label, _m, call) => {
    role = 'member';
    const res = await call();
    expect(res.status).toBe(403);
    expect(typeof res.body.error).toBe('string');
    expect(table.writes).toEqual([]);
    expect(fake.placedCalls).toEqual([]);
  });
  it.each(calls)('%s lets an org admin through the permission check', async (_label, _m, call) => {
    role = 'admin';
    expect((await call()).status).not.toBe(403);
  });
  it('answers 404 for a caller without an org', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u-1' });
    expect((await api().get(BASE)).status).toBe(404);
    expect((await request(makeApp(null)).get(BASE)).status).toBe(404);
  });
  it('reads the org consistently so the revision is current', async () => {
    await api().get(BASE);
    expect(orgDb.getOrgById).toHaveBeenCalledWith('org-a', undefined, true);
  });
});

describe('GET /', () => {
  it('returns the contract body with masked phones only', async () => {
    const res = await api().get(BASE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      _revision: rev(), entitled: true, enabled: false, canEnable: true, blockers: [],
      callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' }, maxAttemptsPerLead: 3, maxCallsPerMonth: 200, warnings: ['Canadian numbers are not called yet; leads with a Canadian number are skipped even though Canada is allowed here'], announcedName: 'Acme Plumbing', twilioNumberMasked: '***0111',
      team: [
        { id: A, name: 'Dana Lee', phoneMasked: '***0100', verified: true, windows: [EVERY_DAY] },
        { id: B, name: 'Sam Ortiz', phoneMasked: '***0122', verified: false, windows: [WEEKDAYS] },
      ],
      limits: { maxTeamSize: 10, maxWindowsPerMember: 7, minAttempts: 1, maxAttempts: 5, nameMaxLength: 40 },
    });
    expect(res.text).not.toMatch(/\+1415|4155550|PN[0-9a-f]{32}|verifiedAt/);
  });
  it('answers 200 with defaults for an org without settings', async () => {
    delete table.org.hotLeadCall;
    const res = await api().get(BASE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, team: [], callingHours: null, entitled: true, canEnable: false });
    expect(res.body.blockers.length).toBeGreaterThan(0);
  });
  it('answers 500 without leaking details when the stored settings are unreadable', async () => {
    (table.org.hotLeadCall as Record<string, unknown>).maxCallsPerDay = 9999;
    const res = await api().get(BASE);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(res.text).not.toContain('9999');
  });
});

describe('PUT /', () => {
  it('answers 428 when the revision is missing', async () => {
    const res = await api().put(BASE).send({ enabled: false });
    expect(res.status).toBe(428);
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(table.writes).toEqual([]);
  });
  it('answers 409 for a stale revision', async () => {
    const res = await api().put(BASE).send({ _revision: 'f'.repeat(64), enabled: false });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String) });
  });
  it('answers 409 when a concurrent save wins between read and write', async () => {
    table.beforeWrite = () => { (table.org.hotLeadCall as Record<string, unknown>).maxCallsPerDay = 50; };
    const res = await api().put(BASE).send({ _revision: rev(), maxAttemptsPerLead: 2 });
    expect(res.status).toBe(409);
    expect((table.org.hotLeadCall as Record<string, unknown>).maxAttemptsPerLead).toBe(3);
  });
  it('saves, reorders and returns the updated GET body with a fresh revision that works for the next save', async () => {
    const res = await api().put(BASE).send({
      _revision: rev(), maxAttemptsPerLead: 2, announcedName: 'Acme Plumbing & Sons',
      team: [{ id: B, name: 'Sam Ortiz', windows: [WEEKDAYS] }, { id: A, name: 'Dana Lee', windows: [EVERY_DAY] }],
    });
    expect(res.status).toBe(200);
    expect(res.body.team.map((m: { id: string }) => m.id)).toEqual([B, A]);
    expect(res.body).toMatchObject({ maxAttemptsPerLead: 2, announcedName: 'Acme Plumbing & Sons', _revision: rev() });
    expect((await api().put(BASE).send({ _revision: res.body._revision, enabled: false })).status).toBe(200);
  });
  it('accepts the enable switch with only the revision and enabled', async () => {
    const res = await api().put(BASE).send({ _revision: rev(), enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    // The person's click in the portal is the approval: no chat card is asked for or claimed.
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
    expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
  });
  it('lets a brand-new org add people without calling hours', async () => {
    delete table.org.hotLeadCall;
    const res = await api().put(BASE).send({ _revision: rev(), team: [{ name: 'Kim Park', phone: '(415) 555-0133', windows: [WEEKDAYS] }], maxAttemptsPerLead: 3, announcedName: 'New Co' });
    expect(res.status).toBe(200);
    expect(res.body.team[0].id).toMatch(/^m[a-z0-9]{7}$/);
    expect(res.body).toMatchObject({ callingHours: null, enabled: false });
    expect(res.text).not.toContain('4155550133');
  });
  it('answers 400 with fieldErrors keyed by position in the submitted team', async () => {
    const res = await api().put(BASE).send({
      _revision: rev(), announcedName: '<Say>', maxAttemptsPerLead: 9, callingHours: { start: '09:00', end: '18:00', timezone: 'UTC' },
      team: [{ id: A, name: 'Dana Lee', windows: [EVERY_DAY] }, { name: 'Kim', phone: 'abc', windows: [{ days: [], start: '09:00', end: '17:00' }] }],
    });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(Object.keys(res.body.fieldErrors).sort()).toEqual(['announcedName', 'callingHours.timezone', 'maxAttemptsPerLead', 'team.1.phone', 'team.1.windows.0.days']);
    for (const message of Object.values(res.body.fieldErrors)) expect(typeof message).toBe('string');
    expect(table.writes).toEqual([]);
  });
  it('answers 403 with code not_entitled when enabling without the plan feature, but still saves other edits', async () => {
    setHotLeadCallEntitledOverride(false);
    const denied = await api().put(BASE).send({ _revision: rev(), enabled: true });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: expect.any(String), code: 'not_entitled' });
    expect((await api().put(BASE).send({ _revision: rev(), maxAttemptsPerLead: 2 })).status).toBe(200);
  });
  it('answers 400 for an enable that cannot work yet, naming the blocker', async () => {
    (table.org.hotLeadCall as { twilioNumber?: string }).twilioNumber = undefined;
    delete (table.org.hotLeadCall as { twilioNumberSid?: string }).twilioNumberSid;
    const res = await api().put(BASE).send({ _revision: rev(), enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.enabled).toContain('A phone number for calls has not been set up yet');
  });
  it.each([
    ['unknown keys', { twilioNumber: '+14155550999' }],
    ['tool-only settings', { maxCallsPerDay: 100 }],
    ['an unknown key', { orgId: 'org-b' }],
  ])('rejects %s with 400', async (_label, extra) => {
    const res = await api().put(BASE).send({ _revision: rev(), ...extra });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toBeDefined();
    expect(table.writes).toEqual([]);
  });
  it('PUT accepts maxCallsPerMonth 1..200, refuses 201+ with the support message, and preserves a stored 1500', async () => {
    expect((await api().put(BASE).send({ _revision: rev(), maxCallsPerMonth: 120 })).body.maxCallsPerMonth).toBe(120);
    const refused = await api().put(BASE).send({ _revision: rev(), maxCallsPerMonth: 201 });
    expect(refused.status).toBe(400);
    expect(refused.body.fieldErrors.maxCallsPerMonth).toBe('Higher monthly limits are set by AgentWeb support');
    (table.org.hotLeadCall as Record<string, unknown>).maxCallsPerMonth = 1500;
    expect((await api().get(BASE)).body.maxCallsPerMonth).toBe(1500);
    const edited = await api().put(BASE).send({ _revision: rev(), announcedName: 'Edited Co' });
    expect(edited.status).toBe(200);
    expect(edited.body.maxCallsPerMonth).toBe(1500);
    expect((table.org.hotLeadCall as Record<string, unknown>).maxCallsPerMonth).toBe(1500);
  });
  it('GET reports a Canada-only org as blocked', async () => {
    (table.org.hotLeadCall as Record<string, unknown>).allowedCountries = ['CA'];
    const res = await api().get(BASE);
    expect(res.body).toMatchObject({ canEnable: false, blockers: [expect.stringContaining('None of the allowed countries')], warnings: [expect.stringContaining('Canadian')] });
  });
  it.each([[[]], ['text'], [null]])('rejects a body that is not an object (%j)', async body => {
    const res = await api().put(BASE).set('Content-Type', 'application/json').send(JSON.stringify(body));
    expect(res.status).toBe(400);
  });
  it('rejects an oversized body', async () => {
    const res = await api().put(BASE).send({ _revision: rev(), announcedName: 'x'.repeat(40_000) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('too large');
    expect(table.writes).toEqual([]);
  });
  it('rejects more than 10 people and more than 7 windows at their paths', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `P ${i}`, phone: `+1415555${1000 + i}`, windows: [WEEKDAYS] }));
    expect((await api().put(BASE).send({ _revision: rev(), team: many })).body.fieldErrors).toHaveProperty('team');
    const windows = Array.from({ length: 8 }, () => WEEKDAYS);
    expect((await api().put(BASE).send({ _revision: rev(), team: [{ id: A, name: 'Dana', windows }] })).body.fieldErrors).toHaveProperty(['team.0.windows']);
  });
  it('never writes or accepts verification from the body', async () => {
    const res = await api().put(BASE).send({ _revision: rev(), team: [{ id: B, name: 'Sam', windows: [WEEKDAYS], verifiedAt: '2026-02-02T00:00:00.000Z' }] });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toHaveProperty(['team.0.verifiedAt']);
  });
  it('clears verification when a phone is changed through the API', async () => {
    const res = await api().put(BASE).send({ _revision: rev(), enabled: false, team: [{ id: A, name: 'Dana Lee', phone: '+16475550123', windows: [EVERY_DAY] }] });
    expect(res.status).toBe(200);
    expect(res.body.team[0]).toMatchObject({ id: A, phoneMasked: '***0123', verified: false });
  });
});

describe('POST members/:memberId/verification/start', () => {
  const start = (id = B) => api().post(`${BASE}/members/${id}/verification/start`);
  it('answers 200 with exactly the contract fields and never the code', async () => {
    const res = await start();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ expiresInSeconds: 600, nextStartAllowedInSeconds: 120, startsLeftToday: 4 });
    expect(fake.placedCalls[0]).toMatchObject({ to: '+14155550122' });
    expect(res.text).not.toContain(codeOfCall());
  });
  it('answers 429 with retryAfterSeconds (body and header) when started again too soon', async () => {
    await start();
    const res = await start();
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: expect.any(String), retryAfterSeconds: expect.any(Number) });
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBe(String(res.body.retryAfterSeconds));
    expect(fake.placedCalls).toHaveLength(1);
  });
  it.each(['mzzzzzzz', 'nope', 'MABCDEFG', 'm123'])('answers 404 for an unknown or malformed member %s', async id => {
    expect((await start(id)).status).toBe(404);
    expect(fake.placedCalls).toEqual([]);
  });
  it('answers 403 with the plain reason when the plan lacks the feature or there is no number', async () => {
    setHotLeadCallEntitledOverride(false);
    const plan = await start();
    expect(plan.status).toBe(403);
    expect(plan.body).toEqual({ error: expect.stringContaining('not included'), code: 'not_entitled' });
    setHotLeadCallEntitledOverride(true);
    delete (table.org.hotLeadCall as { twilioNumber?: string }).twilioNumber;
    delete (table.org.hotLeadCall as { twilioNumberSid?: string }).twilioNumberSid;
    const number = await start();
    expect(number.status).toBe(403);
    expect(number.body.error).toContain('phone number for calls');
    expect(number.body.error).not.toMatch(/hot_lead_call/);
    expect(fake.placedCalls).toEqual([]);
  });
  it('answers 502 when the phone provider rejects the call', async () => {
    fake.failNextPlaceCall('no');
    const res = await start();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: expect.any(String) });
  });
});

describe('POST members/:memberId/verification/confirm', () => {
  const confirm = (code: unknown, id = B) => api().post(`${BASE}/members/${id}/verification/confirm`).send(code === undefined ? {} : { code });
  it('answers 200 {verified:true} and marks only that member verified, which changes the revision', async () => {
    await api().post(`${BASE}/members/${B}/verification/start`);
    const before = rev();
    const res = await confirm(codeOfCall());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true });
    expect((await api().get(BASE)).body.team.map((m: { verified: boolean }) => m.verified)).toEqual([true, true]);
    expect(rev()).not.toBe(before);
  });
  it('answers 400 with attemptsLeft for a wrong code', async () => {
    await api().post(`${BASE}/members/${B}/verification/start`);
    const code = codeOfCall();
    const res = await confirm(code === '000000' ? '000001' : '000000');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), attemptsLeft: 4 });
  });
  it('answers 400 with attemptsLeft 0 when nothing is in progress', async () => {
    const res = await confirm('123456');
    expect(res.status).toBe(400);
    expect(res.body.attemptsLeft).toBe(0);
  });
  it.each([[undefined], ['12'], [123456], ['abcdef']])('answers 400 with attemptsLeft for a malformed code %j', async code => {
    const res = await confirm(code);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), attemptsLeft: expect.any(Number) });
  });
  it('rejects extra body fields', async () => {
    const res = await api().post(`${BASE}/members/${B}/verification/confirm`).send({ code: '123456', verifiedAt: 'x' });
    expect(res.status).toBe(400);
  });
  it('answers 404 for an unknown member', async () => {
    expect((await confirm('123456', 'mzzzzzzz')).status).toBe(404);
  });
});

describe('GET /preview', () => {
  it('lists who would be called at the given instant, in call order', async () => {
    (table.org.hotLeadCall as { team: Array<Record<string, unknown>> }).team[1].verifiedAt = '2026-01-01T00:00:00.000Z';
    // Tuesday 2026-10-20 13:00 Chicago time (14:00 Eastern: inside the lead window).
    const res = await api().get(`${BASE}/preview`).query({ at: '2026-10-20T18:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      at: '2026-10-20T18:00:00.000Z', timezone: 'America/Chicago', outsideCallingHours: false, outsideLeadHours: false, skipReason: null,
      warnings: ['Canadian numbers are not called yet; leads with a Canadian number are skipped even though Canada is allowed here'],
      candidates: [{ id: A, name: 'Dana Lee' }, { id: B, name: 'Sam Ortiz' }], excluded: [],
    });
  });
  it('explains who is left out and why', async () => {
    const res = await api().get(`${BASE}/preview`).query({ at: '2026-10-24T16:00:00Z' });
    expect(res.body.excluded).toEqual([{ id: B, name: 'Sam Ortiz', reason: 'unverified' }]);
    expect(res.body.candidates).toEqual([{ id: A, name: 'Dana Lee' }]);
  });
  it('defaults to now and answers for the closed hours', async () => {
    const res = await api().get(`${BASE}/preview`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('outsideCallingHours');
  });
  it.each(['yesterday', '2026-10-20', '1760976000', '2026-13-45T00:00:00Z', ''])('answers 400 for at=%s', async at => {
    const res = await api().get(`${BASE}/preview`).query({ at });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toHaveProperty('at');
  });
});
