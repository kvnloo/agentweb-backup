/**
 * Every tool the Zoma MCP server advertises leads with a plain-language "Use when the user …"
 * sentence so Claude / ChatGPT pick it from the user's own words, and the existing technical text
 * (PREVIEW / confirm / preview_token / read-only wording) follows unchanged.
 */
process.env.ZOMA_GOOGLE_ENABLED = 'true';
process.env.ZOMA_X_ADS_ENABLED = 'true';
process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'true';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toolkitManifest, zomaMcpInstructions } = require('../routes/metaToolkit');
import { ZOMA_USE_WHEN, withUseWhen } from '../mcp/zomaUseWhen';

// Claude Code cuts an MCP tool description at 4,096 characters by default (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH).
const MCP_CLIENT_DESCRIPTION_CUT = 4096;

describe('Zoma "Use when…" tool descriptions', () => {
  const tools: any[] = toolkitManifest(true);

  it('every advertised tool has a lead-in, and every lead-in belongs to an advertised tool', () => {
    const names = tools.map((t) => t.name);
    expect(names.filter((n) => !ZOMA_USE_WHEN[n])).toEqual([]);
    expect(Object.keys(ZOMA_USE_WHEN).filter((n) => !names.includes(n))).toEqual([]);
  });

  it('each description is the lead-in followed by the original text, under the client cut', () => {
    for (const t of tools) {
      const prefix = `Use when the user ${ZOMA_USE_WHEN[t.name]}. `;
      expect(t.description.startsWith(prefix)).toBe(true);
      expect(t.description.length - prefix.length).toBeGreaterThan(0);
      expect(t.description.length).toBeLessThan(MCP_CLIENT_DESCRIPTION_CUT);
      expect(t.description.indexOf('Use when the user ', 1)).toBe(-1); // applied once, never doubled
    }
  });

  it('keeps the write-safety wording on write tools', () => {
    const desc = (n: string) => tools.find((t) => t.name === n).description;
    for (const n of ['call_meta_marketing_api', 'call_google_ads_api', 'x_ads_write', 'linkedin_ads_write']) {
      expect(desc(n)).toContain('preview_token');
      expect(desc(n)).toContain('confirm=true');
    }
    expect(desc('meta_account_health')).toContain('Read-only');
  });

  it('withUseWhen leaves unknown tools and the rest of the definition untouched', () => {
    const schema = { type: 'object', properties: {} };
    const [known, unknown] = withUseWhen([
      { name: 'zoma_usage', description: 'X.', inputSchema: schema },
      { name: 'not_a_zoma_tool', description: 'Y.' },
    ]);
    expect(known).toEqual({ name: 'zoma_usage', description: `Use when the user ${ZOMA_USE_WHEN.zoma_usage}. X.`, inputSchema: schema });
    expect(unknown).toEqual({ name: 'not_a_zoma_tool', description: 'Y.' });
  });

  it('the server instructions tell the agent when to use Zoma, in user words', () => {
    expect(zomaMcpInstructions(true, true)).toContain('Use Zoma whenever the user talks about their Facebook or Instagram, Google or LinkedIn ads');
    expect(zomaMcpInstructions(false, false)).toContain('Use Zoma whenever the user talks about their Facebook or Instagram ads');
  });
});
