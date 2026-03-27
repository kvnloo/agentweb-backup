/**
 * Swarm Pipeline — Shared Types
 *
 * Type definitions for the swarm orchestration pipeline.
 * These types model Notion tasks, GitHub PRs, and pipeline state.
 */

// --- Notion Task Types ---

export type TaskStatus = 'To-do' | 'Not started' | 'Start_Test' | 'Start' | 'Blocked' | 'In progress' | 'In Review' | 'Done';

export type RiskLevel = 'Low' | 'Medium' | 'High';

export interface NotionUser {
  id: string;
  email: string;
}

export interface SprintTask {
  id: string;
  title: string;
  status: TaskStatus;
  owner: NotionUser | null;
  riskLevel: RiskLevel | null;
  planned: boolean;
  storyPoints: number | null;
  blockedBy: string[];  // IDs of blocking tasks
  sprint: string;       // "Current Sprint" | "Backlog" | etc.
  repo: 'agentweb' | 'agentweb-customer-portal' | null;
  isEpic: boolean;      // >= 13 SP
  source: string;       // "Human" by default
  lastUpdated: string;  // ISO date
}

// --- GitHub PR Types ---

export type ReviewVerdict = '✅ Approve' | '⚠️ Needs changes' | '❌ Rethink approach';

export type CommentSeverity = '🔴 Bug' | '🟡 Nit' | '🟣 Pre-existing' | '💡 Suggestion';

export interface PRComment {
  id: string;
  author: string;
  severity: CommentSeverity | null;
  body: string;
  resolved: boolean;
}

export interface PullRequestState {
  number: number;
  title: string;
  repo: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  ciGreen: boolean;
  seniorReviewerApproved: boolean;
  docsApproved: boolean;
  comments: PRComment[];
  isMegaPR: boolean;     // harsha/dev → main
  mergedAt: string | null;
}

// --- Pipeline State Types ---

export interface WorkerState {
  workerId: string;
  currentTaskId: string | null;
  status: 'idle' | 'working' | 'blocked';
  lastActivityAt: string;  // ISO date
}

export interface SwarmState {
  workers: WorkerState[];
  activeTasks: Map<string, string>;  // taskId → workerId
  idleTickCount: number;
  lastTickAt: string;
}

// --- Constants ---

export const HARSHA_USER_ID = '1c8d872b-594c-8168-8c1b-00022b54e40d';
export const HARSHA_EMAIL = 'harsha@agentweb.pro';
export const RUI_USER_ID = '1c8d872b-594c-816c-8935-00027d2a3a90';

export const MAX_CONCURRENT_WORKERS = 3;
export const EPIC_THRESHOLD_SP = 13;
export const LARGE_TASK_THRESHOLD_LINES = 500;

export const CURRENT_SPRINT_VIEW_ID = '32709247-c951-80fb-bd95-000c93354812';
export const MASTER_TABLE_VIEW_ID = '2bf09247-c951-81c2-bfc0-000cf28e3775';
