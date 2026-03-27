/**
 * Swarm Pipeline — Worker Coordinator
 *
 * Manages worker concurrency, task claiming, and idle detection.
 * Max 3 concurrent sprint workers, each claims one task at a time.
 */

import {
  WorkerState,
  SwarmState,
  MAX_CONCURRENT_WORKERS,
} from './types';

/**
 * Claim a task for a worker. Returns true if claim succeeded.
 * Fails if:
 * - Task is already claimed by another worker
 * - Worker already has a task
 * - Max concurrent workers reached
 */
export function claimTask(
  state: SwarmState,
  workerId: string,
  taskId: string
): { success: boolean; reason?: string } {
  const worker = state.workers.find(w => w.workerId === workerId);
  if (!worker) return { success: false, reason: 'Worker not found' };

  const activeCount = state.workers.filter(w => w.status === 'working').length;
  if (activeCount >= MAX_CONCURRENT_WORKERS) return { success: false, reason: 'Max concurrent workers reached' };

  if (worker.currentTaskId !== null) return { success: false, reason: 'Worker already has a task' };

  if (state.activeTasks.has(taskId)) return { success: false, reason: 'Task already claimed by another worker' };

  worker.status = 'working';
  worker.currentTaskId = taskId;
  worker.lastActivityAt = new Date().toISOString();
  state.activeTasks.set(taskId, workerId);
  return { success: true };
}

/**
 * Release a task after completion or failure.
 */
export function releaseTask(
  state: SwarmState,
  workerId: string,
  taskId: string
): SwarmState {
  const worker = state.workers.find(w => w.workerId === workerId);
  if (worker) {
    worker.status = 'idle';
    worker.currentTaskId = null;
    worker.lastActivityAt = new Date().toISOString();
  }
  state.activeTasks.delete(taskId);
  return state;
}

/**
 * Calculate the number of available worker slots.
 * Formula: Min(unblocked non-High-Risk To-do tasks, MAX_CONCURRENT_WORKERS) - active workers
 */
export function getAvailableSlots(
  state: SwarmState,
  eligibleTaskCount: number
): number {
  const activeCount = state.workers.filter(w => w.status === 'working').length;
  const maxAllowed = Math.min(state.workers.length, MAX_CONCURRENT_WORKERS);
  const freeSlots = maxAllowed - activeCount;
  const available = Math.min(eligibleTaskCount, freeSlots);
  return Math.max(0, available);
}

/**
 * Detect if the swarm is idle.
 * Idle = all workers idle + no To-do tasks in Current Sprint.
 */
export function isSwarmIdle(
  state: SwarmState,
  todoTaskCount: number
): boolean {
  return state.workers.every(w => w.status === 'idle') && todoTaskCount === 0;
}

/**
 * Detect if the swarm should trigger QA handoff.
 * Requires consecutive idle ticks (not just one).
 */
export function shouldTriggerQAHandoff(
  state: SwarmState,
  todoTaskCount: number,
  consecutiveIdleThreshold: number = 2
): boolean {
  return isSwarmIdle(state, todoTaskCount) && state.idleTickCount >= consecutiveIdleThreshold;
}

/**
 * Detect stuck workers (no activity for > threshold).
 */
export function findStuckWorkers(
  state: SwarmState,
  stuckThresholdMs: number = 60 * 60 * 1000
): WorkerState[] {
  const now = Date.now();
  return state.workers.filter(
    w => w.status === 'working' && (now - new Date(w.lastActivityAt).getTime()) > stuckThresholdMs
  );
}

/**
 * Create initial swarm state.
 */
export function createSwarmState(workerCount: number): SwarmState {
  const now = new Date().toISOString();
  const workers: WorkerState[] = Array.from({ length: workerCount }, (_, i) => ({
    workerId: `worker-${i}`,
    currentTaskId: null,
    status: 'idle' as const,
    lastActivityAt: now,
  }));
  return {
    workers,
    activeTasks: new Map(),
    idleTickCount: 0,
    lastTickAt: now,
  };
}
