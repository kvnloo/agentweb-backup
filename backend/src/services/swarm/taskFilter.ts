/**
 * Swarm Pipeline — Task Filter
 *
 * Filters sprint tasks based on ownership, risk level, status,
 * and blocking dependencies. Used by Sprint Worker and Task Planner.
 */

import {
  SprintTask,
  HARSHA_USER_ID,
  EPIC_THRESHOLD_SP,
} from './types';

/**
 * Filter tasks that are eligible for the Sprint Worker to pick up.
 * Rules:
 * - Status must be "To-do"
 * - Owner must be Harsha or unassigned (not Rui or anyone else)
 * - Risk must NOT be "High" (High risk tasks skip the auto pipeline)
 * - Must not be an Epic (>= 13 SP)
 * - Must not be blocked by incomplete tasks
 */
export function filterWorkerEligibleTasks(
  tasks: SprintTask[],
  completedTaskIds: Set<string>
): SprintTask[] {
  return tasks.filter(
    (task) =>
      task.status === 'To-do' &&
      isHarshaOrUnassigned(task) &&
      task.riskLevel !== 'High' &&
      !isEpic(task) &&
      !isBlocked(task, completedTaskIds)
  );
}

/**
 * Filter tasks that are eligible for the Task Planner.
 * Rules:
 * - Status must be "To-do"
 * - Owner must be Harsha or unassigned
 * - Must not already be planned (planned === true)
 * - Must not be an Epic (>= 13 SP)
 */
export function filterPlannerEligibleTasks(tasks: SprintTask[]): SprintTask[] {
  return tasks.filter(
    (task) =>
      task.status === 'To-do' &&
      isHarshaOrUnassigned(task) &&
      !task.planned &&
      !isEpic(task)
  );
}

/**
 * Check if a task is owned by Harsha or unassigned.
 */
export function isHarshaOrUnassigned(task: SprintTask): boolean {
  return task.owner === null || task.owner.id === HARSHA_USER_ID;
}

/**
 * Check if a task is blocked by incomplete dependencies.
 */
export function isBlocked(
  task: SprintTask,
  completedTaskIds: Set<string>
): boolean {
  return task.blockedBy.some((id) => !completedTaskIds.has(id));
}

/**
 * Check if a task is an Epic (story points >= threshold).
 */
export function isEpic(task: SprintTask): boolean {
  return task.isEpic || (task.storyPoints !== null && task.storyPoints >= EPIC_THRESHOLD_SP);
}
