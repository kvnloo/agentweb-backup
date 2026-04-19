/**
 * Smoke checks for dep bumps that could silently change runtime behavior.
 *
 * We don't do full integration here — the existing jest suite already covers
 * service-level behavior. This file just makes sure the bumped packages still
 * expose the surface our code uses. A failure here means the bump was not
 * backwards compatible and needs to be pinned lower.
 *
 * Ownership: swarm. Part of sprint task
 *   "Upgrade backend deps with critical CVEs".
 */

describe('bumped dependency runtime shapes', () => {
  it('axios default export is callable and resolves to a fixed version', () => {
    // Guard against an accidental downgrade of axios past the DoS fix (>=1.12).
    // axios exposes its version via `VERSION` on the default export.
    const axios = require('axios');
    expect(typeof axios.get).toBe('function');
    expect(typeof axios.post).toBe('function');
    const version: string = axios.VERSION || axios.default?.VERSION || '';
    const [major, minor] = version.split('.').map((n: string) => parseInt(n, 10));
    // v1.12.0 was the first release with the DoS data-size fix + proto key fix.
    // Assert we are at or above that.
    expect(major).toBeGreaterThanOrEqual(1);
    if (major === 1) {
      expect(minor).toBeGreaterThanOrEqual(12);
    }
  });

  it('form-data keeps its FormData constructor', () => {
    // @aws-sdk (via openapi-fetch-style helpers) and a few fetchers still
    // import form-data directly. If the patched version drops its default
    // export we need to know before prod.
    const FormData = require('form-data');
    const fd = new FormData();
    expect(typeof fd.append).toBe('function');
    expect(typeof fd.getBoundary).toBe('function');
  });

  it('fast-xml-parser still exports XMLParser class', () => {
    // aws-sdk v3 shapes S3 list responses through fast-xml-parser. If the
    // override resolves to an unexpected major we want to catch it here.
    const mod = require('fast-xml-parser');
    expect(mod).toBeDefined();
    // Either ESM-style default or named export, depending on resolved version.
    const XMLParser = mod.XMLParser || mod.default?.XMLParser;
    expect(typeof XMLParser).toBe('function');
  });

  it('handlebars still exposes compile()', () => {
    // Used transitively by ts-jest -> jest-snapshot -> pretty-format. We don't
    // call it directly, but downgrading to the CVE range <4.7.9 would reopen
    // the prototype-pollution advisory.
    const Handlebars = require('handlebars');
    expect(typeof Handlebars.compile).toBe('function');
    const tmpl = Handlebars.compile('hello {{name}}');
    expect(tmpl({ name: 'world' })).toBe('hello world');
  });
});
