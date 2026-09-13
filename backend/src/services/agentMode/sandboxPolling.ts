import { isSandboxToken } from '../sandbox/sentinel';

/**
 * A sandbox (evaluation) account's access token is a sentinel the process-level Meta
 * simulator answers synchronously and locally, so an async insights report is already
 * "Job Completed" the instant it is created — there is no real Graph rate limit to
 * respect. Making a candidate wait through the product's real per-attempt poll delay
 * would make the sandbox feel broken (ENG-1908).
 */
export function sandboxAwarePollDelayMs(accessToken: string, realDelayMs: number): number {
  return isSandboxToken(accessToken) ? 0 : realDelayMs;
}
