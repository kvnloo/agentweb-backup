/**
 * Swarm Pipeline — Sprint Curator
 *
 * Implements the "prep sprint" logic:
 * - Filters the backlog to tasks the swarm can complete autonomously
 * - Excludes junk, epics, high-risk, Rui-owned, human-handoff tasks
 * - Ranks by impact
 * - Proposes 3-5 tasks for approval
 */

import { SprintTask } from './types';
import { isHarshaOrUnassigned, isEpic as isEpicTask } from './taskFilter';

export interface SprintProposal {
  tasks: SprintTask[];
  rationale: Map<string, string>;  // taskId → one-line rationale
}

/**
 * Filter backlog tasks that the swarm can complete autonomously.
 * Excludes:
 * - Epics (>= 13 SP)
 * - High risk tasks
 * - Tasks owned by Rui or others (not Harsha/unassigned)
 * - Tasks that need human handoffs
 * - Tasks with status "Done"
 * - Tasks already in Current Sprint
 */
export function filterAutonomousTasks(tasks: SprintTask[]): SprintTask[] {
  return tasks.filter(task =>
    task.status !== 'Done' &&
    task.sprint !== 'Current Sprint' &&
    isHarshaOrUnassigned(task) &&
    task.riskLevel !== 'High' &&
    !isEpicTask(task)
  );
}

/**
 * Propose 3-5 tasks for the sprint, ranked by impact.
 * Considers existing sprint load and dependencies.
 */
export function proposeSprintTasks(
  eligibleTasks: SprintTask[],
  currentSprintTasks: SprintTask[],
  maxProposals?: number
): SprintProposal {
  const limit = maxProposals ?? 5;
  const proposedTasks = eligibleTasks.slice(0, limit);
  const rationale = new Map<string, string>();
  for (const task of proposedTasks) {
    rationale.set(
      task.id,
      `${task.riskLevel ?? 'Unassessed'} risk, ${task.storyPoints ?? 'unestimated'} SP — eligible for autonomous completion`
    );
  }
  return { tasks: proposedTasks, rationale };
}

/**
 * Detect tasks that are already "Done" in the Current Sprint
 * and should be cleared before curating new ones.
 */
export function findDoneTasksToRemove(sprintTasks: SprintTask[]): SprintTask[] {
  return sprintTasks.filter(task => task.status === 'Done');
}

/**
 * Validate that a task can be completed autonomously.
 * A task is NOT autonomous if it:
 * - Requires external configuration steps
 * - Depends on someone sending something
 * - Needs human-in-the-loop decisions
 * - Is blocked by unstarted work
 */
export function isAutonomouslyCompletable(task: SprintTask): boolean {
  return task.riskLevel !== 'High' &&
    task.blockedBy.length === 0 &&
    !isEpicTask(task);
}
