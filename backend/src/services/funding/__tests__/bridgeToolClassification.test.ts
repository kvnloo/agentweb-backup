/**
 * ENG-2113 PR B: the repeat guard's classification of `call_*` tools. The tripwire fails
 * when a `call_*` tool exists in the code base without an explicit rule.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { CALL_TOOL_RULES, isStrictRepeatEffect } from '../bridgeToolClassification';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('bridge tool classification', () => {
  it('has an explicit rule for every call_* tool defined in the code base (tripwire)', () => {
    const srcRoot = join(__dirname, '..', '..', '..');
    const found = new Set<string>();
    for (const file of sourceFiles(srcRoot)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/name:\s*['"](call_[a-z0-9_]+)['"]/g)) found.add(match[1]);
    }
    expect([...found].length).toBeGreaterThan(5); // the scan itself works
    const missing = [...found].filter((name) => CALL_TOOL_RULES[name] === undefined);
    expect(missing).toEqual([]);
  });

  it('treats the argument-dependent API tools as strict and the reporting tools as reads', () => {
    for (const name of ['call_meta_marketing_api', 'call_google_ads_api', 'call_linkedin_marketing_api']) {
      expect(isStrictRepeatEffect(name, { action: 'anything' })).toBe(true);
    }
    for (const name of ['call_meta_ads_insights_api', 'call_google_ads_reporting_api', 'call_linkedin_ads_insights_api']) {
      expect(isStrictRepeatEffect(name, {})).toBe(false);
    }
  });

  it('classifies HubSpot and Attio from the real arguments', () => {
    expect(isStrictRepeatEffect('call_hubspot_api', { action: 'DELETE' })).toBe(true);
    expect(isStrictRepeatEffect('call_hubspot_api', { action: 'CREATE_BROADCAST' })).toBe(true);
    expect(isStrictRepeatEffect('call_hubspot_api', { action: 'LIST' })).toBe(false);
    expect(isStrictRepeatEffect('call_attio_api', { action: 'REMOVE_ENTRIES' })).toBe(true);
    expect(isStrictRepeatEffect('call_attio_api', { action: 'QUERY' })).toBe(false);
  });

  it('fails toward not repeating for an unlisted call_* tool', () => {
    expect(isStrictRepeatEffect('call_brand_new_api', {})).toBe(true);
  });

  it('is strict for externally visible and destructive tools and not for plain writes', () => {
    expect(isStrictRepeatEffect('send_email', { to: 'a@b.c' })).toBe(true);
    expect(isStrictRepeatEffect('publish_blog_article', {})).toBe(true);
    expect(isStrictRepeatEffect('delete_lead', {})).toBe(true);
    expect(isStrictRepeatEffect('save_file', {})).toBe(false);
    expect(isStrictRepeatEffect('get_leads', {})).toBe(false);
  });
});
