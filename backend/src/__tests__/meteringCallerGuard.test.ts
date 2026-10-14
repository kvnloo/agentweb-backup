/**
 * ENG-2108 (A2): every direct caller of the AgentWeb metering rails is classified.
 *
 * `meterUserUsage`, `meterUsageFromResponse`, `meterWithResolvedBilling`, `recordUsage` and
 * `incrementUserTokenUsage` write to the usage tables, the per-user cap
 * and the spend events: the rails that must only ever see AgentWeb-paid usage. A caller
 * that stays AgentWeb-funded belongs there. A caller that gets routed to a customer key
 * must go through `recordLlmUsage` with the funding that actually paid, or its usage
 * would be folded into the customer's own AgentWeb cap.
 *
 * Adding a caller fails this test until it is classified here, which is the moment to
 * decide which of the two it is.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');

/** file (relative to src) -> why it is correct for it to write to the rails. */
const STAYS_AGENTWEB_PAID: Record<string, string> = {
  'utils/llmClients.ts': 'embeddings, search, video and factory auto-record: AgentWeb keys, not customer-routable (A2 PR 2 reclassifies any that get routed)',
  'utils/llmService.ts': 'AgentWeb-funded LLM helper',
  'utils/embeddings.ts': 'AgentWeb-funded embeddings (helpers stay AgentWeb-paid in v1)',
  'services/imageGeneration.ts': 'AgentWeb-funded until A2 PR 2 routes Gemini/DALL-E images',
  'services/videoGeneration.ts': 'Veo/Higgsfield: native-key BYOK is ENG-2130; Higgsfield stays AgentWeb',
  'services/liveVoiceService.ts': 'Live Voice: retain/migrate decision is ENG-2129',
  'emma/impl/video.ts': 'AgentWeb-funded describe_video until A2 PR 2 routes it',
  'emma/impl/searchResearch.ts': 'AgentWeb-funded search and research',
  'emma/tools.ts': 'AgentWeb-funded tool-side metering',
  'mcp/metaToolkitGateway.ts': 'AgentWeb-funded MCP gateway metering',
  'routes/internalUsage.ts': 'internal usage ingestion for AgentWeb-paid vendors',
  'services/codingAgentService.ts': 'AgentWeb-funded coding-agent turns meter here; a turn on the customer\'s key is resolved per turn and goes to recordLlmUsage instead (A2 PR 2)',
  'services/codingAgentSubpageService.ts': 'AgentWeb-funded coding agent sub-page',
  'services/apolloQuota.ts': 'Apollo vendor quota (AgentWeb vendor)',
  'services/apolloService.ts': 'Apollo vendor (AgentWeb vendor)',
  'services/enrichSoQuota.ts': 'enrich.so vendor quota (AgentWeb vendor)',
  'services/enrichSoService.ts': 'enrich.so vendor (AgentWeb vendor)',
  'services/tokenUsageService.ts': 'defines the per-user cap rail',
  'services/usageRecordDb.ts': 'defines the usage-record rail',
  'services/agentMode/deferredBillingMetering.ts': 'the AgentWeb rail itself (meterWithResolvedBilling)',
  'services/funding/recordLlmUsage.ts': 'the funding branch: only AgentWeb-funded calls reach the rails',
  'services/usageRecorderService.ts': 'defines the rails',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const CALL = /\b(meterUserUsage|meterUserUsageAsync|meterUsageFromResponse|meterWithResolvedBilling|recordUsage|incrementUserTokenUsage)\s*\(/;

describe('direct callers of the AgentWeb metering rails', () => {
  const callers = sourceFiles(SRC)
    .filter((file) => CALL.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
    .sort();

  it('are all classified', () => {
    const unclassified = callers.filter((file) => !(file in STAYS_AGENTWEB_PAID));
    expect(unclassified).toEqual([]);
  });

  it('has no stale entries', () => {
    const stale = Object.keys(STAYS_AGENTWEB_PAID).filter((file) => !callers.includes(file));
    expect(stale).toEqual([]);
  });
});

describe('which callLLM calls may use a customer key (ENG-2108)', () => {
  const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');
  const mentions = sourceFiles(SRC)
    .map((file) => ({ file: path.relative(SRC, file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') }))
    .filter(({ text }) => /customerRoutable\s*[:,=]/.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));

  it('is read from the call options in callLLM and set nowhere outside the agent service and the resolver', () => {
    expect(mentions.map((m) => m.file).sort()).toEqual([
      'services/agentModeService.ts',
      'services/codingAgentService.ts',
      'services/funding/callFunding.ts',
    ]);
  });

  it('lets only the coding agent skip the provisioner for Anthropic keys', () => {
    // Any mention at all (shorthand, computed key, a spread) outside these two files fails,
    // not just the literal `canCallAnthropicDirect: true`.
    const files = sourceFiles(SRC)
      .filter((file) => fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').includes('canCallAnthropicDirect'))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .sort();
    expect(files).toEqual(['services/codingAgentService.ts', 'services/funding/callFunding.ts']);
    const caller = fs.readFileSync(path.join(SRC, 'services/codingAgentService.ts'), 'utf8');
    expect([...caller.matchAll(/canCallAnthropicDirect:\s*true/g)]).toHaveLength(1);
  });

  it('is opted in by the coding agent exactly once, on its own turns', () => {
    const source = read('services/codingAgentService.ts');
    expect([...source.matchAll(/customerRoutable:\s*true/g)]).toHaveLength(1);
    expect(source).toContain('resolveTurnFunding');
  });

  it('defaults to off, and only the agent\'s own working loop opts in inside the agent service', () => {
    const source = read('services/agentModeService.ts');
    expect(source).toMatch(/customerRoutable\s*=\s*false/);
    const optIns = [...source.matchAll(/customerRoutable:\s*true/g)];
    expect(optIns).toHaveLength(1);
    // Same options object as the loop's metering feature, so it cannot drift to a helper.
    const loopCall = source.indexOf("meteringFeature('agent_task'");
    expect(loopCall).toBeGreaterThan(-1);
    const distance = optIns[0].index! - loopCall;
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(1500);
  });
});
