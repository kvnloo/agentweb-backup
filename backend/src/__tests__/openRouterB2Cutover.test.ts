import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.join(__dirname, '..');

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');

const assertUsesSharedGatewayOnly = (
  files: readonly string[],
  forbidden: readonly RegExp[],
): void => {
  const offenders: string[] = [];
  for (const file of files) {
    const source = read(file);
    for (const pattern of forbidden) {
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
    ], [
      /getAzureClient/,
      /getGeminiClient/,
      /meterUsageFromResponse/,
      /\.chat\.completions\.create\(/,
    ]);
  });

  it('routes content and API text generation through callLLM instead of native provider clients', () => {
    assertUsesSharedGatewayOnly([
      'controllers/blog.ts',
      'routes/slack.ts',
    ], [
      /getGeminiClient/,
      /\.models\.generateContent\(/,
      /meterUsageFromResponse/,
    ]);
  });

  it('routes enrichment, judge, RCA, and shared LLM callers through callLLM', () => {
    assertUsesSharedGatewayOnly([
      'services/crmEnrichmentService.ts',
      'services/enrichmentFieldAliasService.ts',
      'services/enrichmentClusterService.ts',
      'loops/instances/ai-eval-funnel/rcaEnricher.ts',
      'utils/llmService.ts',
    ], [
      /getClientForModel/,
      /getBedrockClient/,
      /meterUsageFromResponse/,
      /BedrockRuntimeClient/,
      /AzureChatOpenAI/,
      /ChatBedrockConverse/,
    ]);
  });

  it('keeps the documented Gemini Live voice exception outside the text gateway', () => {
    expect(read('services/liveVoiceService.ts')).toContain('ai.live.connect');
  });
});
