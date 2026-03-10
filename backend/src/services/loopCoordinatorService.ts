import { v4 as uuidv4 } from 'uuid';
import { loopDb } from './db';

export type OnLoopFailure = (loopId: string, loopName: string, error: string, runId: string) => Promise<void>;

export interface LoopDefinition {
  id: string;
  name: string;
  intervalMs: number;
  executor: () => Promise<any>;
}

interface LoopState {
  definition: LoopDefinition;
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  executing: boolean; // prevents overlapping executions
}

export interface LoopStatus {
  id: string;
  name: string;
  running: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  lastStatus: string | null;
}

export class LoopCoordinatorService {
  private loops: Map<string, LoopState> = new Map();
  private onFailure: OnLoopFailure | null = null;

  setOnFailure(handler: OnLoopFailure): void {
    this.onFailure = handler;
  }

  registerLoop(definition: LoopDefinition): void {
    if (this.loops.has(definition.id)) {
      throw new Error(`Loop "${definition.id}" is already registered`);
    }
    this.loops.set(definition.id, {
      definition,
      running: false,
      timer: null,
      lastRunAt: null,
      lastStatus: null,
      executing: false,
    });
  }

  async startLoop(loopId: string): Promise<void> {
    const state = this.loops.get(loopId);
    if (!state) {
      throw new Error(`Loop "${loopId}" is not registered`);
    }
    if (state.running) {
      throw new Error(`Loop "${loopId}" is already running`);
    }

    state.running = true;

    // Run immediately, then on interval
    this.executeLoop(state);
    state.timer = setInterval(() => this.executeLoop(state), state.definition.intervalMs);
  }

  async stopLoop(loopId: string): Promise<void> {
    const state = this.loops.get(loopId);
    if (!state) {
      throw new Error(`Loop "${loopId}" is not registered`);
    }
    if (!state.running) {
      throw new Error(`Loop "${loopId}" is not running`);
    }

    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    state.running = false;
  }

  getStatus(): LoopStatus[] {
    return Array.from(this.loops.values()).map((state) => ({
      id: state.definition.id,
      name: state.definition.name,
      running: state.running,
      intervalMs: state.definition.intervalMs,
      lastRunAt: state.lastRunAt,
      lastStatus: state.lastStatus,
    }));
  }

  getLoopStatus(loopId: string): LoopStatus | null {
    const state = this.loops.get(loopId);
    if (!state) return null;
    return {
      id: state.definition.id,
      name: state.definition.name,
      running: state.running,
      intervalMs: state.definition.intervalMs,
      lastRunAt: state.lastRunAt,
      lastStatus: state.lastStatus,
    };
  }

  async shutdown(): Promise<void> {
    for (const [loopId, state] of this.loops) {
      if (state.running) {
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
        state.running = false;
      }
    }
  }

  private async executeLoop(state: LoopState): Promise<void> {
    // Skip if already executing (prevents overlap on slow executors)
    if (state.executing) return;
    state.executing = true;

    const runId = uuidv4();
    const startedAt = new Date().toISOString();

    try {
      await loopDb.createLoopRun({
        runId,
        loopId: state.definition.id,
        loopName: state.definition.name,
        startedAt,
        status: 'running',
      });

      const result = await state.definition.executor();

      const finishedAt = new Date().toISOString();
      state.lastRunAt = finishedAt;
      state.lastStatus = 'completed';

      await loopDb.updateLoopRun(runId, {
        status: 'completed',
        finishedAt,
        resultSummary: typeof result === 'string' ? result : JSON.stringify(result)?.substring(0, 1000),
      });
    } catch (error: any) {
      const finishedAt = new Date().toISOString();
      state.lastRunAt = finishedAt;
      state.lastStatus = 'failed';

      await loopDb.updateLoopRun(runId, {
        status: 'failed',
        finishedAt,
        error: error.message || 'Unknown error',
      }).catch((e: any) => console.error('Failed to update loop run:', e));

      console.error(`Loop "${state.definition.id}" execution failed:`, error.message);

      // Trigger escalation callback if configured
      if (this.onFailure) {
        this.onFailure(state.definition.id, state.definition.name, error.message || 'Unknown error', runId)
          .catch((e: any) => console.error('Escalation callback failed:', e));
      }
    } finally {
      state.executing = false;
    }
  }
}

export const loopCoordinatorService = new LoopCoordinatorService();
