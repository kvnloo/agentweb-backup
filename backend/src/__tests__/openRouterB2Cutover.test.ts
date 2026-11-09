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

describe('ENG-1431/1432 OpenRouter B2 cutover', () => {
  it('routes scheduled/background callers through callLLM instead of direct Azure or Gemini clients', () => {
    assertUsesSharedGatewayOnly([
      'cron/socialEngagementExecutor.ts',
      'cron/linkedInConnectionSyncCron.ts',
      'routes/crm.ts',
      'routes/tasks.ts',
      'services/workflowGenerator.ts',
      'services/reportRevisionService.ts',
      'services/inviteNoteShortener.ts',
    ]);
  });

  it('routes content and API text generation through callLLM instead of native provider clients', () => {
    assertUsesSharedGatewayOnly([
      'controllers/blog.ts',
      'routes/slack.ts',
      'services/deepResearchService.ts',
    ]);
  });

  it('routes enrichment, judge, RCA, and shared LLM callers through callLLM', () => {
    assertUsesSharedGatewayOnly([
      'services/crmEnrichmentService.ts',
      'services/enrichmentFieldAliasService.ts',
      'services/enrichmentClusterService.ts',
      'loops/instances/ai-eval-funnel/rcaEnricher.ts',
    ]);

    assertUsesSharedGatewayOnly(['utils/llmService.ts']);
    expect(read('utils/llmService.ts')).toContain('webSearch: true');
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

  it('uses one gateway timeout policy after direct provider wrappers are removed', () => {
    const agentModeService = read('services/agentModeService.ts');
    expect(agentModeService).toMatch(/maxRetries:\s*0,\s*timeout:\s*5 \* 60 \* 1000/);
    expect(agentModeService).not.toMatch(/VERTEX_REQUEST_TIMEOUT_MS|BEDROCK_REQUEST_TIMEOUT_MS/);
  });
});
