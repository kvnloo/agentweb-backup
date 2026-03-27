import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  claimTask,
  releaseTask,
  getAvailableSlots,
  isSwarmIdle,
  shouldTriggerQAHandoff,
  findStuckWorkers,
  createSwarmState,
} from '../workerCoordinator';
import { MAX_CONCURRENT_WORKERS } from '../types';
import {
  createWorkerState,
  createSwarmState as createTestSwarmState,
  resetCounters,
} from './helpers';

describe('workerCoordinator', () => {
  beforeEach(() => {
    resetCounters();
  });

  // =====================================================
  // createSwarmState
  // =====================================================
  describe('createSwarmState', () => {
    it('should create state with the specified number of workers', () => {
      const state = createSwarmState(3);
      expect(state.workers).toHaveLength(3);
    });

    it('should create workers in idle state', () => {
      const state = createSwarmState(2);
      for (const worker of state.workers) {
        expect(worker.status).toBe('idle');
        expect(worker.currentTaskId).toBeNull();
      }
    });

    it('should initialize with zero idle tick count', () => {
      const state = createSwarmState(1);
      expect(state.idleTickCount).toBe(0);
    });

    it('should initialize with empty active tasks', () => {
      const state = createSwarmState(3);
      expect(state.activeTasks.size).toBe(0);
    });

    it('should assign unique worker IDs', () => {
      const state = createSwarmState(3);
      const ids = state.workers.map(w => w.workerId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });

  // =====================================================
  // claimTask
  // =====================================================
  describe('claimTask', () => {
    it('should successfully claim a task for an idle worker', () => {
      const state = createSwarmState(2);
      const workerId = state.workers[0].workerId;
      const result = claimTask(state, workerId, 'task-1');
      expect(result.success).toBe(true);
    });

    it('should fail when worker already has a task', () => {
      const state = createSwarmState(1);
      const workerId = state.workers[0].workerId;
      // First claim succeeds
      claimTask(state, workerId, 'task-1');
      // Second claim should fail
      const result = claimTask(state, workerId, 'task-2');
      expect(result.success).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('should fail when task is already claimed by another worker', () => {
      const state = createSwarmState(2);
      // First worker claims task-1
      claimTask(state, state.workers[0].workerId, 'task-1');
      // Second worker tries same task
      const result = claimTask(state, state.workers[1].workerId, 'task-1');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('already claimed');
    });

    it('should fail when max concurrent workers reached', () => {
      const state = createSwarmState(MAX_CONCURRENT_WORKERS);
      // Claim tasks for all workers
      for (let i = 0; i < MAX_CONCURRENT_WORKERS; i++) {
        claimTask(state, state.workers[i].workerId, `task-${i}`);
      }
      // Add a new worker beyond the limit
      state.workers.push(createWorkerState({ workerId: 'extra-worker' }));
      const result = claimTask(state, 'extra-worker', 'task-extra');
      expect(result.success).toBe(false);
    });

    it('should fail for unknown worker ID', () => {
      const state = createSwarmState(1);
      const result = claimTask(state, 'nonexistent-worker', 'task-1');
      expect(result.success).toBe(false);
    });

    it('should update worker status to working after claim', () => {
      const state = createSwarmState(1);
      const workerId = state.workers[0].workerId;
      claimTask(state, workerId, 'task-1');
      const worker = state.workers.find(w => w.workerId === workerId);
      expect(worker?.status).toBe('working');
      expect(worker?.currentTaskId).toBe('task-1');
    });

    it('should add task to activeTasks map', () => {
      const state = createSwarmState(1);
      const workerId = state.workers[0].workerId;
      claimTask(state, workerId, 'task-1');
      expect(state.activeTasks.get('task-1')).toBe(workerId);
    });
  });

  // =====================================================
  // releaseTask
  // =====================================================
  describe('releaseTask', () => {
    it('should release a claimed task and set worker to idle', () => {
      const state = createSwarmState(1);
      const workerId = state.workers[0].workerId;
      claimTask(state, workerId, 'task-1');
      const newState = releaseTask(state, workerId, 'task-1');
      const worker = newState.workers.find(w => w.workerId === workerId);
      expect(worker?.status).toBe('idle');
      expect(worker?.currentTaskId).toBeNull();
    });

    it('should remove task from activeTasks map', () => {
      const state = createSwarmState(1);
      const workerId = state.workers[0].workerId;
      claimTask(state, workerId, 'task-1');
      const newState = releaseTask(state, workerId, 'task-1');
      expect(newState.activeTasks.has('task-1')).toBe(false);
    });

    it('should not affect other workers when releasing', () => {
      const state = createSwarmState(2);
      claimTask(state, state.workers[0].workerId, 'task-1');
      claimTask(state, state.workers[1].workerId, 'task-2');
      const newState = releaseTask(state, state.workers[0].workerId, 'task-1');
      const worker1 = newState.workers.find(w => w.workerId === state.workers[1].workerId);
      expect(worker1?.status).toBe('working');
      expect(worker1?.currentTaskId).toBe('task-2');
    });
  });

  // =====================================================
  // getAvailableSlots
  // =====================================================
  describe('getAvailableSlots', () => {
    it('should return max workers when no tasks are active and enough eligible tasks exist', () => {
      const state = createSwarmState(MAX_CONCURRENT_WORKERS);
      const slots = getAvailableSlots(state, 10);
      expect(slots).toBe(MAX_CONCURRENT_WORKERS);
    });

    it('should cap at eligible task count when fewer than max workers', () => {
      const state = createSwarmState(MAX_CONCURRENT_WORKERS);
      const slots = getAvailableSlots(state, 2);
      expect(slots).toBe(2);
    });

    it('should subtract active workers from available slots', () => {
      const state = createSwarmState(MAX_CONCURRENT_WORKERS);
      // Claim one task
      claimTask(state, state.workers[0].workerId, 'task-1');
      const slots = getAvailableSlots(state, 10);
      expect(slots).toBe(MAX_CONCURRENT_WORKERS - 1);
    });

    it('should return 0 when all slots are taken', () => {
      const state = createSwarmState(MAX_CONCURRENT_WORKERS);
      for (let i = 0; i < MAX_CONCURRENT_WORKERS; i++) {
        claimTask(state, state.workers[i].workerId, `task-${i}`);
      }
      expect(getAvailableSlots(state, 10)).toBe(0);
    });

    it('should return 0 when no eligible tasks', () => {
      const state = createSwarmState(MAX_CONCURRENT_WORKERS);
      expect(getAvailableSlots(state, 0)).toBe(0);
    });

    it('should never return negative numbers', () => {
      const state = createSwarmState(MAX_CONCURRENT_WORKERS);
      for (let i = 0; i < MAX_CONCURRENT_WORKERS; i++) {
        claimTask(state, state.workers[i].workerId, `task-${i}`);
      }
      expect(getAvailableSlots(state, 0)).toBe(0);
      expect(getAvailableSlots(state, -1)).toBe(0);
    });
  });

  // =====================================================
  // isSwarmIdle
  // =====================================================
  describe('isSwarmIdle', () => {
    it('should return true when all workers idle and no To-do tasks', () => {
      const state = createSwarmState(3);
      expect(isSwarmIdle(state, 0)).toBe(true);
    });

    it('should return false when workers are active', () => {
      const state = createSwarmState(3);
      claimTask(state, state.workers[0].workerId, 'task-1');
      expect(isSwarmIdle(state, 0)).toBe(false);
    });

    it('should return false when To-do tasks exist', () => {
      const state = createSwarmState(3);
      expect(isSwarmIdle(state, 5)).toBe(false);
    });

    it('should return false when both workers active and To-do tasks exist', () => {
      const state = createSwarmState(3);
      claimTask(state, state.workers[0].workerId, 'task-1');
      expect(isSwarmIdle(state, 3)).toBe(false);
    });
  });

  // =====================================================
  // shouldTriggerQAHandoff
  // =====================================================
  describe('shouldTriggerQAHandoff', () => {
    it('should return false on first idle tick', () => {
      const state = createSwarmState(1);
      state.idleTickCount = 1;
      expect(shouldTriggerQAHandoff(state, 0)).toBe(false);
    });

    it('should return true after consecutive idle threshold (default 2)', () => {
      const state = createSwarmState(1);
      state.idleTickCount = 2;
      expect(shouldTriggerQAHandoff(state, 0)).toBe(true);
    });

    it('should return false when To-do tasks still exist', () => {
      const state = createSwarmState(1);
      state.idleTickCount = 5;
      expect(shouldTriggerQAHandoff(state, 3)).toBe(false);
    });

    it('should respect custom threshold', () => {
      const state = createSwarmState(1);
      state.idleTickCount = 3;
      expect(shouldTriggerQAHandoff(state, 0, 5)).toBe(false);
      state.idleTickCount = 5;
      expect(shouldTriggerQAHandoff(state, 0, 5)).toBe(true);
    });

    it('should return false when workers are still active', () => {
      const state = createSwarmState(2);
      claimTask(state, state.workers[0].workerId, 'task-1');
      state.idleTickCount = 10;
      expect(shouldTriggerQAHandoff(state, 0)).toBe(false);
    });
  });

  // =====================================================
  // findStuckWorkers
  // =====================================================
  describe('findStuckWorkers', () => {
    it('should return empty array when no workers are stuck', () => {
      const state = createSwarmState(2);
      const stuck = findStuckWorkers(state);
      expect(stuck).toHaveLength(0);
    });

    it('should detect workers with no activity beyond threshold', () => {
      const state = createSwarmState(1);
      // Set worker to working with old activity timestamp
      state.workers[0].status = 'working';
      state.workers[0].currentTaskId = 'task-1';
      state.workers[0].lastActivityAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
      const stuck = findStuckWorkers(state, 60 * 60 * 1000); // 1 hour threshold
      expect(stuck).toHaveLength(1);
      expect(stuck[0].workerId).toBe(state.workers[0].workerId);
    });

    it('should not flag idle workers as stuck', () => {
      const state = createSwarmState(1);
      state.workers[0].lastActivityAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      // Worker is idle, not working — shouldn't be flagged
      const stuck = findStuckWorkers(state, 60 * 60 * 1000);
      expect(stuck).toHaveLength(0);
    });

    it('should use default threshold of 1 hour when not specified', () => {
      const state = createSwarmState(1);
      state.workers[0].status = 'working';
      state.workers[0].currentTaskId = 'task-1';
      // Set to 30 minutes ago — should NOT be stuck with 1hr default
      state.workers[0].lastActivityAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      expect(findStuckWorkers(state)).toHaveLength(0);

      // Set to 2 hours ago — SHOULD be stuck
      state.workers[0].lastActivityAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      expect(findStuckWorkers(state)).toHaveLength(1);
    });

    it('should return multiple stuck workers', () => {
      const state = createSwarmState(3);
      const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      for (const worker of state.workers) {
        worker.status = 'working';
        worker.currentTaskId = `task-${worker.workerId}`;
        worker.lastActivityAt = oldTime;
      }
      const stuck = findStuckWorkers(state, 60 * 60 * 1000);
      expect(stuck).toHaveLength(3);
    });

    it('should not flag blocked workers as stuck', () => {
      const state = createSwarmState(1);
      state.workers[0].status = 'blocked';
      state.workers[0].lastActivityAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      // Blocked is not 'working', so shouldn't be flagged
      expect(findStuckWorkers(state, 60 * 60 * 1000)).toHaveLength(0);
    });
  });

  // =====================================================
  // releaseTask — additional edge cases
  // =====================================================
  describe('releaseTask - edge cases', () => {
    it('should handle releasing a task that was never claimed', () => {
      const state = createSwarmState(1);
      const workerId = state.workers[0].workerId;
      // Release without prior claim — should not crash
      const newState = releaseTask(state, workerId, 'never-claimed');
      expect(newState.workers[0].status).toBe('idle');
    });

    it('should handle releasing with unknown worker ID', () => {
      const state = createSwarmState(1);
      // Should not crash
      const newState = releaseTask(state, 'unknown-worker', 'task-1');
      expect(newState.activeTasks.has('task-1')).toBe(false);
    });
  });

  // =====================================================
  // createSwarmState — edge cases
  // =====================================================
  describe('createSwarmState - edge cases', () => {
    it('should handle zero workers', () => {
      const state = createSwarmState(0);
      expect(state.workers).toHaveLength(0);
      expect(state.activeTasks.size).toBe(0);
    });

    it('should handle large number of workers', () => {
      const state = createSwarmState(100);
      expect(state.workers).toHaveLength(100);
    });
  });

  // =====================================================
  // claimTask — additional edge cases
  // =====================================================
  describe('claimTask - edge cases', () => {
    it('should allow re-claiming after release', () => {
      const state = createSwarmState(1);
      const workerId = state.workers[0].workerId;
      claimTask(state, workerId, 'task-1');
      releaseTask(state, workerId, 'task-1');
      const result = claimTask(state, workerId, 'task-2');
      expect(result.success).toBe(true);
    });

    it('should allow a different worker to claim a released task', () => {
      const state = createSwarmState(2);
      claimTask(state, state.workers[0].workerId, 'task-1');
      releaseTask(state, state.workers[0].workerId, 'task-1');
      const result = claimTask(state, state.workers[1].workerId, 'task-1');
      expect(result.success).toBe(true);
    });

    it('should track correct worker in activeTasks after reassignment', () => {
      const state = createSwarmState(2);
      claimTask(state, state.workers[0].workerId, 'task-1');
      releaseTask(state, state.workers[0].workerId, 'task-1');
      claimTask(state, state.workers[1].workerId, 'task-1');
      expect(state.activeTasks.get('task-1')).toBe(state.workers[1].workerId);
    });
  });

  // =====================================================
  // isSwarmIdle — additional edge cases
  // =====================================================
  describe('isSwarmIdle - edge cases', () => {
    it('should return true for zero workers and zero tasks', () => {
      const state = createSwarmState(0);
      expect(isSwarmIdle(state, 0)).toBe(true);
    });

    it('should handle single worker going idle→working→idle', () => {
      const state = createSwarmState(1);
      expect(isSwarmIdle(state, 0)).toBe(true);
      claimTask(state, state.workers[0].workerId, 'task-1');
      expect(isSwarmIdle(state, 0)).toBe(false);
      releaseTask(state, state.workers[0].workerId, 'task-1');
      expect(isSwarmIdle(state, 0)).toBe(true);
    });
  });

  // =====================================================
  // getAvailableSlots — additional edge cases
  // =====================================================
  describe('getAvailableSlots - edge cases', () => {
    it('should return 0 for zero workers', () => {
      const state = createSwarmState(0);
      expect(getAvailableSlots(state, 10)).toBe(0);
    });

    it('should return 1 when exactly 1 slot left and 1 eligible task', () => {
      const state = createSwarmState(MAX_CONCURRENT_WORKERS);
      for (let i = 0; i < MAX_CONCURRENT_WORKERS - 1; i++) {
        claimTask(state, state.workers[i].workerId, `task-${i}`);
      }
      expect(getAvailableSlots(state, 1)).toBe(1);
    });
  });
});
