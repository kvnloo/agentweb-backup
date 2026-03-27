/**
 * Integration Tests — Swarm Pipeline End-to-End Flow
 *
 * Tests the complete pipeline flow:
 * filterAutonomousTasks → sortByPriority → filterWorkerEligibleTasks →
 * claimTask → evaluateGates → releaseTask → isSwarmIdle → QA handoff
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

import { filterWorkerEligibleTasks, filterPlannerEligibleTasks } from '../taskFilter';
import { sortByPriority, applyTiebreaker } from '../prioritySorter';
import { evaluateGates, getActionableComments, needsDocsGate } from '../gateEvaluator';
import { filterAutonomousTasks, proposeSprintTasks, findDoneTasksToRemove } from '../sprintCurator';
import {
  createSwarmState,
  claimTask,
  releaseTask,
  getAvailableSlots,
  isSwarmIdle,
  shouldTriggerQAHandoff,
} from '../workerCoordinator';

import {
  createTask,
  createHighRiskTask,
  createEpicTask,
  createRuiTask,
  createUnassignedTask,
  createPR,
  createApprovedPR,
  createMegaPR,
  createBugComment,
  createNitComment,
  resetCounters,
  HARSHA,
  RUI,
} from './helpers';

describe('Pipeline Integration Tests', () => {
  beforeEach(() => {
    resetCounters();
  });

  // =====================================================
  // Full pipeline: backlog → sprint curation → worker claim
  // =====================================================
  describe('prep sprint → launch swarm flow', () => {
    it('should correctly filter backlog → propose → filter eligible → claim', () => {
      // Simulate a backlog of mixed tasks
      const backlog = [
        createTask({ id: 'good-1', status: 'To-do', riskLevel: 'Low', sprint: 'Backlog', storyPoints: 3 }),
        createTask({ id: 'good-2', status: 'To-do', riskLevel: 'Medium', sprint: 'Backlog', storyPoints: 5 }),
        createHighRiskTask({ id: 'risky', status: 'To-do', sprint: 'Backlog' }),
        createRuiTask({ id: 'rui', status: 'To-do', sprint: 'Backlog' }),
        createEpicTask({ id: 'epic', status: 'To-do', sprint: 'Backlog' }),
        createTask({ id: 'done', status: 'Done', sprint: 'Backlog' }),
        createTask({ id: 'in-sprint', status: 'To-do', sprint: 'Current Sprint' }),
      ];

      // Step 1: Filter autonomous tasks (prep sprint)
      const autonomous = filterAutonomousTasks(backlog);
      expect(autonomous.length).toBe(2);
      expect(autonomous.map(t => t.id)).toEqual(expect.arrayContaining(['good-1', 'good-2']));

      // Step 2: Propose sprint tasks
      const proposal = proposeSprintTasks(autonomous, []);
      expect(proposal.tasks.length).toBe(2);
      expect(proposal.rationale.size).toBe(2);

      // Step 3: After approval, tasks move to Current Sprint — filter for worker
      const sprintTasks = proposal.tasks.map(t => ({ ...t, sprint: 'Current Sprint' }));
      const eligible = filterWorkerEligibleTasks(sprintTasks, new Set());
      expect(eligible.length).toBe(2);

      // Step 4: Sort by priority
      const sorted = sortByPriority(eligible);
      expect(sorted.length).toBe(2);

      // Step 5: Create swarm and claim tasks
      const state = createSwarmState(2);
      const claim1 = claimTask(state, state.workers[0].workerId, sorted[0].id);
      expect(claim1.success).toBe(true);
      const claim2 = claimTask(state, state.workers[1].workerId, sorted[1].id);
      expect(claim2.success).toBe(true);

      // Step 6: No available slots left
      expect(getAvailableSlots(state, 0)).toBe(0);
      expect(isSwarmIdle(state, 0)).toBe(false);
    });
  });

  // =====================================================
  // Worker lifecycle: claim → work → PR → review → merge
  // =====================================================
  describe('worker task lifecycle', () => {
    it('should complete full task lifecycle: claim → PR → gates → release', () => {
      const task = createTask({ id: 'lifecycle-task', status: 'To-do', riskLevel: 'Low' });
      const state = createSwarmState(1);

      // Worker claims task
      const claim = claimTask(state, state.workers[0].workerId, task.id);
      expect(claim.success).toBe(true);
      expect(state.workers[0].status).toBe('working');

      // Worker creates PR — initially no approvals
      const pr = createPR({
        title: 'feat: implement lifecycle task',
        baseBranch: 'harsha/dev',
        seniorReviewerApproved: false,
        docsApproved: false,
        ciGreen: true,
      });

      // Gates should not pass yet
      let gates = evaluateGates(pr);
      expect(gates.canMerge).toBe(false);
      expect(gates.blockers.length).toBeGreaterThan(0);

      // Senior reviewer approves
      pr.seniorReviewerApproved = true;
      gates = evaluateGates(pr);
      expect(gates.canMerge).toBe(false); // Still needs docs

      // Docs agent approves
      pr.docsApproved = true;
      gates = evaluateGates(pr);
      expect(gates.canMerge).toBe(true);

      // Worker releases task after merge
      const newState = releaseTask(state, state.workers[0].workerId, task.id);
      expect(newState.workers[0].status).toBe('idle');
      expect(newState.activeTasks.size).toBe(0);
    });

    it('should block merge when reviewer finds a bug', () => {
      const pr = createApprovedPR({
        comments: [createBugComment({ resolved: false })],
      });

      const gates = evaluateGates(pr);
      expect(gates.canMerge).toBe(false);
      expect(gates.hasUnresolvedBugs).toBe(true);

      // Watchdog fixes the bug
      const actionable = getActionableComments(pr.comments);
      expect(actionable).toHaveLength(1);
      expect(actionable[0].severity).toBe('🔴 Bug');

      // Bug resolved
      pr.comments[0].resolved = true;
      const gatesAfterFix = evaluateGates(pr);
      expect(gatesAfterFix.canMerge).toBe(true);
    });
  });

  // =====================================================
  // Idle detection → QA handoff
  // =====================================================
  describe('sprint completion detection', () => {
    it('should detect sprint completion after all tasks done', () => {
      const state = createSwarmState(2);

      // Both workers claim and complete tasks
      claimTask(state, state.workers[0].workerId, 'task-1');
      claimTask(state, state.workers[1].workerId, 'task-2');
      releaseTask(state, state.workers[0].workerId, 'task-1');
      releaseTask(state, state.workers[1].workerId, 'task-2');

      // No more To-do tasks
      expect(isSwarmIdle(state, 0)).toBe(true);

      // First idle tick — not yet ready for QA
      state.idleTickCount = 1;
      expect(shouldTriggerQAHandoff(state, 0)).toBe(false);

      // Second idle tick — triggers QA handoff
      state.idleTickCount = 2;
      expect(shouldTriggerQAHandoff(state, 0)).toBe(true);
    });

    it('should NOT trigger QA handoff when new tasks appear', () => {
      const state = createSwarmState(1);
      state.idleTickCount = 5;

      // New To-do task appeared (someone added to sprint)
      expect(shouldTriggerQAHandoff(state, 1)).toBe(false);
    });
  });

  // =====================================================
  // Task planner → worker handoff
  // =====================================================
  describe('planner → worker handoff', () => {
    it('should plan unplanned tasks then workers pick up planned ones', () => {
      const sprintTasks = [
        createTask({ id: 'planned', status: 'To-do', planned: true, riskLevel: 'Low' }),
        createTask({ id: 'unplanned-1', status: 'To-do', planned: false, riskLevel: 'Medium' }),
        createTask({ id: 'unplanned-2', status: 'To-do', planned: false, riskLevel: 'Low' }),
      ];

      // Planner sees unplanned tasks
      const needsPlanning = filterPlannerEligibleTasks(sprintTasks);
      expect(needsPlanning).toHaveLength(2);
      expect(needsPlanning.map(t => t.id)).toEqual(
        expect.arrayContaining(['unplanned-1', 'unplanned-2'])
      );

      // Worker sees all eligible tasks (planned preference handled at claim time)
      const eligible = filterWorkerEligibleTasks(sprintTasks, new Set());
      expect(eligible).toHaveLength(3);
    });
  });

  // =====================================================
  // Concurrency limits
  // =====================================================
  describe('worker concurrency enforcement', () => {
    it('should enforce max 3 workers even with many tasks', () => {
      const state = createSwarmState(5); // More workers than allowed
      const tasks = Array.from({ length: 10 }, (_, i) =>
        createTask({ id: `task-${i}`, status: 'To-do' })
      );

      // Claim up to MAX_CONCURRENT_WORKERS
      for (let i = 0; i < 3; i++) {
        const result = claimTask(state, state.workers[i].workerId, tasks[i].id);
        expect(result.success).toBe(true);
      }

      // 4th claim should fail
      const result = claimTask(state, state.workers[3].workerId, tasks[3].id);
      expect(result.success).toBe(false);

      // Available slots should be 0
      expect(getAvailableSlots(state, 10)).toBe(0);
    });
  });

  // =====================================================
  // Mega PR never auto-merges
  // =====================================================
  describe('mega PR safety', () => {
    it('should never auto-merge mega PR even with all gates passing', () => {
      const megaPR = createMegaPR({
        seniorReviewerApproved: true,
        docsApproved: true,
        ciGreen: true,
        comments: [],
      });

      const gates = evaluateGates(megaPR);
      expect(gates.canMerge).toBe(false);
      expect(gates.seniorReviewerPassed).toBe(true);
      expect(gates.docsPassed).toBe(true);
      expect(gates.ciPassed).toBe(true);
      expect(gates.blockers).toContainEqual(expect.stringContaining('mega'));
    });
  });

  // =====================================================
  // Backend vs Frontend docs gate
  // =====================================================
  describe('docs gate by repo', () => {
    it('should auto-document backend PRs, require docs for frontend', () => {
      const backendPR = createPR({ repo: 'agentweb' });
      const frontendPR = createPR({ repo: 'agentweb-customer-portal' });

      expect(needsDocsGate(backendPR)).toBe(false);
      expect(needsDocsGate(frontendPR)).toBe(true);
    });
  });

  // =====================================================
  // Sprint clearing before curation
  // =====================================================
  describe('sprint hygiene', () => {
    it('should clear Done tasks before curating new sprint', () => {
      const currentSprint = [
        createTask({ id: 'done-1', status: 'Done', sprint: 'Current Sprint' }),
        createTask({ id: 'done-2', status: 'Done', sprint: 'Current Sprint' }),
        createTask({ id: 'active', status: 'In progress', sprint: 'Current Sprint' }),
        createTask({ id: 'todo', status: 'To-do', sprint: 'Current Sprint' }),
      ];

      const toRemove = findDoneTasksToRemove(currentSprint);
      expect(toRemove).toHaveLength(2);
      expect(toRemove.map(t => t.id)).toEqual(expect.arrayContaining(['done-1', 'done-2']));

      // After clearing Done tasks, remaining tasks
      const remaining = currentSprint.filter(t => !toRemove.includes(t));
      expect(remaining).toHaveLength(2);
    });
  });

  // =====================================================
  // High risk tasks always excluded from pipeline
  // =====================================================
  describe('high risk task exclusion', () => {
    it('should exclude high risk tasks at every stage of the pipeline', () => {
      const highRiskTask = createHighRiskTask({
        id: 'dangerous',
        status: 'To-do',
        sprint: 'Backlog',
      });

      // Excluded from autonomous filter
      expect(filterAutonomousTasks([highRiskTask])).toHaveLength(0);

      // Move to Current Sprint manually — still excluded from worker
      highRiskTask.sprint = 'Current Sprint';
      expect(filterWorkerEligibleTasks([highRiskTask], new Set())).toHaveLength(0);
    });
  });
});
