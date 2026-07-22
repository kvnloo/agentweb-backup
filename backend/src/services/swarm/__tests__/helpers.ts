/**
 * Test Helpers — Swarm Pipeline Tests
 *
 * Factory functions and fixtures for creating test data.
 */

import {
  SprintTask,
  PullRequestState,
  PRComment,
  WorkerState,
  SwarmState,
  NotionUser,
  TaskStatus,
  RiskLevel,
  CommentSeverity,
  HARSHA_USER_ID,
  HARSHA_EMAIL,
  RUI_USER_ID,
  MAX_CONCURRENT_WORKERS,
} from '../types';

// --- User Fixtures ---

export const HARSHA: NotionUser = {
  id: HARSHA_USER_ID,
  email: HARSHA_EMAIL,
};

export const RUI: NotionUser = {
  id: RUI_USER_ID,
  email: 'rui@example.com',
};

export const OTHER_USER: NotionUser = {
  id: 'other-user-id-12345',
  email: 'other@example.com',
};

// --- Task Factory ---

let taskCounter = 0;

export function createTask(overrides: Partial<SprintTask> = {}): SprintTask {
  taskCounter++;
  return {
    id: `task-${taskCounter}`,
    title: `Test Task ${taskCounter}`,
    status: 'To-do',
    owner: HARSHA,
    riskLevel: 'Low',
    planned: false,
    storyPoints: 2,
    blockedBy: [],
    sprint: 'Current Sprint',
    repo: 'agentweb-customer-portal',
    isEpic: false,
    source: 'Human',
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

export function createHighRiskTask(overrides: Partial<SprintTask> = {}): SprintTask {
  return createTask({ riskLevel: 'High', ...overrides });
}

export function createEpicTask(overrides: Partial<SprintTask> = {}): SprintTask {
  return createTask({ storyPoints: 13, isEpic: true, ...overrides });
}

export function createBlockedTask(blockedByIds: string[], overrides: Partial<SprintTask> = {}): SprintTask {
  return createTask({ blockedBy: blockedByIds, status: 'Blocked', ...overrides });
}

export function createRuiTask(overrides: Partial<SprintTask> = {}): SprintTask {
  return createTask({ owner: RUI, ...overrides });
}

export function createUnassignedTask(overrides: Partial<SprintTask> = {}): SprintTask {
  return createTask({ owner: null, ...overrides });
}

// --- PR Factory ---

let prCounter = 0;

export function createPR(overrides: Partial<PullRequestState> = {}): PullRequestState {
  prCounter++;
  return {
    number: prCounter,
    title: `feat: Test PR ${prCounter}`,
    repo: 'agentweb-customer-portal',
    author: 'harshmoney123',
    baseBranch: 'harsha/dev',
    headBranch: `harsha/feature-${prCounter}`,
    ciGreen: true,
    seniorReviewerApproved: false,
    docsApproved: false,
    comments: [],
    isMegaPR: false,
    mergedAt: null,
    ...overrides,
  };
}

export function createMegaPR(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return createPR({
    baseBranch: 'main',
    headBranch: 'harsha/dev',
    isMegaPR: true,
    ...overrides,
  });
}

export function createApprovedPR(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return createPR({
    seniorReviewerApproved: true,
    docsApproved: true,
    ciGreen: true,
    ...overrides,
  });
}

// --- Comment Factory ---

let commentCounter = 0;

export function createComment(overrides: Partial<PRComment> = {}): PRComment {
  commentCounter++;
  return {
    id: `comment-${commentCounter}`,
    author: 'senior-reviewer',
    severity: null,
    body: `Test comment ${commentCounter}`,
    resolved: false,
    ...overrides,
  };
}

export function createBugComment(overrides: Partial<PRComment> = {}): PRComment {
  return createComment({ severity: '🔴 Bug', ...overrides });
}

export function createNitComment(overrides: Partial<PRComment> = {}): PRComment {
  return createComment({ severity: '🟡 Nit', ...overrides });
}

export function createInfoComment(overrides: Partial<PRComment> = {}): PRComment {
  return createComment({ severity: '💡 Suggestion', ...overrides });
}

// --- Worker / Swarm State Factory ---

export function createWorkerState(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    workerId: `worker-${Math.random().toString(36).slice(2, 8)}`,
    currentTaskId: null,
    status: 'idle',
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createSwarmState(overrides: Partial<SwarmState> = {}): SwarmState {
  return {
    workers: [],
    activeTasks: new Map(),
    idleTickCount: 0,
    lastTickAt: new Date().toISOString(),
    ...overrides,
  };
}

// --- Reset Counters ---

export function resetCounters(): void {
  taskCounter = 0;
  prCounter = 0;
  commentCounter = 0;
}
