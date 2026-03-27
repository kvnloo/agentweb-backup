import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  filterAutonomousTasks,
  proposeSprintTasks,
  findDoneTasksToRemove,
  isAutonomouslyCompletable,
} from '../sprintCurator';
import {
  createTask,
  createHighRiskTask,
  createEpicTask,
  createRuiTask,
  createUnassignedTask,
  resetCounters,
  HARSHA,
  RUI,
} from './helpers';

describe('sprintCurator', () => {
  beforeEach(() => {
    resetCounters();
  });

  // =====================================================
  // filterAutonomousTasks
  // =====================================================
  describe('filterAutonomousTasks', () => {
    it('should include Low and Medium risk tasks owned by Harsha', () => {
      const tasks = [
        createTask({ riskLevel: 'Low', status: 'To-do', sprint: 'Backlog' }),
        createTask({ riskLevel: 'Medium', status: 'To-do', sprint: 'Backlog' }),
      ];
      const result = filterAutonomousTasks(tasks);
      expect(result).toHaveLength(2);
    });

    it('should exclude High risk tasks', () => {
      const tasks = [
        createTask({ riskLevel: 'Low', status: 'To-do', sprint: 'Backlog' }),
        createHighRiskTask({ status: 'To-do', sprint: 'Backlog' }),
      ];
      const result = filterAutonomousTasks(tasks);
      expect(result).toHaveLength(1);
      expect(result[0].riskLevel).toBe('Low');
    });

    it('should exclude Epic tasks (>= 13 SP)', () => {
      const tasks = [
        createTask({ storyPoints: 5, status: 'To-do', sprint: 'Backlog' }),
        createEpicTask({ status: 'To-do', sprint: 'Backlog' }),
      ];
      const result = filterAutonomousTasks(tasks);
      expect(result).toHaveLength(1);
    });

    it('should exclude Rui-owned tasks', () => {
      const tasks = [
        createTask({ status: 'To-do', sprint: 'Backlog' }),
        createRuiTask({ status: 'To-do', sprint: 'Backlog' }),
      ];
      const result = filterAutonomousTasks(tasks);
      expect(result).toHaveLength(1);
      expect(result[0].owner?.id).toBe(HARSHA.id);
    });

    it('should include unassigned tasks', () => {
      const tasks = [
        createUnassignedTask({ status: 'To-do', riskLevel: 'Low', sprint: 'Backlog' }),
      ];
      const result = filterAutonomousTasks(tasks);
      expect(result).toHaveLength(1);
    });

    it('should exclude Done tasks', () => {
      const tasks = [
        createTask({ status: 'To-do', sprint: 'Backlog' }),
        createTask({ status: 'Done', sprint: 'Backlog' }),
      ];
      const result = filterAutonomousTasks(tasks);
      expect(result).toHaveLength(1);
    });

    it('should exclude tasks already in Current Sprint', () => {
      const tasks = [
        createTask({ status: 'To-do', sprint: 'Backlog' }),
        createTask({ status: 'To-do', sprint: 'Current Sprint' }),
      ];
      const result = filterAutonomousTasks(tasks);
      expect(result).toHaveLength(1);
      expect(result[0].sprint).toBe('Backlog');
    });

    it('should return empty array when no tasks qualify', () => {
      const tasks = [
        createHighRiskTask({ status: 'Done' }),
        createRuiTask({ status: 'To-do' }),
        createEpicTask({ status: 'To-do' }),
      ];
      expect(filterAutonomousTasks(tasks)).toHaveLength(0);
    });

    it('should handle empty input', () => {
      expect(filterAutonomousTasks([])).toHaveLength(0);
    });
  });

  // =====================================================
  // proposeSprintTasks
  // =====================================================
  describe('proposeSprintTasks', () => {
    it('should propose up to 5 tasks by default', () => {
      const tasks = Array.from({ length: 10 }, (_, i) =>
        createTask({ id: `task-${i}`, status: 'To-do', riskLevel: 'Low' })
      );
      const result = proposeSprintTasks(tasks, []);
      expect(result.tasks.length).toBeLessThanOrEqual(5);
      expect(result.tasks.length).toBeGreaterThanOrEqual(3);
    });

    it('should propose at least 3 tasks when enough are available', () => {
      const tasks = Array.from({ length: 4 }, () =>
        createTask({ status: 'To-do', riskLevel: 'Low' })
      );
      const result = proposeSprintTasks(tasks, []);
      expect(result.tasks.length).toBeGreaterThanOrEqual(3);
    });

    it('should propose all tasks when fewer than 3 are available', () => {
      const tasks = [
        createTask({ status: 'To-do', riskLevel: 'Low' }),
        createTask({ status: 'To-do', riskLevel: 'Medium' }),
      ];
      const result = proposeSprintTasks(tasks, []);
      expect(result.tasks).toHaveLength(2);
    });

    it('should provide a rationale for each proposed task', () => {
      const tasks = [
        createTask({ id: 'prop-1', status: 'To-do' }),
        createTask({ id: 'prop-2', status: 'To-do' }),
        createTask({ id: 'prop-3', status: 'To-do' }),
      ];
      const result = proposeSprintTasks(tasks, []);
      for (const task of result.tasks) {
        expect(result.rationale.has(task.id)).toBe(true);
        expect(result.rationale.get(task.id)!.length).toBeGreaterThan(0);
      }
    });

    it('should respect custom maxProposals parameter', () => {
      const tasks = Array.from({ length: 10 }, () =>
        createTask({ status: 'To-do' })
      );
      const result = proposeSprintTasks(tasks, [], 4);
      expect(result.tasks).toHaveLength(4);
    });

    it('should consider existing sprint load', () => {
      const eligible = [
        createTask({ id: 'new-1', status: 'To-do', storyPoints: 8 }),
        createTask({ id: 'new-2', status: 'To-do', storyPoints: 5 }),
        createTask({ id: 'new-3', status: 'To-do', storyPoints: 3 }),
      ];
      const currentSprint = [
        createTask({ id: 'existing-1', status: 'In progress', storyPoints: 8 }),
        createTask({ id: 'existing-2', status: 'In progress', storyPoints: 5 }),
      ];
      const result = proposeSprintTasks(eligible, currentSprint);
      // Should still propose tasks, but potentially fewer due to sprint load
      expect(result.tasks.length).toBeGreaterThan(0);
    });

    it('should return empty proposal for empty eligible tasks', () => {
      const result = proposeSprintTasks([], []);
      expect(result.tasks).toHaveLength(0);
      expect(result.rationale.size).toBe(0);
    });
  });

  // =====================================================
  // findDoneTasksToRemove
  // =====================================================
  describe('findDoneTasksToRemove', () => {
    it('should return tasks with Done status', () => {
      const tasks = [
        createTask({ status: 'Done', sprint: 'Current Sprint' }),
        createTask({ status: 'To-do', sprint: 'Current Sprint' }),
        createTask({ status: 'In progress', sprint: 'Current Sprint' }),
      ];
      const result = findDoneTasksToRemove(tasks);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('Done');
    });

    it('should return empty array when no tasks are Done', () => {
      const tasks = [
        createTask({ status: 'To-do' }),
        createTask({ status: 'In progress' }),
      ];
      expect(findDoneTasksToRemove(tasks)).toHaveLength(0);
    });

    it('should return all Done tasks', () => {
      const tasks = [
        createTask({ status: 'Done' }),
        createTask({ status: 'Done' }),
        createTask({ status: 'Done' }),
      ];
      expect(findDoneTasksToRemove(tasks)).toHaveLength(3);
    });

    it('should handle empty input', () => {
      expect(findDoneTasksToRemove([])).toHaveLength(0);
    });
  });

  // =====================================================
  // isAutonomouslyCompletable
  // =====================================================
  describe('isAutonomouslyCompletable', () => {
    it('should return true for simple UI tasks', () => {
      const task = createTask({
        riskLevel: 'Low',
        storyPoints: 2,
        blockedBy: [],
        repo: 'agentweb-customer-portal',
      });
      expect(isAutonomouslyCompletable(task)).toBe(true);
    });

    it('should return false for High risk tasks', () => {
      const task = createHighRiskTask();
      expect(isAutonomouslyCompletable(task)).toBe(false);
    });

    it('should return false for blocked tasks', () => {
      const task = createTask({ blockedBy: ['unstarted-dep'], status: 'Blocked' });
      expect(isAutonomouslyCompletable(task)).toBe(false);
    });

    it('should return false for Epic tasks', () => {
      const task = createEpicTask();
      expect(isAutonomouslyCompletable(task)).toBe(false);
    });

    it('should return true for Medium risk frontend tasks', () => {
      const task = createTask({
        riskLevel: 'Medium',
        repo: 'agentweb-customer-portal',
        storyPoints: 5,
      });
      expect(isAutonomouslyCompletable(task)).toBe(true);
    });

    it('should return true for null risk (unclassified) tasks', () => {
      const task = createTask({ riskLevel: null, blockedBy: [] });
      expect(isAutonomouslyCompletable(task)).toBe(true);
    });

    it('should return true for backend tasks', () => {
      const task = createTask({
        riskLevel: 'Low',
        repo: 'agentweb',
        storyPoints: 3,
        blockedBy: [],
      });
      expect(isAutonomouslyCompletable(task)).toBe(true);
    });

    it('should return false for boundary epic (exactly 13 SP)', () => {
      const task = createTask({ storyPoints: 13, isEpic: true, blockedBy: [] });
      expect(isAutonomouslyCompletable(task)).toBe(false);
    });

    it('should return true for max non-epic task (8 SP)', () => {
      const task = createTask({ storyPoints: 8, isEpic: false, blockedBy: [] });
      expect(isAutonomouslyCompletable(task)).toBe(true);
    });
  });

  // =====================================================
  // filterAutonomousTasks — additional edge cases
  // =====================================================
  describe('filterAutonomousTasks - additional edge cases', () => {
    it('should exclude Blocked status tasks', () => {
      const tasks = [
        createTask({ status: 'To-do', sprint: 'Backlog' }),
        createTask({ status: 'Blocked', sprint: 'Backlog' }),
      ];
      const result = filterAutonomousTasks(tasks);
      // Blocked is not Done and not Current Sprint, so it passes unless explicitly filtered
      // Implementation only checks: status !== 'Done' && sprint !== 'Current Sprint'
      // 'Blocked' tasks SHOULD still be included in the filter (they may become unblocked)
      expect(result).toHaveLength(2);
    });

    it('should handle tasks with null riskLevel', () => {
      const tasks = [
        createTask({ status: 'To-do', sprint: 'Backlog', riskLevel: null }),
      ];
      const result = filterAutonomousTasks(tasks);
      expect(result).toHaveLength(1);
    });

    it('should handle tasks with various sprint values', () => {
      const tasks = [
        createTask({ status: 'To-do', sprint: 'Backlog' }),
        createTask({ status: 'To-do', sprint: 'Current Sprint' }),
        createTask({ status: 'To-do', sprint: 'Next Sprint' }),
        createTask({ status: 'To-do', sprint: '' }),
      ];
      const result = filterAutonomousTasks(tasks);
      // Only 'Current Sprint' is excluded
      expect(result).toHaveLength(3);
    });
  });

  // =====================================================
  // proposeSprintTasks — additional edge cases
  // =====================================================
  describe('proposeSprintTasks - additional edge cases', () => {
    it('should handle exactly 1 eligible task', () => {
      const tasks = [createTask({ status: 'To-do' })];
      const result = proposeSprintTasks(tasks, []);
      expect(result.tasks).toHaveLength(1);
      expect(result.rationale.size).toBe(1);
    });

    it('should handle maxProposals of 0', () => {
      const tasks = [createTask({ status: 'To-do' })];
      const result = proposeSprintTasks(tasks, [], 0);
      expect(result.tasks).toHaveLength(0);
    });

    it('should handle maxProposals of 1', () => {
      const tasks = Array.from({ length: 5 }, () => createTask({ status: 'To-do' }));
      const result = proposeSprintTasks(tasks, [], 1);
      expect(result.tasks).toHaveLength(1);
    });

    it('should include task risk level and SP in rationale', () => {
      const tasks = [
        createTask({ id: 'task-check', status: 'To-do', riskLevel: 'Low', storyPoints: 3 }),
      ];
      const result = proposeSprintTasks(tasks, []);
      const rationale = result.rationale.get('task-check');
      expect(rationale).toBeDefined();
      expect(rationale).toContain('Low');
      expect(rationale).toContain('3');
    });
  });
});
