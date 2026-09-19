/**
 * Live smoke: AgentModeService.initialize → executeTool('jev_decide') → TypeSafe.
 * Real Emma tool dispatch path (not full LLM chat turn).
 *
 *   JEV_BACKEND=typesafe RELIABILITY_EVENT_SINK=memory \
 *   npx ts-node --transpile-only -O '{"module":"commonjs","moduleResolution":"node","esModuleInterop":true,"target":"ES2020"}' \
 *   src/scripts/emma-jev-agentmode-smoke.ts
 */
process.env.IS_MCP_SERVER = process.env.IS_MCP_SERVER || 'true';
process.env.JEV_BACKEND = process.env.JEV_BACKEND || 'typesafe';
process.env.JEV_TIMEOUT_MS = process.env.JEV_TIMEOUT_MS || '15000';
process.env.RELIABILITY_EVENT_SINK = process.env.RELIABILITY_EVENT_SINK || 'memory';
// Avoid AWS metadata timeouts when no credentials in local smoke.
process.env.AWS_EC2_METADATA_DISABLED = process.env.AWS_EC2_METADATA_DISABLED || 'true';

import { AgentModeService } from '../services/agentModeService';
import { getReliabilityEventSink } from '../services/reliabilityEventSink';

const request = {
  state: {
    scenario: 'live_agentmode_smoke',
    draft: 'Announce that Harsha P0 JEV landed on main with fail-open defaults.',
  },
  questions: {
    route: {
      type: 'choice' as const,
      instructions: 'Pick the next Emma action for this draft.',
      criteria: {
        publish: 'Ready to publish',
        revise: 'Needs rewrite',
        ask_user: 'Ask user first',
      },
    },
  },
};

function summarize(result: any) {
  const answers = result?.answers || {};
  return {
    type: result?.type,
    ok: result?.ok,
    skipped: result?.skipped,
    backend: result?.backend,
    reason: result?.reason,
    message: result?.message,
    model: result?.model,
    answers: Object.fromEntries(
      Object.entries(answers).map(([k, v]: [string, any]) => {
        if (v?.type === 'choice') return [k, { choice: v.choice, confidence: v.confidence }];
        if (v?.type === 'noul') return [k, { noul: v.noul }];
        return [k, v];
      }),
    ),
    usage: result?.usage,
  };
}

async function main() {
  getReliabilityEventSink().clear();
  const svc = new AgentModeService();
  await svc.initialize();
  console.log(JSON.stringify({ phase: 'init', isInitialized: svc.isInitialized }, null, 2));
  if (!svc.isInitialized) {
    console.error('AGENTMODE_LIVE_FAIL initialize did not latch');
    process.exit(2);
  }

  const result = await svc.executeTool(
    'gemini-3.8-flash',
    'jev_decide',
    request,
    'smoke-user',
    'smoke-session-jev',
    false,
  );

  const events = getReliabilityEventSink()
    .drain()
    .filter((e) => e.sessionId === 'smoke-session-jev' && e.tool === 'jev_decide');

  console.log(JSON.stringify({ phase: 'executeTool_jev_decide', result: summarize(result) }, null, 2));
  console.log(
    JSON.stringify(
      {
        phase: 'reliability_events',
        count: events.length,
        events: events.map((e) => ({
          tool: e.tool,
          outcome: e.outcome,
          latencyMs: e.latencyMs,
          sessionId: e.sessionId,
        })),
      },
      null,
      2,
    ),
  );

  let failed = false;
  if (!result?.ok || result?.skipped) {
    console.error('AGENTMODE_LIVE_FAIL jev_decide did not succeed via executeTool');
    failed = true;
  }
  if (events.length < 1 || events[0].outcome !== 'success') {
    console.error('AGENTMODE_LIVE_FAIL expected success reliability event for jev_decide');
    failed = true;
  }
  if (failed) process.exit(2);
  console.log(JSON.stringify({ phase: 'pass', message: 'AgentMode executeTool jev_decide live OK' }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('AGENTMODE_LIVE_ERROR', err?.stack || err?.message || err);
  process.exit(1);
});
