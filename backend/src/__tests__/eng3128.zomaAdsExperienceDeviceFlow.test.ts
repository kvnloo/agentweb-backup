process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-3128 — "How familiar are you with ads?" on the Zoma device-flow page and in the poll.
 *   - after approval the browser is asked the question before anything else
 *   - runs_ads -> straight to Meta connect (then card, then done)
 *   - new_to_ads -> ENG-3134: straight to Meta connect, like runs_ads
 *   - not_interested -> thank-you page, no further steps; the poll ends without a token
 *   - the poll exposes the question as next_step and accepts the answer, so an agent can ask in chat
 *   - no page links to the Emma app
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'eng-3128-test-secret';

jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../mcp/zomaOnboarding', () => ({ getZomaReadiness: jest.fn(), createZomaPaymentSetupLink: jest.fn() }));
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: {} }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));

import express from 'express';
import request from 'supertest';
import {
  answerAdsExperience, beginVerification, completeVerification, continueInBrowser, defaultZomaDeviceFlowDeps,
  pollSetup, startSetup, ZOMA_ADS_EXPERIENCE_PATH, type ZomaDeviceFlowDeps,
} from '../mcp/zomaDeviceFlow';
import type { ZomaDeviceRecord, ZomaDeviceStore, ZomaTokenRecord } from '../mcp/zomaDeviceStore';
import { ZOMA_META_LOGIN_NOTE, zomaNewToAdsSteps, ZOMA_NOT_INTERESTED_MESSAGE, type ZomaAdsExperience } from '../mcp/zomaAdsExperience';
import { defaultZomaLinkCodec } from '../mcp/zomaSetupLinks';
import { createZomaRouter } from '../routes/zoma';

class MemoryStore implements ZomaDeviceStore {
  devices = new Map<string, ZomaDeviceRecord>();
  userCodes = new Map<string, string>();
  tokens = new Map<string, ZomaTokenRecord>();
  async createDevice(r: ZomaDeviceRecord) {
    this.userCodes.set(r.userCode, r.deviceId);
    this.devices.set(r.deviceId, { ...r });
    return true;
  }
  async getDevice(id: string) {
    const d = this.devices.get(id);
    return d ? { ...d } : null;
  }
  async getDeviceIdByUserCode(code: string) {
    return this.userCodes.get(code) ?? null;
  }
  async claimPoll() {
    return { ok: true as const };
  }
  async resolveDevice(id: string, outcome: any) {
    const d = this.devices.get(id)!;
    d.status = outcome.status;
    if (outcome.status === 'approved') Object.assign(d, { userId: outcome.userId, expiresAt: outcome.expiresAt });
    return true;
  }
  async saveLink(id: string, step: any, link: string) {
    const d = this.devices.get(id)!;
    d.links = { ...(d.links ?? {}), [step]: link };
  }
  async issueToken(id: string, token: ZomaTokenRecord) {
    this.devices.get(id)!.status = 'issued';
    this.tokens.set(token.tokenHash, { ...token });
    return true;
  }
  async getToken(hash: string) {
    return this.tokens.get(hash) ?? null;
  }
  async revokeToken() {
    return false;
  }
  async appendEvent(id: string, event: any) {
    const d = this.devices.get(id);
    if (d) d.events = [...(d.events ?? []), event];
  }
}

const META = 'https://www.facebook.com/v23.0/dialog/oauth?client_id=x';
const EMMA_APP = 'app.agentweb.pro';

function harness() {
  const store = new MemoryStore();
  const user: { answer: ZomaAdsExperience | null; meta: boolean; payment: boolean } = { answer: null, meta: false, payment: false };
  const deps: ZomaDeviceFlowDeps = {
    ...defaultZomaDeviceFlowDeps,
    store,
    now: () => 1_800_000_000_000,
    backendUrl: () => 'https://api.example.test',
    readiness: jest.fn(async () => ({
      payment: { ready: user.payment },
      meta: { ready: user.meta, accounts: [] },
      google_ads: { available: false, ready: false, accounts: [], writes_enabled: false },
      writes_enabled: user.meta && user.payment,
      ads_experience: user.answer,
      blocker: null,
      next_step: null,
    })),
    mintMetaLink: jest.fn().mockResolvedValue(META),
    mintPaymentLink: jest.fn().mockResolvedValue('https://checkout.stripe.com/c/pay/cs_test_1'),
    ensureClient: jest.fn().mockResolvedValue(undefined),
    consumeAuthCode: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    principalAllowed: jest.fn().mockResolvedValue(true),
    links: defaultZomaLinkCodec,
    saveAdsExperience: jest.fn(async (_u: string, answer: ZomaAdsExperience) => {
      user.answer = answer;
    }),
  };
  return { deps, store, user };
}

