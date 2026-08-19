/**
 * ENG-1210 AC14, step 1 — the model dimension on run verdicts.
 *
 * AC14 asks for "unchanged-behavior evidence for below-hard-cap calls". The
 * runway feature's whole premise is that a customer can be moved to a cheaper
 * model; the evidence that this was safe has to be per-model run outcomes over
 * time. We already grade every run (`agent_run_verdict`) and we already know the
 * model — but they live in two different events joined only by runId, so nothing
 * accrues an answer on its own.
 *
 * This stamps the model onto the verdict itself. No prompt or response content is
 * involved, which is what makes this half of AC14 buildable while the eval-harness
 * half waits on a content-retention decision.
 *
 * Two properties matter more than the plumbing:
 *
 *  1. THE MODEL MUST NOT REACH THE GRADE. `computeRunVerdict` stays a pure
 *     function of failure counts. If the model ever became an input, the metric
 *     would partly measure its own definition and per-model comparison would be
 *     circular. It is a dimension ON the record, never an input TO it.
 *
 *  2. A MID-RUN SUBSTITUTION MUST BE VISIBLE. On a transient LLM error the run
 *     falls back to a backup model and finishes under it
 *     (`agentModeService.ts` ~4200). Attributing that run's verdict to the backup
 *     alone is not merely imprecise, it is biased in the direction that matters:
 *     the fallback path is disproportionately degraded, so silently folding those
 *     runs in would make backup models look worse than they are — and "the cheap
 *     model is worse" is exactly the conclusion this evidence exists to test.
 *     So both models are recorded and the run is flagged, letting an analysis
 *     exclude substituted runs rather than be quietly skewed by them.
 */

import { AgentRunRecorder, computeRunVerdict } from '../loops/instances/agent-mode/runRecorder';
import { EVT_RUN_VERDICT } from '../loops/instances/agent-mode/eventTypes';
import type { ClockPort, DynamoPort } from '../loops/core/ports';

function fakeDynamo(): { port: DynamoPort; puts: Array<{ table: string; item: unknown }> } {
  const puts: Array<{ table: string; item: unknown }> = [];
  const port = {
    putItem: async (table: string, item: unknown) => {
      puts.push({ table, item });
    },
    getItem: async () => null,
    query: async () => ({ items: [] }),
  } as unknown as DynamoPort;
  return { port, puts };
}

const clock: ClockPort = { now: () => new Date('2026-08-18T08:00:00.000Z') };

const OPUS = 'anthropic.claude-opus-5';
const HAIKU = 'anthropic.claude-haiku-4-5';

/** The single verdict row the recorder wrote. */
function verdictDims(puts: Array<{ item: unknown }>): Record<string, unknown> {
  const row = puts.map((p) => p.item as any).find((i) => i.eventType === EVT_RUN_VERDICT);
  expect(row).toBeDefined();
  return row.dimensions;
}

