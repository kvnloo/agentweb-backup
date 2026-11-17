/**
 * ZOMA_GOOGLE_ENABLED — Zoma is Meta-only unless the flag is exactly "true".
 *
 * Acceptance contract (Harsha): with the flag unset/false, no customer-facing Zoma surface names
 * Google advertising (tool descriptions, ads-experience options, new-advertiser steps, error next
 * steps, MCP instructions, the agent guide, usage lines, the Google connect pages). With the flag
 * true, the preserved Google implementation is restored unchanged. The old ZOMA_GOOGLE_ADS_ENABLED
 * name no longer turns Google on, so production (which still carries it) ships Meta-only.
 */
import fs from 'fs';
import path from 'path';

jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));

import { googleToolkitEnabled, zomaToolDefinitions } from '../mcp/zomaToolDefinitions';
import { zomaAdsExperienceOptions, zomaNewToAdsSteps, adsExperienceQuestionText } from '../mcp/zomaAdsExperience';
import { zomaErrorNextStep } from '../mcp/zomaNextStep';
import { completeGoogleConnect, defaultZomaGoogleDeps, selectGoogleAccounts, type ZomaGoogleDeps } from '../mcp/zomaGoogleConnect';
import { formatZomaUsage } from '../mcp/zomaOnboarding';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { zomaMcpInstructions, zomaSkillDoc } = require('../routes/metaToolkit');

const GOOGLE = /google|pmax|performance max/i;
const doc = fs.readFileSync(path.join(__dirname, '../../docs/meta-toolkit-skill.md'), 'utf-8');
const usage = {
  start: '2026-11-01T00:00:00.000Z',
  end: '2026-12-01T00:00:00.000Z',
  toolCalls: 3,
  writes: { total: 2, confirmed: 2, mismatch: 0, unconfirmed: 0 },
  recentWrites: [
    { ts: '2026-11-02T10:00:00.000Z', platform: 'meta', action: 'UPDATE', entityType: 'CAMPAIGN', verification: 'CONFIRMED', objectId: '1' },
    { ts: '2026-11-03T10:00:00.000Z', platform: 'google_ads', action: 'UPDATE', entityType: 'BUDGET', verification: 'CONFIRMED', objectId: '2' },
  ],
};
const googleDeps = (enabled: boolean): ZomaGoogleDeps => ({
  ...defaultZomaGoogleDeps,
  mintLink: jest.fn().mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=x'),
  enabled: () => enabled,
});
const zomaDescriptions = () =>
  getMetaToolkitManifest().filter((t: any) => t.name.startsWith('zoma_')).map((t: any) => JSON.stringify(t)).join('\n');

