import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.join(__dirname, '..');

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');

const FORBIDDEN_TEXT_PROVIDER_PATHS = [
  /getAzureClient/,
  /getGeminiClient/,
  /getClientForModel/,
  /getBedrockClient/,
  /meterUsageFromResponse/,
  /BedrockRuntimeClient/,
  /AzureChatOpenAI/,
  /ChatBedrockConverse/,
  /\.chat\.completions\.create\(/,
  /\.models\.generateContent\(/,
] as const;

const assertUsesSharedGatewayOnly = (
  files: readonly string[],
): void => {
  const offenders: string[] = [];
  for (const file of files) {
    const source = read(file);
    if (!/\.callLLM\s*\(/.test(source)) offenders.push(`${file}: missing callLLM`);
    for (const pattern of FORBIDDEN_TEXT_PROVIDER_PATHS) {
      if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
    }
  }
  expect(offenders).toEqual([]);
};

describe('ENG-1431 OpenRouter B2 cutover', () => {
  it('routes scheduled/background callers through callLLM instead of direct Azure or Gemini clients', () => {
    assertUsesSharedGatewayOnly([
      'cron/socialEngagementExecutor.ts',
      'cron/linkedInConnectionSyncCron.ts',
      'routes/crm.ts',
      'routes/tasks.ts',
      'services/workflowGenerator.ts',
      'services/growthGeniusService.ts',
      'services/reportRevisionService.ts',
      'services/inviteNoteShortener.ts',
    ]);
  });

  it('routes content and API text generation through callLLM instead of native provider clients', () => {
    assertUsesSharedGatewayOnly([
      'controllers/blog.ts',
      'routes/slack.ts',
    ]);
  });

  it('routes enrichment, judge, RCA, and shared LLM callers through callLLM', () => {
    assertUsesSharedGatewayOnly([
      'services/crmEnrichmentService.ts',
      'services/enrichmentFieldAliasService.ts',
      'services/enrichmentClusterService.ts',
      'loops/instances/ai-eval-funnel/rcaEnricher.ts',
    ]);

    // llmService retains exactly one provider-native web-search method until
    // ENG-1432 proves the OpenRouter web plugin; its ordinary path is callLLM.
    const sharedService = read('utils/llmService.ts');
    expect(sharedService).toMatch(/\.callLLM\s*\(/);
    expect(sharedService.match(/\.models\.generateContent\s*\(/g)).toHaveLength(1);
    for (const pattern of FORBIDDEN_TEXT_PROVIDER_PATHS.filter(
      (candidate) => String(candidate) !== String(/\.models\.generateContent\(/),
    )) {
      expect(sharedService).not.toMatch(pattern);
    }
  });

  it('routes the LinkedIn title-company parser through callLLM instead of a direct Gemini client', () => {
    const source = read('services/agentModeService.ts');
    expect(source).not.toMatch(/getClientForModel\('gemini-2\.5-flash'\)/);
    expect(source).not.toMatch(/model:\s*'gemini-2\.5-flash'/);
    expect(source).toContain("taskClass: 'nonstandard_consumer'");
  });

  it('keeps the documented Gemini Live voice exception outside the text gateway', () => {
    const source = read('services/liveVoiceService.ts');
    expect(source).toMatch(/\.live\.connect\s*\(/);
    for (const pattern of FORBIDDEN_TEXT_PROVIDER_PATHS) {
      expect(source).not.toMatch(pattern);
    }
  });

  it('propagates caller timeouts through every provider wrapper', () => {
    const agentModeService = read('services/agentModeService.ts');
    const geminiNativeClient = read('services/agentMode/core/geminiNativeClient.ts');
    expect(geminiNativeClient).toMatch(/requestTimeoutMs:\s*requestOptions\?\.timeout/);
    expect(agentModeService).toMatch(/setTimeout\([\s\S]{0,100}requestOptions\?\.timeout\s*\?\?\s*VERTEX_REQUEST_TIMEOUT_MS/);
    expect(agentModeService).toMatch(/AbortSignal\.timeout\(requestOptions\?\.timeout\s*\?\?\s*BEDROCK_REQUEST_TIMEOUT_MS\)/);
  });
});
