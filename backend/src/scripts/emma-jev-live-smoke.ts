import '../emma/jevTools';
import { emmaToolRegistry } from '../emma/registry';
import { runJevDecide, readJevRuntimeConfig } from '../emma/jevAdapter';

const request = {
  state: {
    tool: 'post_on_connected_account',
    draft: 'Ship the Harsha P0 JEV path today — fail-open defaults, Greptile fixed same-day.',
    prior_edits: 2,
    platform: 'x',
  },
  questions: {
    route: {
      type: 'choice' as const,
      instructions: 'Should Emma publish this draft as-is, revise tone, or ask the user?',
      criteria: {
        publish: 'Tone and content are ready to post',
        revise: 'Needs voice/style edits before post',
        ask_user: 'Ambiguous or risky — confirm with user',
      },
    },
    confidence_ok: {
      type: 'noul' as const,
      instructions: 'Is this decision clear enough without a full LLM turn?',
      criteria: { true: 'Yes, JEV is sufficient', false: 'No, escalate to LLM' },
    },
  },
};

function summarize(label: string, result: any) {
  const answers = result.answers || {};
  const answerSummary = Object.fromEntries(
    Object.entries(answers).map(([k, v]: [string, any]) => {
      if (v?.type === 'choice') return [k, { type: v.type, choice: v.choice, confidence: v.confidence }];
      if (v?.type === 'noul') return [k, { type: v.type, noul: v.noul }];
      if (v?.type === 'score') return [k, { type: v.type, score: v.score, confidence: v.confidence }];
      return [k, v];
    }),
  );
  return {
    label,
    ok: result.ok,
    skipped: result.skipped,
    backend: result.backend,
    reason: result.reason,
    message: result.message,
    model: result.model,
    answers: answerSummary,
    usage: result.usage,
    type: result.type,
  };
}

async function main() {
  const cfg = readJevRuntimeConfig({
    ...process.env,
    JEV_BACKEND: 'typesafe',
    JEV_TIMEOUT_MS: '12000',
  });
  console.log(
    JSON.stringify(
      {
        phase: 'config',
        backend: cfg.backend,
        hasKey: Boolean(cfg.typesafeApiKey),
        keyLen: cfg.typesafeApiKey.length,
        baseUrl: cfg.typesafeBaseUrl,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
      },
      null,
      2,
    ),
  );

  const off = await runJevDecide(request as any, {
    config: { ...cfg, backend: 'off' },
  });
  console.log(JSON.stringify(summarize('adapter_off', off), null, 2));

  const live = await runJevDecide(request as any, { config: cfg });
  console.log(JSON.stringify(summarize('adapter_typesafe_live', live), null, 2));

  process.env.JEV_BACKEND = 'typesafe';
  process.env.JEV_TIMEOUT_MS = '12000';
  const tool = emmaToolRegistry.getTool('jev_decide');
  if (!tool) throw new Error('jev_decide not registered on emmaToolRegistry');
  const toolResult = await emmaToolRegistry.execute('jev_decide', request as any);
  console.log(JSON.stringify(summarize('emma_tool_registry', toolResult), null, 2));

  if (!live.ok || live.skipped) {
    console.error('LIVE_FAIL adapter did not return ok answers');
    process.exitCode = 2;
  }
  if (!toolResult.ok || toolResult.skipped) {
    console.error('LIVE_FAIL emma tool registry did not return ok answers');
    process.exitCode = 2;
  }
  if (off.ok || !off.skipped) {
    console.error('LIVE_FAIL off path should skip');
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('LIVE_ERROR', err?.message || err);
  process.exit(1);
});
