/**
 * Execute ENG-1423's synthetic incumbent-model baseline fixtures.
 *
 * Reads the existing OpenRouter credential, performs no AgentWeb DB writes,
 * and writes only sanitized fixture metadata plus observed metrics. The model
 * is an explicit canonical logical ID so this fixture layer cannot become a
 * second model registry or routing policy.
 * OpenRouter credentials remain in memory and are never included in output.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node src/loops/scripts/runOpenRouterBaseline.ts \
 *     --model openrouter/provider/model --revision <git-sha> \
 *     --out <artifact.json> [--fixture <fixture-id>]
 */
import * as fs from 'fs';
import * as path from 'path';
import { getSecret } from '../../utils/secretsManager';
import { getOpenAIClient } from '../../utils/llmClients';
import {
  BASELINE_FIXTURES,
  applyOpenRouterGenerationDetail,
  buildBaselineRequest,
  getBaselineFixture,
  observeBaselineFixture,
  pollOpenRouterGenerationDetail,
  validateBaselineArtifact,
  type BaselineArtifact,
  type BaselineFixture,
  type GenerationDetailResponse,
} from '../eval/openRouterBaselineEvidence';

interface CliOptions {
  revision: string;
  out: string;
  model: string;
  fixtureId?: string;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    return next && !next.startsWith('--') ? next : undefined;
  };
  const revision = value('--revision');
  const out = value('--out');
  const model = value('--model');
  if (!revision || !/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error('--revision must be a git SHA');
  if (!out) throw new Error('--out is required');
  if (!model?.startsWith('openrouter/') || model.split('/').length < 3) {
    throw new Error('--model must be a canonical openrouter/provider/model logical ID');
  }
  return { revision, out, model, ...(value('--fixture') ? { fixtureId: value('--fixture') } : {}) };
}

function openRouterGenerationFetcher(apiKey: string): (generationId: string) => Promise<GenerationDetailResponse> {
  return async (generationId: string): Promise<GenerationDetailResponse> => {
    const url = new URL('https://openrouter.ai/api/v1/generation');
    url.searchParams.set('id', generationId);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

async function executeFixture(
  fixture: BaselineFixture,
  logicalModel: string,
  client: any,
  fetchDetail: (generationId: string) => Promise<GenerationDetailResponse>,
): Promise<BaselineArtifact> {
  const request = buildBaselineRequest(fixture, logicalModel);
  let responseId: string | undefined;
  const artifact = await observeBaselineFixture(fixture.fixtureId, logicalModel, async () => {
    const response: any = await client.chat.completions.create(request, { timeout: 45_000, maxRetries: 0 });
    responseId = typeof response?.id === 'string' ? response.id : undefined;
    return response;
  });

  if (!responseId) throw new Error(`Fixture ${fixture.fixtureId} OpenRouter response omitted generation id`);
  const detail = await pollOpenRouterGenerationDetail(responseId, fetchDetail, {
    // OpenRouter indexing is asynchronous; live QA observed records appearing
    // after the initial 7.5-second window. Stay bounded while allowing 30s.
    maxAttempts: 30,
    delayMs: 1_000,
  });
  const correlated = applyOpenRouterGenerationDetail(artifact, detail);
  const errors = validateBaselineArtifact(correlated);
  if (errors.length > 0) throw new Error(`Fixture ${fixture.fixtureId} artifact is incomplete: ${errors.join('; ')}`);
  return correlated;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = options.fixtureId
    ? [getBaselineFixture(options.fixtureId)].filter((fixture): fixture is BaselineFixture => Boolean(fixture))
    : [...BASELINE_FIXTURES];
  if (options.fixtureId && fixtures.length === 0) throw new Error(`Unknown fixture: ${options.fixtureId}`);

  const apiKey = await getSecret('prod/AgentWeb/OpenRouter');
  if (!apiKey) throw new Error('OpenRouter credential is unavailable');
  const client = getOpenAIClient(
    { feature: 'eng1423_baseline' },
    {
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: { 'HTTP-Referer': 'https://agentweb.pro', 'X-Title': 'AgentWeb ENG-1423 Baseline' },
    },
    { metered: false },
  );
  const fetchDetail = openRouterGenerationFetcher(apiKey);

  const artifacts: BaselineArtifact[] = [];
  const failures: Array<{ fixtureId: string; error: string }> = [];
  for (const fixture of fixtures) {
    // Serial by design: bounded spend, deterministic attribution, low RAM.
    try {
      artifacts.push(await executeFixture(fixture, options.model, client, fetchDetail));
    } catch (error) {
      failures.push({
        fixtureId: fixture.fixtureId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const output = {
    schemaVersion: 1,
    revision: options.revision,
    generatedAt: new Date().toISOString(),
    source: 'executable synthetic fixtures + explicit logical model + OpenRouter generation detail',
    artifacts,
    ...(failures.length > 0 ? { failures } : {}),
  };
  const outputPath = path.resolve(options.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`Wrote ${artifacts.length} observed baseline artifact(s) to ${outputPath}\n`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} fixture(s) failed; see ${outputPath}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