async function approved(h: ReturnType<typeof harness>) {
  const start = await startSetup(h.deps);
  const begin = await beginVerification(start.user_code, h.deps);
  if (!begin.ok) throw new Error(begin.message);
  const done = await completeVerification({ code: 'auth-code', state: new URL(begin.redirect).searchParams.get('state') }, h.deps);
  if (!done.ok) throw new Error(done.message);
  return { deviceCode: start.device_code, deviceId: done.deviceId };
}

async function askedToken(h: ReturnType<typeof harness>, deviceId: string) {
  const step = await continueInBrowser(deviceId, h.deps);
  if (step.kind !== 'ask_ads_experience') throw new Error(`expected the question, got ${step.kind}`);
  return step.token;
}

describe('ENG-3128 device-flow page', () => {
  it('after approval the question comes first (before Meta), with the three options', async () => {
    const h = harness();
    const { deviceId } = await approved(h);
    const step = await continueInBrowser(deviceId, h.deps);
    expect(step).toMatchObject({ kind: 'ask_ads_experience', action: ZOMA_ADS_EXPERIENCE_PATH, question: 'How familiar are you with ads?' });
    expect((step as any).options.map((o: any) => o.value)).toEqual(['runs_ads', 'new_to_ads', 'not_interested']);
    expect(h.deps.mintMetaLink).not.toHaveBeenCalled();
  });

  it('runs_ads: stored, then straight to Meta connect; after Meta, the card; after that, done', async () => {
    const h = harness();
    const { deviceId } = await approved(h);
    const step = await answerAdsExperience({ t: await askedToken(h, deviceId), answer: 'runs_ads' }, h.deps);
    expect(h.deps.saveAdsExperience).toHaveBeenCalledWith('user-1', 'runs_ads');
    expect(step).toEqual({ kind: 'redirect', url: META });
    h.user.meta = true;
    expect(await continueInBrowser(deviceId, h.deps)).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    h.user.payment = true;
    expect(await continueInBrowser(deviceId, h.deps)).toMatchObject({ kind: 'page', done: true, title: "You're set" });
  });

  // ENG-3134 (supersedes the ENG-3128 guide-first page): the answer leads straight to Meta connect.
  // The setup guide is on the "No ad account found" page, covered in eng3134.zomaRedesign.test.ts.
  it('new_to_ads: stored, then straight to Meta connect (no detour page)', async () => {
    const h = harness();
    const { deviceId } = await approved(h);
    const step = await answerAdsExperience({ t: await askedToken(h, deviceId), answer: 'new_to_ads' }, h.deps);
    expect(h.deps.saveAdsExperience).toHaveBeenCalledWith('user-1', 'new_to_ads');
    expect(step).toEqual({ kind: 'redirect', url: META });
    expect(JSON.stringify(step)).not.toContain(EMMA_APP);
  });

  it('not_interested: thank-you page, and resuming later still shows it (no Meta, no card)', async () => {
    const h = harness();
    const { deviceId } = await approved(h);
    const step = await answerAdsExperience({ t: await askedToken(h, deviceId), answer: 'not_interested' }, h.deps);
    expect(h.deps.saveAdsExperience).toHaveBeenCalledWith('user-1', 'not_interested');
    expect(step).toMatchObject({ kind: 'page', done: true, message: ZOMA_NOT_INTERESTED_MESSAGE });
    expect((step as any).retryUrl).toBeUndefined();
    expect(await continueInBrowser(deviceId, h.deps)).toMatchObject({ kind: 'page', message: ZOMA_NOT_INTERESTED_MESSAGE });
    expect(h.deps.mintMetaLink).not.toHaveBeenCalled();
    expect(h.deps.mintPaymentLink).not.toHaveBeenCalled();
  });

  it('a missing or unknown answer re-asks; a bad link is rejected; nothing is stored', async () => {
    const h = harness();
    const { deviceId } = await approved(h);
    const t = await askedToken(h, deviceId);
    expect(await answerAdsExperience({ t, answer: 'maybe' }, h.deps)).toMatchObject({ kind: 'ask_ads_experience', message: 'Choose one of the options.' });
    expect(await answerAdsExperience({ t: 'forged', answer: 'runs_ads' }, h.deps)).toMatchObject({ kind: 'page', status: 400 });
    expect(h.deps.saveAdsExperience).not.toHaveBeenCalled();
  });

  it('HTTP: the question renders as one-click answer buttons posting to /api/zoma/ads-experience; submitting not_interested shows thanks', async () => {
    const h = harness();
    const { deviceId } = await approved(h);
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/api/zoma', createZomaRouter(h.deps));
    const t = await askedToken(h, deviceId);
    const page = await request(app).get(`/api/zoma/continue?t=${encodeURIComponent(t)}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('How familiar are you with ads?');
    expect(page.text).toContain(`action="${ZOMA_ADS_EXPERIENCE_PATH}"`);
    // Same `answer` field as before, now carried by a submit button so one click answers.
    expect(page.text).toContain('name="answer" value="not_interested"');
    expect(page.text).toContain('type="submit" class="choice"');
    expect(page.text).not.toContain('type="radio"');
    expect(page.text).toContain('Not interested, just a friend');

    const res = await request(app).post('/api/zoma/ads-experience').type('form').send({ t, answer: 'not_interested' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Thanks for stopping by');
    expect(res.text).not.toContain(EMMA_APP);
  });
});

describe('ENG-3128 poll (agent asks in chat)', () => {
  it('unanswered: next_step is ads_experience with the question and options, no token', async () => {
    const h = harness();
    const { deviceCode } = await approved(h);
    const r = await pollSetup(deviceCode, h.deps);
    expect(r).toMatchObject({ status: 200, body: { next_step: 'ads_experience', question: 'How familiar are you with ads?' } });
    expect((r.body as any).options.map((o: any) => o.value)).toEqual(['runs_ads', 'new_to_ads', 'not_interested']);
    expect(r.body).not.toHaveProperty('access_token');
  });

  it('runs_ads via poll: stored, next_step connect_meta with the link and no guide', async () => {
    const h = harness();
    const { deviceCode } = await approved(h);
    const r = await pollSetup(deviceCode, h.deps, { adsExperience: 'runs_ads' });
    expect(h.deps.saveAdsExperience).toHaveBeenCalledWith('user-1', 'runs_ads');
    expect(r.body).toMatchObject({ next_step: 'connect_meta', link: META, note: ZOMA_META_LOGIN_NOTE });
    expect(r.body).not.toHaveProperty('guide');
  });

  it('new_to_ads via poll: connect_meta carries the setup guide', async () => {
    const h = harness();
    const { deviceCode } = await approved(h);
    const r = await pollSetup(deviceCode, h.deps, { adsExperience: 'new_to_ads' });
    expect(r.body).toMatchObject({ next_step: 'connect_meta', link: META, guide: zomaNewToAdsSteps() });
    // The guide already ends with the login note, so it is not repeated as a separate field.
    expect(r.body).not.toHaveProperty('note');
  });

  it('not_interested via poll: next_step not_interested, thank-you message, never a token', async () => {
    const h = harness();
    h.user.meta = true;
    h.user.payment = true;
    const { deviceCode } = await approved(h);
    const r = await pollSetup(deviceCode, h.deps, { adsExperience: 'not_interested' });
    expect(r).toEqual({ status: 200, body: { next_step: 'not_interested', message: ZOMA_NOT_INTERESTED_MESSAGE } });
    expect(h.store.tokens.size).toBe(0);
    expect((await pollSetup(deviceCode, h.deps)).body).toMatchObject({ next_step: 'not_interested' });
    expect(h.store.tokens.size).toBe(0);
  });

  it('an invalid ads_experience is invalid_request and stores nothing', async () => {
    const h = harness();
    const { deviceCode } = await approved(h);
    const r = await pollSetup(deviceCode, h.deps, { adsExperience: 'lots' });
    expect(r).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(h.deps.saveAdsExperience).not.toHaveBeenCalled();
  });
});
