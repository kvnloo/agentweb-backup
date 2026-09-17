/**
 * Deterministic replays of production failures.
 *
 * Cases are pure input/output contracts. The scheduled caller supplies the
 * current implementation and the existing ENG-240 intake seam; this module
 * performs no network or third-party calls of its own.
 */

import {
  fileAutoIssue,
  type FileAutoIssueParams,
  type FiledAutoResult,
} from '../../services/intakeService';

export interface FailureReplayCase<TInput = unknown, TOutput = unknown> {
  id: string;
  incident: string;
  input: TInput;
  assert: (output: TOutput) => boolean;
  failure: string;
}

export interface FailureReplayResult {
  caseId: string;
  incident: string;
  passed: boolean;
  failure?: string;
  error?: string;
}

type Contract<TInput, TOutput> = (input: TInput) => TOutput | Promise<TOutput>;
type IssueFiler = (params: FileAutoIssueParams) => Promise<FiledAutoResult>;

export async function evaluateReplayCase<TInput, TOutput>(
  replayCase: FailureReplayCase<TInput, TOutput>,
  contract: Contract<TInput, TOutput>,
): Promise<FailureReplayResult> {
  try {
    const output = await contract(replayCase.input);
    const passed = replayCase.assert(output);
    return {
      caseId: replayCase.id,
      incident: replayCase.incident,
      passed,
      ...(passed ? {} : { failure: replayCase.failure }),
    };
  } catch (error) {
    return {
      caseId: replayCase.id,
      incident: replayCase.incident,
      passed: false,
      failure: replayCase.failure,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface FailureReplayRunResult {
  checked: number;
  failed: number;
  filed: number;
  deduped: number;
  results: FailureReplayResult[];
}

interface RunFailureReplaySuiteOptions<TInput, TOutput> {
  cases: readonly FailureReplayCase<TInput, TOutput>[];
  contract: Contract<TInput, TOutput>;
  fileIssue?: IssueFiler;
  now?: () => Date;
}

/** Scheduled-run entry point. Duplicate case IDs are collapsed before replay. */
export async function runFailureReplaySuite<TInput, TOutput>({
  cases,
  contract,
  fileIssue = fileAutoIssue,
  now = () => new Date(),
}: RunFailureReplaySuiteOptions<TInput, TOutput>): Promise<FailureReplayRunResult> {
  const uniqueCases = [...new Map(cases.map((replayCase) => [replayCase.id, replayCase])).values()];
  const results = await Promise.all(
    uniqueCases.map((replayCase) => evaluateReplayCase(replayCase, contract)),
  );
  const failures = results.filter((result) => !result.passed);
  let deduped = 0;

  for (const failure of failures) {
    const filed = await fileIssue({
      title: `fix(failure-replay): ${failure.incident} contract regressed`,
      description: [
        `**Detected by the scheduled failure replay suite on ${now().toISOString()}.**`,
        '',
        `Replay case: ${failure.caseId}`,
        `Historical incident: ${failure.incident}`,
        `Failure: ${failure.failure}`,
        ...(failure.error ? [`Error: ${failure.error}`] : []),
      ].join('\n'),
      source: 'failure-replay-suite scheduled runner',
      executionRoute: 'autofix',
      notionContext: {
        'Alert Class': `failure-replay:${failure.caseId}`,
        'Alert Priority': 'high',
        'Replay Case ID': failure.caseId,
        'Historical Incident': failure.incident,
      },
    });
    if (filed.deduped) deduped += 1;
  }

  return {
    checked: uniqueCases.length,
    failed: failures.length,
    filed: failures.length,
    deduped,
    results,
  };
}
