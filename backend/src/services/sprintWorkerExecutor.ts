import { spawn, ChildProcess } from 'child_process';

export interface SprintWorkerConfig {
  claudePath: string;
  repoPath: string;
  timeoutMs: number;
}

export interface TickResult {
  status: 'completed' | 'failed';
  summary?: string;
  error?: string;
  durationMs: number;
}

const MAX_SUMMARY_LENGTH = 2000;

const SPRINT_WORKER_PROMPT = `You are running as an autonomous Sprint Worker (Rule 13).

1. Query the Notion sprint board for the highest-priority "To-do" task in the Current Sprint.
   Sort by: Priority (High→Low) → Due Date (nearest first) → Sprint Points (smallest first).
   Skip Epics (13+ SP) and tasks with unmet blockers.
2. Update the task status to "In progress" in Notion.
3. Execute the task end-to-end per Rule 8:
   a. Write a plan as a Notion task comment
   b. Write TDD tests (min 3 FAIL + 1 SUCCESS), verify they fail
   c. Implement minimum code to pass all tests
   d. Verify all tests pass
   e. Open a PR with Notion task link in description
   f. Comment on Notion task with PR URL
   g. Update task status to "In Review"
4. Return a summary of what was done.

If no actionable tasks remain, report "No actionable tasks found" and exit.`;

export class SprintWorkerExecutor {
  private config: SprintWorkerConfig;

  constructor(config: SprintWorkerConfig) {
    this.config = config;
  }

  async executeTick(): Promise<TickResult> {
    const startTime = Date.now();

    return new Promise<TickResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const finish = (result: TickResult) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve(result);
      };

      let proc: ChildProcess;
      try {
        proc = spawn(
          this.config.claudePath,
          ['-p', SPRINT_WORKER_PROMPT, '--verbose'],
          {
            cwd: this.config.repoPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
          },
        );
      } catch (err: any) {
        finish({
          status: 'failed',
          error: err.message,
          durationMs: Date.now() - startTime,
        });
        return;
      }

      proc.on('error', (err: Error) => {
        finish({
          status: 'failed',
          error: err.message,
          durationMs: Date.now() - startTime,
        });
      });

      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      }

      proc.on('close', (code: number | null, signal: string | null) => {
        if (signal === 'SIGTERM') {
          finish({
            status: 'failed',
            error: `Execution timed out after ${this.config.timeoutMs}ms`,
            durationMs: Date.now() - startTime,
          });
          return;
        }

        if (code !== 0) {
          finish({
            status: 'failed',
            error: (stderr || `Process exited with code ${code}`).substring(0, MAX_SUMMARY_LENGTH),
            durationMs: Date.now() - startTime,
          });
          return;
        }

        finish({
          status: 'completed',
          summary: stdout.substring(0, MAX_SUMMARY_LENGTH),
          durationMs: Date.now() - startTime,
        });
      });

      // Timeout guard
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          proc.kill('SIGTERM');
        }
      }, this.config.timeoutMs);
    });
  }

  /**
   * Create an executor function compatible with LoopCoordinatorService.registerLoop
   */
  createExecutor(): () => Promise<any> {
    return async () => {
      const result = await this.executeTick();
      if (result.status === 'failed') {
        throw new Error(result.error || 'Sprint worker tick failed');
      }
      return result.summary;
    };
  }
}
