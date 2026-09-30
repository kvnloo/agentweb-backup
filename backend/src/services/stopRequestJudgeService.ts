import { agentModeService } from './agentModeService';
import type { LLMUsageContext } from '../utils/llmService';

export const STOP_REQUEST_JUDGE_MODEL = 'gemini-3.1-flash-lite';
export const STOP_REQUEST_JUDGE_TIMEOUT_MS = 8000;
export const STOP_REQUEST_JUDGE_SYSTEM = `You classify one message from a user talking to an AI assistant that is running a multi-step work plan on their behalf.

Decide whether the user's message explicitly asks the assistant to STOP or to NOT do any more work right now — as opposed to a normal instruction, question, or request to continue/proceed.

Answer "yes" when the message clearly asks to halt, pause, wait, not continue, or do no further work without being asked again — even if phrased casually ("that's enough for now", "hold off", "don't keep going").

Answer "no" for everything else, including ordinary requests, questions, corrections, or instructions that do not ask the assistant to stop.

Reply with ONLY one word: yes or no.`;

export interface StopRequestIncumbentResult {
  stop: boolean;
  failed: boolean;
  truncated: boolean;
  latency_ms: number;
}

export async function runStopRequestIncumbentJudge(
  content: string,
  usageContext?: LLMUsageContext,
): Promise<StopRequestIncumbentResult> {
  const startedAt = Date.now();
  try {
    const llmPromise = agentModeService.callLLM(
      STOP_REQUEST_JUDGE_MODEL,
      [
        { role: 'system', content: STOP_REQUEST_JUDGE_SYSTEM },
        { role: 'user', content: content.slice(0, 2500) },
      ],
      {
        temperature: 0,
        max_completion_tokens: 500,
        taskClass: 'scheduled_background',
        usageContext: usageContext ?? { feature: 'stop_request_judge' },
      },
    );
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('stop-request judge timed out')),
        STOP_REQUEST_JUDGE_TIMEOUT_MS,
      ),
    );
    const res: any = await Promise.race([llmPromise, timeoutPromise]);
    const truncated = res?.choices?.[0]?.finish_reason === 'length';
    const raw = (res?.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
    return {
      stop: raw.startsWith('yes'),
      failed: false,
      truncated,
      latency_ms: Date.now() - startedAt,
    };
  } catch {
    return {
      stop: false,
      failed: true,
      truncated: false,
      latency_ms: Date.now() - startedAt,
    };
  }
}
