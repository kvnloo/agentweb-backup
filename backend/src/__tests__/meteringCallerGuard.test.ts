/**
 * ENG-2108 (A2): every direct caller of the AgentWeb metering rails is classified.
 *
 * `meterUserUsage` / `meterUsageFromResponse` write to the usage tables, the per-user cap
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

/** file (relative to src) -> why it is correct for it to meter on the rails. */
const STAYS_AGENTWEB_PAID: Record<string, string> = {
  'utils/llmClients.ts': 'embeddings, search, video and factory auto-record: AgentWeb keys, not customer-routable (A2 PR 2 reclassifies any that get routed)',
  'utils/llmService.ts': 'AgentWeb-funded LLM helper',
  'utils/embeddings.ts': 'AgentWeb-funded embeddings (helpers stay AgentWeb-paid in v1)',
  'services/imageGeneration.ts': 'AgentWeb-funded until A2 PR 2 routes Gemini/DALL-E images',
  'services/videoGeneration.ts': 'Veo/Higgsfield: native-key BYOK is ENG-2130; Higgsfield stays AgentWeb',
  'services/liveVoiceService.ts': 'Live Voice: retain/migrate decision is ENG-2129',
  'emma/impl/video.ts': 'AgentWeb-funded describe_video until A2 PR 2 routes it',
  'emma/impl/searchResearch.ts': 'AgentWeb-funded search and research',
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

const CALL = /\b(meterUserUsage|meterUserUsageAsync|meterUsageFromResponse)\s*\(/;

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