const prev = { on: process.env.ZOMA_GOOGLE_ENABLED, old: process.env.ZOMA_GOOGLE_ADS_ENABLED };
afterEach(() => {
  for (const [key, value] of [['ZOMA_GOOGLE_ENABLED', prev.on], ['ZOMA_GOOGLE_ADS_ENABLED', prev.old]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the flag', () => {
  it('defaults to false and only "true" turns it on', () => {
    expect(googleToolkitEnabled({})).toBe(false);
    expect(googleToolkitEnabled({ ZOMA_GOOGLE_ENABLED: 'false' })).toBe(false);
    expect(googleToolkitEnabled({ ZOMA_GOOGLE_ENABLED: '1' })).toBe(false);
    expect(googleToolkitEnabled({ ZOMA_GOOGLE_ENABLED: 'true' })).toBe(true);
  });

  it('the old ZOMA_GOOGLE_ADS_ENABLED=true (still set in production) no longer enables Google', () => {
    expect(googleToolkitEnabled({ ZOMA_GOOGLE_ADS_ENABLED: 'true' })).toBe(false);
  });
});

describe('ZOMA_GOOGLE_ENABLED unset (default): Meta only', () => {
  beforeEach(() => {
    delete process.env.ZOMA_GOOGLE_ENABLED;
    process.env.ZOMA_GOOGLE_ADS_ENABLED = 'true';
  });

  it('zoma_ tool definitions and the advertised manifest never name Google', () => {
    expect(JSON.stringify(zomaToolDefinitions())).not.toMatch(GOOGLE);
    expect(zomaDescriptions()).not.toMatch(GOOGLE);
    expect(getMetaToolkitManifest().map((t: any) => t.name).filter((n: string) => GOOGLE.test(n))).toEqual([]);
  });

  it('ads-experience question, options and new-advertiser steps are Meta only', () => {
    expect(JSON.stringify(zomaAdsExperienceOptions())).not.toMatch(GOOGLE);
    expect(zomaAdsExperienceOptions()[0].label).toBe('I already run ads / use the Meta MCP');
    expect(adsExperienceQuestionText('zoma_status')).not.toMatch(GOOGLE);
    expect(zomaNewToAdsSteps().join('\n')).not.toMatch(GOOGLE);
    expect(zomaNewToAdsSteps().at(-1)).toMatch(/^Then connect that ad account to Zoma\./);
  });

  it('error next step, MCP instructions, agent guide and usage lines are Meta only', () => {
    expect(zomaErrorNextStep('Multiple Meta ad accounts are connected; pass account_id.')).toBe(
      'Ask the user which account to use, then retry with account_id set to it.',
    );
    expect(zomaMcpInstructions()).not.toMatch(GOOGLE);
    expect(zomaMcpInstructions()).toContain("run the user's Meta ads safely");
    const served = zomaSkillDoc(doc);
    expect(served).not.toMatch(GOOGLE);
    expect(served).not.toContain('zoma-google');
    expect(served).toContain('zoma_status');
    expect(served).toContain('## Usage');
    const text = formatZomaUsage(usage as any);
    expect(text).not.toMatch(GOOGLE);
    expect(text).toContain('UPDATE CAMPAIGN 1');
  });

  it('the Google connect pages answer a generic 404 page and never reach Google', async () => {
    const deps = googleDeps(false);
    deps.finalize = jest.fn();
    for (const step of [
      await completeGoogleConnect({ code: 'c', state: 'anything' }, deps),
      await selectGoogleAccounts({ t: 'anything', account_id: '1' }, deps),
    ] as any[]) {
      expect(step).toMatchObject({ kind: 'page', status: 404, title: 'Zoma setup' });
      expect(JSON.stringify(step)).not.toMatch(GOOGLE);
    }
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.mintLink).not.toHaveBeenCalled();
  });
});

describe('ZOMA_GOOGLE_ENABLED=true: the Google implementation is restored', () => {
  beforeEach(() => { process.env.ZOMA_GOOGLE_ENABLED = 'true'; });

  it('tool definitions, manifest and ads-experience copy name Google again', () => {
    const defs = JSON.stringify(zomaToolDefinitions());
    expect(defs).toContain('Meta/Google MCP');
    expect(defs).toContain('call_google_ads_api ASSET UPLOAD');
    expect(getMetaToolkitManifest().map((t: any) => t.name)).toEqual(expect.arrayContaining(['zoma_status']));
    expect(zomaAdsExperienceOptions()[0].label).toBe('I already run ads / use the Meta or Google MCP');
    expect(zomaNewToAdsSteps().some((s) => s.startsWith('Google (optional): '))).toBe(true);
    expect(zomaNewToAdsSteps().at(-1)).toMatch(/^Then connect those ad accounts to Zoma\./);
  });

  it('error next step, MCP instructions, agent guide and usage lines include Google', () => {
    expect(zomaErrorNextStep('Multiple Google Ads accounts are connected; pass customer_id.')).toContain('customer_id (Google)');
    expect(zomaMcpInstructions()).toContain('Meta (and Google)');
    const served = zomaSkillDoc(doc);
    expect(served).toContain('## Google Ads (when enabled for the account)');
    expect(served).toContain('Performance Max');
    expect(served).not.toContain('zoma-google');
    expect(formatZomaUsage(usage as any)).toContain('[Google Ads] UPDATE BUDGET 2');
  });

  it('the Google connect pages run the real flow (an invalid state is the existing expired page)', async () => {
    const step: any = await completeGoogleConnect({ code: 'c', state: 'not-a-jwt' }, googleDeps(true));
    expect(step).toMatchObject({ kind: 'page', status: 400 });
    expect(step.message).toContain('Google Ads connection link is invalid or has expired');
    const picker: any = await selectGoogleAccounts({ t: 'bad', account_id: '1' }, googleDeps(true));
    expect(picker).toMatchObject({ kind: 'page', status: 400 });
  });
});