describe('run verdict carries the model that produced it', () => {
  it('stamps the model on a completed run', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('run-1', { toolCalls: 6, failedToolCalls: 0, sessionId: 's1', llmModel: HAIKU });

    const dims = verdictDims(puts);
    expect(dims.llmModel).toBe(HAIKU);
    expect(dims.verdict).toBe('ok');
  });

  it('stamps the model on a failed run', async () => {
    // The failed path is where per-model differences show up first, so it must
    // carry the dimension too — not only the completed path.
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runFailed('run-2', {
      error: new Error('boom'),
      toolCalls: 1,
      failedToolCalls: 1,
      llmModel: HAIKU,
    });

    const dims = verdictDims(puts);
    expect(dims.llmModel).toBe(HAIKU);
    expect(dims.verdict).toBe('failed');
  });

  it('records the END-of-run model, and flags the run as substituted', async () => {
    // Started on Opus, a transient error forced the backup, finished on Haiku.
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('run-3', {
      toolCalls: 9,
      failedToolCalls: 4,
      llmModel: HAIKU,
      modelAtStart: OPUS,
    });

    const dims = verdictDims(puts);
    expect(dims.llmModel).toBe(HAIKU);
    expect(dims.modelAtStart).toBe(OPUS);
    expect(dims.modelSubstituted).toBe(true);
  });

  it('omits the substitution fields when the model never changed', async () => {
    // Absence is the signal: a row with no `modelSubstituted` is a clean
    // single-model run, which is what a per-model comparison should select on.
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('run-4', { toolCalls: 3, failedToolCalls: 0, llmModel: OPUS, modelAtStart: OPUS });

    const dims = verdictDims(puts);
    expect(dims.llmModel).toBe(OPUS);
    expect(dims).not.toHaveProperty('modelSubstituted');
    expect(dims).not.toHaveProperty('modelAtStart');
  });

  it('still records a verdict when the model is unknown', async () => {
    // Telemetry is best-effort and must never depend on an optional field being
    // present. Callers that predate this (or mock partially) still grade runs.
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('run-5', { toolCalls: 10, failedToolCalls: 4 });

    const dims = verdictDims(puts);
    expect(dims.verdict).toBe('degraded');
    expect(dims).not.toHaveProperty('llmModel');
    expect(dims).not.toHaveProperty('modelSubstituted');
  });

  it('does not claim a substitution it cannot verify', async () => {
    // A start model with no end model cannot be compared. Recording
    // `modelAtStart` alone would read as "the model this run ran under", which is
    // precisely what is not known here.
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('run-6', { toolCalls: 2, failedToolCalls: 0, modelAtStart: OPUS });

    const dims = verdictDims(puts);
    expect(dims).not.toHaveProperty('llmModel');
    expect(dims).not.toHaveProperty('modelAtStart');
    expect(dims).not.toHaveProperty('modelSubstituted');
  });

  it('grades identically regardless of model — the model is a dimension, not an input', async () => {
    // The load-bearing test. If a future change ever made the verdict depend on
    // the model, per-model outcome rates would be measuring their own definition
    // and could never falsify "the cheaper model is fine".
    const { port: p1, puts: opusPuts } = fakeDynamo();
    const { port: p2, puts: haikuPuts } = fakeDynamo();
    const counts = { toolCalls: 9, failedToolCalls: 3, maxSameToolFailures: 3 };

    await new AgentRunRecorder(p1, clock).runCompleted('run-7', { ...counts, llmModel: OPUS });
    await new AgentRunRecorder(p2, clock).runCompleted('run-8', { ...counts, llmModel: HAIKU });

    const opus = verdictDims(opusPuts);
    const haiku = verdictDims(haikuPuts);
    expect(opus.verdict).toBe(haiku.verdict);
    expect(opus.reasons).toEqual(haiku.reasons);

    // And the pure function itself takes no model at all.
    expect(computeRunVerdict({ failed: false, ...counts }).verdict).toBe('degraded');
  });

  it('gives the terminal event the same model fields, meaning the same thing', async () => {
    // Both events are written for every run, and an analyst may reach for either.
    // If `modelAtStart` were unconditional on one and substitution-only on the
    // other, the same attribute name would mean two different things.
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('run-10', { toolCalls: 2, failedToolCalls: 0, llmModel: OPUS, modelAtStart: OPUS });
    const completed = puts.map((p) => p.item as any).find((i) => i.eventType === 'agent_run_completed');

    expect(completed.dimensions.llmModel).toBe(OPUS);
    expect(completed.dimensions).not.toHaveProperty('modelAtStart');
    expect(completed.dimensions).not.toHaveProperty('modelSubstituted');
  });

  it('carries the model onto the failed terminal event too', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runFailed('run-11', { error: new Error('boom'), llmModel: HAIKU, modelAtStart: OPUS });
    const failedEvent = puts.map((p) => p.item as any).find((i) => i.eventType === 'agent_run_failed');

    expect(failedEvent.dimensions.llmModel).toBe(HAIKU);
    expect(failedEvent.dimensions.modelSubstituted).toBe(true);
    // BOTH sides of the substitution, not just the end state. A failed run is
    // where the pair matters most: "Haiku failed" and "Opus failed, then Haiku
    // failed too" are different findings, and only `modelAtStart` separates them.
    expect(failedEvent.dimensions.modelAtStart).toBe(OPUS);
    // The error detail the failed event already carried must survive.
    expect(failedEvent.dimensions.errorMessage).toContain('boom');
  });

  it('keeps the existing verdict dimensions intact', async () => {
    // Consumers (failureRuleSet, agentRunInspectorService) read these by name;
    // adding dimensions must not disturb them.
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('run-9', {
      toolCalls: 10,
      failedToolCalls: 4,
      maxSameToolFailures: 2,
      sessionId: 's9',
      claimMismatch: true,
      llmModel: HAIKU,
    });

    const dims = verdictDims(puts);
    expect(dims.verdict).toBe('degraded');
    expect(String(dims.reasons)).toContain('claim_mismatch');
    expect(dims.toolCalls).toBe(10);
    expect(dims.failedToolCalls).toBe(4);
    expect(dims.maxSameToolFailures).toBe(2);
    expect(dims.sessionId).toBe('s9');
  });
});
