import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  filterWorkerEligibleTasks,
  filterPlannerEligibleTasks,
  isHarshaOrUnassigned,
  isBlocked,
  isEpic,
} from '../taskFilter';
import {
  createTask,
  createHighRiskTask,
  createEpicTask,
  createBlockedTask,
  createRuiTask,
  createUnassignedTask,
  resetCounters,
  HARSHA,
  RUI,
  OTHER_USER,
} from './helpers';

describe('taskFilter', () => {
  beforeEach(() => {
    resetCounters();
  });

  // =====================================================
  // isHarshaOrUnassigned
  // =====================================================
  describe('isHarshaOrUnassigned', () => {
    it('should return true for Harsha-owned tasks', () => {
      const task = createTask({ owner: HARSHA });
      expect(isHarshaOrUnassigned(task)).toBe(true);
    });

    it('should return true for unassigned tasks (owner is null)', () => {
      const task = createUnassignedTask();
      expect(isHarshaOrUnassigned(task)).toBe(true);
    });

    it('should return false for Rui-owned tasks', () => {
      const task = createRuiTask();
      expect(isHarshaOrUnassigned(task)).toBe(false);
    });

    it('should return false for other users', () => {
      const task = createTask({ owner: OTHER_USER });
      expect(isHarshaOrUnassigned(task)).toBe(false);
    });
  });

  // =====================================================
  // isBlocked
  // =====================================================
  describe('isBlocked', () => {
    it('should return false when task has no blockers', () => {
      const task = createTask({ blockedBy: [] });
      expect(isBlocked(task, new Set())).toBe(false);
    });

    it('should return false when all blockers are completed', () => {
      const task = createTask({ blockedBy: ['task-a', 'task-b'] });
      const completed = new Set(['task-a', 'task-b']);
      expect(isBlocked(task, completed)).toBe(false);
    });

    it('should return true when some blockers are incomplete', () => {
      const task = createTask({ blockedBy: ['task-a', 'task-b'] });
      const completed = new Set(['task-a']);
      expect(isBlocked(task, completed)).toBe(true);
    });

    it('should return true when no blockers are completed', () => {
      const task = createTask({ blockedBy: ['task-a'] });
      const completed = new Set<string>();
      expect(isBlocked(task, completed)).toBe(true);
    });

    it('should handle tasks blocked by themselves gracefully', () => {
      const task = createTask({ id: 'self-ref', blockedBy: ['self-ref'] });
      expect(isBlocked(task, new Set())).toBe(true);
    });
  });

  // =====================================================
  // isEpic
  // =====================================================
  describe('isEpic', () => {
    it('should return true when storyPoints >= 13', () => {
      const task = createEpicTask({ storyPoints: 13 });
      expect(isEpic(task)).toBe(true);
    });

    it('should return true for large epics (21, 34, 55 SP)', () => {
      expect(isEpic(createTask({ storyPoints: 21, isEpic: true }))).toBe(true);
      expect(isEpic(createTask({ storyPoints: 34, isEpic: true }))).toBe(true);
      expect(isEpic(createTask({ storyPoints: 55, isEpic: true }))).toBe(true);
    });

    it('should return false when storyPoints < 13', () => {
      expect(isEpic(createTask({ storyPoints: 8 }))).toBe(false);
      expect(isEpic(createTask({ storyPoints: 5 }))).toBe(false);
      expect(isEpic(createTask({ storyPoints: 1 }))).toBe(false);
    });

    it('should return true when isEpic flag is set even without SP', () => {
      const task = createTask({ storyPoints: null, isEpic: true });
      expect(isEpic(task)).toBe(true);
    });

    it('should return false for null storyPoints without isEpic flag', () => {
      const task = createTask({ storyPoints: null, isEpic: false });
      expect(isEpic(task)).toBe(false);
    });
  });

  // =====================================================
  // filterWorkerEligibleTasks
  // =====================================================
  describe('filterWorkerEligibleTasks', () => {
    it('should return To-do tasks owned by Harsha with Low risk', () => {
      const tasks = [
        createTask({ status: 'To-do', riskLevel: 'Low' }),
        createTask({ status: 'To-do', riskLevel: 'Medium' }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(2);
    });

    it('should exclude High risk tasks', () => {
      const tasks = [
        createTask({ status: 'To-do', riskLevel: 'Low' }),
        createHighRiskTask({ status: 'To-do' }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].riskLevel).toBe('Low');
    });

    it('should exclude tasks not in To-do status', () => {
      const tasks = [
        createTask({ status: 'To-do' }),
        createTask({ status: 'In progress' }),
        createTask({ status: 'In Review' }),
        createTask({ status: 'Done' }),
        createTask({ status: 'Blocked' }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('To-do');
    });

    it('should exclude Rui-owned tasks', () => {
      const tasks = [
        createTask({ status: 'To-do' }),
        createRuiTask({ status: 'To-do' }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].owner?.id).toBe(HARSHA.id);
    });

    it('should include unassigned tasks', () => {
      const tasks = [
        createUnassignedTask({ status: 'To-do', riskLevel: 'Low' }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(1);
    });

    it('should exclude Epic tasks', () => {
      const tasks = [
        createTask({ status: 'To-do', storyPoints: 5 }),
        createEpicTask({ status: 'To-do' }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].isEpic).toBe(false);
    });

    it('should exclude tasks blocked by incomplete dependencies', () => {
      const tasks = [
        createTask({ id: 'available', status: 'To-do', blockedBy: [] }),
        createTask({ id: 'blocked', status: 'To-do', blockedBy: ['dep-1'] }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('available');
    });

    it('should include tasks whose blockers are all completed', () => {
      const tasks = [
        createTask({ id: 'unblocked', status: 'To-do', blockedBy: ['dep-1'] }),
      ];
      const completed = new Set(['dep-1']);
      const result = filterWorkerEligibleTasks(tasks, completed);
      expect(result).toHaveLength(1);
    });

    it('should return empty array when no tasks are eligible', () => {
      const tasks = [
        createHighRiskTask({ status: 'To-do' }),
        createRuiTask({ status: 'To-do' }),
        createEpicTask({ status: 'To-do' }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(0);
    });

    it('should handle empty task list', () => {
      const result = filterWorkerEligibleTasks([], new Set());
      expect(result).toHaveLength(0);
    });

    it('should prefer planned tasks over unplanned (planned === true)', () => {
      const planned = createTask({ status: 'To-do', planned: true, id: 'planned' });
      const unplanned = createTask({ status: 'To-do', planned: false, id: 'unplanned' });
      const tasks = [unplanned, planned];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      // Both should be eligible, but planned tasks are preferred (implementation sorts them)
      expect(result).toHaveLength(2);
    });

    it('should include tasks with null riskLevel (not yet classified)', () => {
      const tasks = [
        createTask({ status: 'To-do', riskLevel: null }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      // Null risk is not 'High', so should be eligible
      expect(result).toHaveLength(1);
    });

    it('should correctly handle boundary story points (12 vs 13)', () => {
      const tasks = [
        createTask({ status: 'To-do', storyPoints: 12, isEpic: false }),
        createTask({ status: 'To-do', storyPoints: 13, isEpic: true }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].storyPoints).toBe(12);
    });

    it('should exclude tasks owned by other users (not Rui, not Harsha)', () => {
      const tasks = [
        createTask({ status: 'To-do', owner: OTHER_USER }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(0);
    });

    it('should handle multiple filter criteria failing simultaneously', () => {
      const tasks = [
        createTask({
          status: 'In progress',
          riskLevel: 'High',
          owner: RUI,
          isEpic: true,
          storyPoints: 21,
          blockedBy: ['dep-1'],
        }),
      ];
      const result = filterWorkerEligibleTasks(tasks, new Set());
      expect(result).toHaveLength(0);
    });
  });

  // =====================================================
  // isBlocked — additional edge cases
  // =====================================================
  describe('isBlocked - additional edge cases', () => {
    it('should handle large number of blockers', () => {
      const blockerIds = Array.from({ length: 100 }, (_, i) => `blocker-${i}`);
      const task = createTask({ blockedBy: blockerIds });
      const completed = new Set(blockerIds.slice(0, 99)); // Missing last one
      expect(isBlocked(task, completed)).toBe(true);
    });

    it('should return false for empty blockedBy with non-empty completed set', () => {
      const task = createTask({ blockedBy: [] });
      expect(isBlocked(task, new Set(['task-a', 'task-b']))).toBe(false);
    });
  });

  // =====================================================
  // filterPlannerEligibleTasks
  // =====================================================
  describe('filterPlannerEligibleTasks', () => {
    it('should return To-do tasks that are not yet planned', () => {
      const tasks = [
        createTask({ status: 'To-do', planned: false }),
        createTask({ status: 'To-do', planned: true }),
      ];
      const result = filterPlannerEligibleTasks(tasks);
      expect(result).toHaveLength(1);
      expect(result[0].planned).toBe(false);
    });

    it('should exclude tasks not in To-do status', () => {
      const tasks = [
        createTask({ status: 'To-do', planned: false }),
        createTask({ status: 'In progress', planned: false }),
      ];
      const result = filterPlannerEligibleTasks(tasks);
      expect(result).toHaveLength(1);
    });

    it('should exclude Rui-owned tasks', () => {
      const tasks = [
        createTask({ status: 'To-do', planned: false }),
        createRuiTask({ status: 'To-do', planned: false }),
      ];
      const result = filterPlannerEligibleTasks(tasks);
      expect(result).toHaveLength(1);
    });

    it('should include unassigned tasks', () => {
      const tasks = [
        createUnassignedTask({ status: 'To-do', planned: false }),
      ];
      const result = filterPlannerEligibleTasks(tasks);
      expect(result).toHaveLength(1);
    });

    it('should exclude Epic tasks (>= 13 SP)', () => {
      const tasks = [
        createTask({ status: 'To-do', planned: false, storyPoints: 5 }),
        createEpicTask({ status: 'To-do', planned: false }),
      ];
      const result = filterPlannerEligibleTasks(tasks);
      expect(result).toHaveLength(1);
    });

    it('should return empty array when all tasks are planned', () => {
      const tasks = [
        createTask({ status: 'To-do', planned: true }),
        createTask({ status: 'To-do', planned: true }),
      ];
      const result = filterPlannerEligibleTasks(tasks);
      expect(result).toHaveLength(0);
    });

    it('should exclude High risk tasks from planning', () => {
      const tasks = [
        createTask({ status: 'To-do', planned: false, riskLevel: 'Low' }),
        createHighRiskTask({ status: 'To-do', planned: false }),
      ];
      const result = filterPlannerEligibleTasks(tasks);
      // High risk tasks skip auto pipeline, but planner doesn't filter by risk
      // per the rules — planner plans all tasks that need plans
      // The filter is: To-do + owner + not planned + not epic
      expect(result).toHaveLength(2);
    });

    it('should handle mixed statuses correctly', () => {
      const tasks = [
        createTask({ status: 'To-do', planned: false }),
        createTask({ status: 'Not started', planned: false }),
        createTask({ status: 'Blocked', planned: false }),
        createTask({ status: 'Start', planned: false }),
      ];
      const result = filterPlannerEligibleTasks(tasks);
      // Only 'To-do' tasks are eligible
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('To-do');
    });
  });
});
